import type {
  ContextEditEntryDraft,
  CustomEntryDraft,
  ExtensionAPI,
  ExtensionContext,
  ProjectedSessionEntry,
  SessionBeforeCompactEvent,
} from '@earendil-works/pi-coding-agent';

import { resolveHookConfig, type HookConfig } from '../hooks/fast-jev.js';
import { JevClient } from '../src/client.js';
import { compact, resolveOptions, truncatedResultText } from '../src/compact.js';
import { estimateTokens, goalFromMessages, headOf } from '../src/state.js';
import type { CompactResult, JevAsker, Message, ToolUse } from '../src/types.js';

/** `customType` of the session entry recording each run's stats and decisions. */
export const CUSTOM_TYPE = 'fast-jev-compaction';

/** After a run, wait until this share of the context window has accrued again. */
const RETRY_GROWTH = 0.1;

/** Jev through OpenRouter: same request and answers as System One. */
export const OPENROUTER_DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions';
export const OPENROUTER_JEV_MODEL = 'typesafe/jev-1.13';

// Pi's message and content types, from the one module an extension can rely on.
type AgentMessage = ProjectedSessionEntry['messages'][number];
type CompactionPreparation = SessionBeforeCompactEvent['preparation'];
/** What `toTranscript` reads of a projected entry. */
type ProjectedLike = { sourceEntry: { id: string }; messages: readonly AgentMessage[] };
type AssistantMessage = Extract<AgentMessage, { role: 'assistant' }>;
type ContentBlock =
  | AssistantMessage['content'][number]
  | Extract<AgentMessage, { role: 'toolResult' }>['content'][number];

const NUMBER_OPTIONS = [
  'keepThreshold',
  'preserveRecentMessages',
  'maxStateTokens',
  'maxRequestTokens',
  'truncateHeadChars',
  'compactAtPercent',
  'minReductionRatio',
] as const;

/** `keepThreshold` -> `FAST_JEV_KEEP_THRESHOLD`. */
export function envName(option: string): string {
  return `FAST_JEV_${option.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`;
}

/** Where Jev is asked: TypeSafe System One directly, or OpenRouter. */
export type Provider = 'typesafe' | 'openrouter';

export interface PiSettings {
  /** The Claude Code plugin's options; `resolveHookConfig` fills in the defaults. */
  options: Record<string, string | number>;
  provider: Provider;
  /** Endpoint override; unset uses the provider's own. */
  baseUrl?: string;
  /** Deadline for one Jev request, body included. */
  timeoutMs: number;
  /**
   * Largest share of Pi's compaction threshold (window minus reserve) the
   * context may still take after a Jev compaction; above it Pi summarizes.
   */
  compactTarget: number;
  /** Correct the built-in model windows Pi lists too small (`WINDOW_FIXES`). */
  fixWindows: boolean;
}

/**
 * Settings from the environment: the plugin options from `FAST_JEV_*`
 * variables, `FAST_JEV_PROVIDER` (`typesafe` or `openrouter`),
 * `FAST_JEV_BASE_URL`, `FAST_JEV_TIMEOUT_MS`, `FAST_JEV_COMPACT_TARGET` and
 * `FAST_JEV_FIX_WINDOWS`. The key is
 * `TYPESAFE_API_KEY`, or `OPENROUTER_API_KEY` for OpenRouter (which also
 * defaults the model to `typesafe/jev-1.13`).
 */
export function piSettings(env: Readonly<Record<string, string | undefined>>): PiSettings {
  const options: Record<string, string | number> = {};
  for (const option of NUMBER_OPTIONS) {
    const raw = env[envName(option)];
    if (raw !== undefined && raw.trim() !== '') options[option] = Number(raw);
  }
  for (const option of ['model', 'goal']) {
    const raw = env[envName(option)];
    if (raw) options[option] = raw;
  }
  const provider: Provider =
    env.FAST_JEV_PROVIDER?.trim().toLowerCase() === 'openrouter' ? 'openrouter' : 'typesafe';
  const apiKey = provider === 'openrouter' ? env.OPENROUTER_API_KEY : env.TYPESAFE_API_KEY;
  if (apiKey) options.apiKey = apiKey;
  if (provider === 'openrouter' && options.model === undefined) options.model = OPENROUTER_JEV_MODEL;
  const timeout = Number(env.FAST_JEV_TIMEOUT_MS);
  const target = Number(env.FAST_JEV_COMPACT_TARGET);
  const settings: PiSettings = {
    options,
    provider,
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 15_000,
    compactTarget: Number.isFinite(target) && target > 0 && target <= 1 ? target : 0.5,
    fixWindows: !/^(0|false|off|no)$/i.test(env.FAST_JEV_FIX_WINDOWS?.trim() ?? ''),
  };
  const baseUrl = env.FAST_JEV_BASE_URL?.trim();
  if (baseUrl) settings.baseUrl = baseUrl;
  else if (provider === 'openrouter') settings.baseUrl = OPENROUTER_DECISIONS_URL;
  return settings;
}

function contentText(content: string | readonly ContentBlock[]): string {
  if (typeof content === 'string') return content;
  return content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .filter(Boolean)
    .join('\n');
}

function messageText(message: Exclude<AgentMessage, { role: 'assistant' | 'toolResult' | 'system' }>): string {
  switch (message.role) {
    case 'user':
    case 'custom':
      return contentText(message.content);
    case 'bashExecution':
      return `$ ${message.command}\n${message.output}`;
    case 'branchSummary':
    case 'compactionSummary':
      return message.summary;
    default:
      // Other extensions may add message roles of their own.
      return '';
  }
}

/** The projected session as the library's transcript, with the entry behind each tool call. */
export interface PiTranscript {
  messages: Message[];
  /** Entry holding each tool call, by tool call id. */
  callEntries: Map<string, string>;
  /** Entry and outcome of each tool result, by tool call id. */
  results: Map<string, { entryId: string; text: string; isError: boolean }>;
  /** The projected assistant message of each entry holding tool calls. */
  assistants: Map<string, AssistantMessage>;
  /** The last user prompts, without summaries, bash runs or other extensions' messages. */
  goal: string;
}

/**
 * Maps Pi's projected context onto library messages. A run of tool results
 * becomes one user message, as in a Claude Code transcript, so
 * `preserveRecentMessages` counts the same; system messages are left out.
 */
export function toTranscript(entries: readonly ProjectedLike[]): PiTranscript {
  const transcript: PiTranscript = {
    messages: [],
    callEntries: new Map(),
    results: new Map(),
    assistants: new Map(),
    goal: '',
  };
  const prompts: Message[] = [];
  let resultRun: Message | undefined;
  for (const { sourceEntry, messages } of entries) {
    for (const message of messages) {
      if (message.role === 'system') continue;
      if (message.role === 'toolResult') {
        if (!resultRun) {
          resultRun = { role: 'user', text: '', toolUses: [], toolResults: [] };
          transcript.messages.push(resultRun);
        }
        const text = contentText(message.content);
        resultRun.toolResults!.push({ tool_use_id: message.toolCallId, text, isError: message.isError });
        transcript.results.set(message.toolCallId, {
          entryId: sourceEntry.id,
          text,
          isError: message.isError,
        });
        continue;
      }
      resultRun = undefined;
      if (message.role !== 'assistant') {
        const text: Message = { role: 'user', text: messageText(message), toolUses: [] };
        transcript.messages.push(text);
        if (message.role === 'user') prompts.push(text);
        continue;
      }
      const toolUses: ToolUse[] = [];
      for (const block of message.content) {
        if (block.type !== 'toolCall') continue;
        toolUses.push({ tool_use_id: block.id, tool: block.name, input: block.arguments });
        transcript.callEntries.set(block.id, sourceEntry.id);
      }
      if (toolUses.length > 0) transcript.assistants.set(sourceEntry.id, message);
      transcript.messages.push({ role: 'assistant', text: contentText(message.content), toolUses });
    }
  }
  transcript.goal = goalFromMessages(prompts);
  return transcript;
}

/**
 * Cuts every long string in a stubbed call's input to its head and a note.
 * Strings up to `headChars + 60` stay, so an abridged input is left as it is
 * when compaction runs again.
 */
export function abridgeInput(value: unknown, headChars: number): unknown {
  if (typeof value === 'string') {
    if (value.length <= headChars + 60) return value;
    const head = headOf(value, headChars);
    return `${head}…[fast-jev-compaction truncated ${value.length - head.length} chars]`;
  }
  if (Array.isArray(value)) return value.map((item) => abridgeInput(item, headChars));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, abridgeInput(item, headChars)]),
    );
  }
  return value;
}

export type PiEdits = {
  edits: ContextEditEntryDraft[];
  /** Characters of tool input and tool output the edits take out. */
  charsSaved: number;
};

/**
 * Turns the library's compacted transcript into Pi context edits. A dropped
 * result keeps the head and note the library gave it. A dropped call is not
 * deleted but stubbed: it stays in its assistant entry with long input
 * strings abridged, and its result is replaced by the library's note alone,
 * which marks the gap. The history keeps a call behind every report, and the
 * marker sits in a tool result, never in the assistant's own words, which a
 * model has been seen to imitate (upstream #65).
 */
export function contextEdits(
  transcript: PiTranscript,
  compacted: readonly Message[],
  headChars: number,
): PiEdits {
  const keptCalls = new Set<string>();
  const keptResults = new Map<string, string>();
  for (const message of compacted) {
    for (const tool of message.toolUses) keptCalls.add(tool.tool_use_id);
    for (const result of message.toolResults ?? []) keptResults.set(result.tool_use_id, result.text);
  }
  const dropped = (id: string) => transcript.callEntries.has(id) && !keptCalls.has(id);

  const edits: ContextEditEntryDraft[] = [];
  let charsSaved = 0;
  for (const [entryId, message] of transcript.assistants) {
    let changed = false;
    const content = message.content.map((block) => {
      if (block.type !== 'toolCall' || !dropped(block.id)) return block;
      const args = abridgeInput(block.arguments, headChars) as typeof block.arguments;
      const saved = JSON.stringify(block.arguments).length - JSON.stringify(args).length;
      if (saved <= 0) return block;
      changed = true;
      charsSaved += saved;
      return { ...block, arguments: args };
    });
    if (changed) edits.push({ type: 'context_edit', targetId: entryId, replacement: { content } });
  }
  for (const [id, { entryId, text, isError }] of transcript.results) {
    const next = dropped(id) ? truncatedResultText(text, isError, 0) : keptResults.get(id);
    if (next === undefined || next === text) continue;
    charsSaved += text.length - next.length;
    edits.push({
      type: 'context_edit',
      targetId: entryId,
      replacement: { content: [{ type: 'text', text: next }] },
    });
  }
  return { edits, charsSaved };
}

export type PiCompaction = PiEdits & {
  result: CompactResult;
  /** Share of the transcript's characters the edits take out. */
  ratio: number;
};

/** Runs the library over Pi's projected context; throws when Jev fails. */
export async function compactEntries(
  entries: readonly ProjectedSessionEntry[],
  config: HookConfig,
  asker: JevAsker,
): Promise<PiCompaction> {
  const transcript = toTranscript(entries);
  // Pi's summaries, bash runs and other extensions' messages are user-role
  // text too; the default goal would take them for the task.
  const goal = config.goal || transcript.goal;
  const result = await compact(transcript.messages, asker, { ...config, goal });
  const { edits, charsSaved } = contextEdits(
    transcript,
    result.messages,
    resolveOptions(config).truncateHeadChars,
  );
  const { charsBefore } = result.stats;
  return { result, edits, charsSaved, ratio: charsBefore === 0 ? 0 : charsSaved / charsBefore };
}

/**
 * A Pi message as a verbatim compaction summary shows it, in the
 * `[Role]: text` shape of Pi's own summarizer input. Thinking and system
 * messages are left out; tool inputs are written as JSON.
 */
export function serializeMessage(message: AgentMessage): string | undefined {
  const blocks = (content: string | readonly ContentBlock[]) =>
    typeof content === 'string'
      ? content
      : content
          .map((block) => (block.type === 'text' ? block.text : block.type === 'image' ? '[image]' : ''))
          .filter(Boolean)
          .join('\n');
  switch (message.role) {
    case 'user':
      return `[User]: ${blocks(message.content)}`;
    case 'assistant': {
      const lines = message.content.flatMap((block) =>
        block.type === 'text' && block.text.trim() !== ''
          ? [`[Assistant]: ${block.text}`]
          : block.type === 'toolCall'
            ? [`[Assistant tool call]: ${block.name}(${JSON.stringify(block.arguments)})`]
            : [],
      );
      return lines.length > 0 ? lines.join('\n') : undefined;
    }
    case 'toolResult':
      return `[Tool result ${message.toolName}${message.isError ? ' (error)' : ''}]: ${blocks(message.content)}`;
    case 'bashExecution':
      return `[User bash]: $ ${message.command}\n${message.output}`;
    case 'custom':
      return `[${message.customType}]: ${blocks(message.content)}`;
    case 'branchSummary':
    case 'compactionSummary':
      return `[Summary]: ${message.summary}`;
    default:
      return undefined;
  }
}

const SUMMARY_HEADER =
  'fast-jev-compaction kept the earlier conversation below verbatim instead of summarizing it. ' +
  'Tool outputs Jev judged no longer needed are cut to a note; re-run the tool if one of them is needed.';

export interface RegionCompaction {
  result: CompactResult;
  summary: string;
  /** The region as cut, without thinking or image data: what the next compaction carries. */
  messages: AgentMessage[];
  readFiles: string[];
  modifiedFiles: string[];
  /** Characters of the region's transcript before and after the cuts. */
  charsBefore: number;
  charsAfter: number;
  /** Share of the region's characters the cuts take out. */
  ratio: number;
  /** Estimated share of the whole context, kept window included, left after the compaction. */
  remaining: number;
}

/** What a Jev compaction keeps in its entry's `details.fastJev`, for the next one to carry. */
export interface FastJevDetails {
  messages: AgentMessage[];
  readFiles: string[];
  modifiedFiles: string[];
  /** The summary, written by Pi, this one was written behind. */
  previousSummary?: string;
}

type BranchEntry = SessionBeforeCompactEvent['branchEntries'][number];

/**
 * The previous compaction's messages, when it was Jev's and is the one Pi is
 * building on: the next compaction scores them again instead of copying its
 * text forward, so a result kept then can still be cut later.
 */
export function carriedCompaction(
  entries: readonly BranchEntry[],
  previousSummary: string | undefined,
): FastJevDetails | undefined {
  let latest: BranchEntry | undefined;
  for (const entry of entries) if (entry.type === 'compaction') latest = entry;
  if (!latest || latest.type !== 'compaction' || latest.summary !== previousSummary) return undefined;
  const fastJev = (latest.details as { fastJev?: Partial<FastJevDetails> } | undefined)?.fastJev;
  return fastJev && Array.isArray(fastJev.messages) ? (fastJev as FastJevDetails) : undefined;
}

/** A message as a later compaction carries it: thinking dropped, images as a marker. */
function forCarrying(message: AgentMessage): AgentMessage {
  if (message.role === 'assistant') {
    return { ...message, content: message.content.filter((block) => block.type !== 'thinking') };
  }
  if ((message.role === 'user' || message.role === 'toolResult' || message.role === 'custom') && Array.isArray(message.content)) {
    const content = message.content.map((block) => (block.type === 'image' ? { type: 'text' as const, text: '[image]' } : block));
    return { ...message, content } as AgentMessage;
  }
  return message;
}

/**
 * Compaction without an LLM summary. Jev scores the region Pi would
 * summarize, with the kept messages after it as pinned context; the region is
 * then written out verbatim, its dropped tool outputs cut exactly as
 * `contextEdits` cuts them in place, behind the previous summary and followed
 * by the files it read and changed, the way Pi's own summary lists them.
 */
export async function compactRegion(
  region: readonly AgentMessage[],
  kept: readonly ProjectedSessionEntry[],
  config: HookConfig,
  asker: JevAsker,
  extras: {
    previousSummary?: string;
    customInstructions?: string;
    files?: { read: Iterable<string>; modified: Iterable<string> };
  },
): Promise<RegionCompaction> {
  const regionEntries: ProjectedLike[] = region.map((message, index) => ({
    sourceEntry: { id: `region-${index}` },
    messages: [message],
  }));
  const transcript = toTranscript([...regionEntries, ...kept]);
  const options = resolveOptions(config);
  // Pi's kept window is the recent history here; the default pin of the 6
  // newest messages would reach past it into the region. An explicit
  // preserveRecentMessages still applies.
  const keptMessages = toTranscript(kept).messages.length;
  const preserveRecentMessages =
    keptMessages > 0
      ? Math.max(keptMessages, config.preserveRecentMessages ?? 0)
      : options.preserveRecentMessages;
  // `/compact <instructions>` says what matters now; it leads the goal.
  const goal = config.goal || [extras.customInstructions, transcript.goal].filter(Boolean).join('\n');
  const result = await compact(transcript.messages, asker, { ...config, goal, preserveRecentMessages });

  const { edits } = contextEdits(transcript, result.messages, options.truncateHeadChars);
  const replacements = new Map(edits.map((edit) => [edit.targetId, edit.replacement]));
  const edited = region.flatMap((message, index) => {
    const replacement = replacements.get(`region-${index}`);
    if (replacement === undefined) return [message];
    return replacement === null ? [] : [{ ...message, content: replacement.content } as AgentMessage];
  });
  const write = (messages: readonly AgentMessage[]) =>
    messages.flatMap((message) => serializeMessage(message) ?? []).join('\n\n');
  const before = write(region);
  const after = write(edited);

  const modified = [...new Set(extras.files?.modified ?? [])].sort();
  const read = [...new Set(extras.files?.read ?? [])].filter((file) => !modified.includes(file)).sort();
  const sections = [SUMMARY_HEADER];
  if (extras.previousSummary) sections.push(`<previous-summary>\n${extras.previousSummary}\n</previous-summary>`);
  sections.push(`<conversation>\n${after}\n</conversation>`);
  if (read.length > 0) sections.push(`<read-files>\n${read.join('\n')}\n</read-files>`);
  if (modified.length > 0) sections.push(`<modified-files>\n${modified.join('\n')}\n</modified-files>`);
  const summary = sections.join('\n\n');
  const keptTokens = estimateTokens(write(kept.flatMap((entry) => entry.messages)));
  return {
    result,
    summary,
    messages: edited.map(forCarrying),
    readFiles: read,
    modifiedFiles: modified,
    charsBefore: before.length,
    charsAfter: after.length,
    ratio: before.length === 0 ? 0 : 1 - after.length / before.length,
    remaining: (estimateTokens(summary) + keptTokens) / Math.max(1, estimateTokens(before) + keptTokens),
  };
}

function percent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

function thousands(tokens: number): string {
  return tokens < 1000 ? `${Math.round(tokens)}` : `~${Math.round(tokens / 1000)}k`;
}

function tokenCount(tokens: number): string {
  return `${thousands(tokens)} tokens`;
}

/** One line on a run, for the TUI notification. */
export function describeRun({ result, ratio }: Pick<PiCompaction, 'result' | 'ratio'>): string {
  const { stats } = result;
  const parts = [
    stats.kept > 0 ? `${stats.kept} kept` : '',
    stats.resultsDropped > 0 ? `${stats.resultsDropped} results truncated` : '',
    stats.callsDropped > 0 ? `${stats.callsDropped} calls stubbed` : '',
    stats.pinned > 0 ? `${stats.pinned} pinned` : '',
  ].filter(Boolean);
  return `${percent(ratio)} reduction; ${parts.join(', ') || 'no tool calls'}; ${stats.requests} Jev request(s) in ${stats.ms} ms`;
}

/** A built-in model Pi lists with a smaller context window than its provider serves. */
export interface WindowFix {
  provider: string;
  model: RegExp;
  /** The window Pi lists. */
  listed: number;
  /** The window the provider serves. */
  served: number;
}

/**
 * Pi lists openai-codex's gpt-5.6 and gpt-6 models at 272k, while the ChatGPT
 * backend serves them with 1M: measured on 2026-10-03, gpt-6-astra took a
 * 461k-token prompt and gpt-5.6-luna a 594k one (gpt-5.6-sol and -terra 309k),
 * all read end to end. gpt-5.5 is not listed: it rejected 309k as over its
 * window, so Pi's 272k is right for it. A fix applies only while Pi still lists
 * the model at `listed`, so a models.json override or a corrected Pi catalog wins.
 */
export const WINDOW_FIXES: readonly WindowFix[] = [
  { provider: 'openai-codex', model: /^gpt-5\.6-/, listed: 272_000, served: 1_000_000 },
  { provider: 'openai-codex', model: /^gpt-6(\.\d+)?-/, listed: 272_000, served: 1_000_000 },
];

/** The provider's models with the windows the fixes correct, or undefined when none needs it. */
export function correctedModels<M extends { id: string; contextWindow?: number }>(
  provider: string,
  models: readonly M[],
  fixes: readonly WindowFix[] = WINDOW_FIXES,
): M[] | undefined {
  let changed = false;
  const corrected = models.map((model) => {
    const fix = fixes.find(
      (candidate) =>
        candidate.provider === provider && candidate.model.test(model.id) && model.contextWindow === candidate.listed,
    );
    if (!fix) return model;
    changed = true;
    return { ...model, contextWindow: fix.served };
  });
  return changed ? corrected : undefined;
}

function windowLabel(tokens: number): string {
  return tokens % 1_000_000 === 0 ? `${tokens / 1_000_000}M` : `${Math.round(tokens / 1000)}k`;
}

/** What one run asks Jev through. */
export interface JevEndpoint {
  apiKey: string;
  model: string;
  baseUrl?: string;
  timeoutMs: number;
  /** The turn's signal: interrupting Pi stops the Jev requests too. */
  signal?: AbortSignal;
}

/**
 * A `JevClient` whose every request (body included) ends at the deadline or
 * when the turn is aborted. Pi awaits `turn_end`, so a Jev request that never
 * answered would otherwise hold the whole agent.
 */
export function timedAsker({ apiKey, model, baseUrl, timeoutMs, signal }: JevEndpoint): JevAsker {
  const timed: typeof fetch = (input, init) =>
    fetch(input, {
      ...init,
      signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]),
    });
  return new JevClient({ apiKey, model, baseUrl, fetch: timed });
}

/**
 * The Pi extension, on two paths.
 *
 * At the end of a turn whose context is at or above `compactAtPercent`, Jev
 * decides which older tool calls and results still matter, and the rest
 * shrink in the model context through append-only `context_edit` entries
 * (see `contextEdits`): no summary at all. A run is retried only after the
 * context grows by another 10% of the window, or after it drops below the
 * threshold.
 *
 * When Pi compacts anyway (`/compact`, its threshold, or overflow recovery),
 * Jev scores what Pi would summarize and the extension hands back that history
 * verbatim, stale tool outputs cut, instead of an LLM summary (see
 * `compactRegion`).
 *
 * Below `minReductionRatio`, over the summary budget, without a key, or when
 * Jev fails or times out, nothing changes and Pi's own summary stays the
 * fallback.
 */
export function createFastJev(
  env: Readonly<Record<string, string | undefined>> = process.env,
  askerFor: (endpoint: JevEndpoint) => JevAsker = timedAsker,
) {
  return (pi: ExtensionAPI): void => {
    const settings = piSettings(env);
    const config = resolveHookConfig(settings.options);
    let lastAttemptTokens: number | undefined;

    const notifier =
      (ctx: ExtensionContext) =>
      (text: string, type: 'info' | 'warning' = 'info') => {
        if (ctx.hasUI) ctx.ui.notify(`fast-jev: ${text}`, type);
      };
    /** The endpoint for one run, or why there is none. */
    const endpointFor = async (
      ctx: ExtensionContext,
      signal: AbortSignal | undefined,
    ): Promise<JevEndpoint | string> => {
      // Without OPENROUTER_API_KEY, OpenRouter falls back to Pi's own login.
      const apiKey =
        config.apiKey ??
        (settings.provider === 'openrouter'
          ? await ctx.modelRegistry.getApiKeyForProvider('openrouter')
          : undefined);
      if (!apiKey) {
        return settings.provider === 'openrouter'
          ? "no OpenRouter key (OPENROUTER_API_KEY or Pi's OpenRouter login)"
          : 'TYPESAFE_API_KEY is not set';
      }
      const endpoint: JevEndpoint = { apiKey, model: config.model, timeoutMs: settings.timeoutMs };
      if (settings.baseUrl) endpoint.baseUrl = settings.baseUrl;
      if (signal) endpoint.signal = signal;
      return endpoint;
    };
    const failure = (error: unknown) =>
      error instanceof Error && error.name === 'TimeoutError'
        ? `no Jev answer within ${settings.timeoutMs / 1000} s`
        : error instanceof Error
          ? error.message
          : String(error);

    // Pi sizes its own compaction, and this extension its decisions, by the
    // model's window; correct the ones Pi lists too small before anything runs.
    pi.on('session_start', (_event, ctx) => {
      if (!settings.fixWindows) return;
      for (const provider of new Set(WINDOW_FIXES.map((fix) => fix.provider))) {
        const models = ctx.modelRegistry.getProvider(provider)?.getAllModels?.();
        if (!models) continue;
        const corrected = correctedModels(provider, models);
        if (!corrected) continue;
        // The full list: a registration replaces the provider's models, while
        // Pi keeps the built-in provider's login and streaming.
        pi.registerProvider(provider, { models: corrected });
        const fixed = corrected.filter((model, index) => model !== models[index]).map((model) => model.id);
        const fix = WINDOW_FIXES.find((candidate) => candidate.provider === provider && candidate.model.test(fixed[0]!))!;
        notifier(ctx)(
          `Pi lists ${provider} ${fixed.join(', ')} at ${windowLabel(fix.listed)}; using the ` +
            `${windowLabel(fix.served)} window they are served with (FAST_JEV_FIX_WINDOWS=0 turns this off)`,
        );
      }
    });

    pi.on('turn_end', async (event, ctx) => {
      const usage = ctx.getContextUsage();
      if (!usage || usage.tokens === null || usage.percent === null) return;
      if (usage.percent < config.compactAtPercent) {
        lastAttemptTokens = undefined;
        return;
      }
      if (
        lastAttemptTokens !== undefined &&
        usage.tokens < lastAttemptTokens + usage.contextWindow * RETRY_GROWTH
      ) {
        return;
      }
      lastAttemptTokens = usage.tokens;

      const notify = notifier(ctx);
      try {
        const endpoint = await endpointFor(ctx, ctx.signal);
        if (typeof endpoint === 'string') {
          notify(`${endpoint}; Pi's built-in compaction stays in charge`, 'warning');
          return;
        }
        const run = await compactEntries(event.context.contextEntries, config, askerFor(endpoint));
        const { stats, decisions } = run.result;
        // Stubs keep every message; only characters leave the context.
        const charsAfter = stats.charsBefore - run.charsSaved;
        const record: CustomEntryDraft = {
          type: 'custom',
          customType: CUSTOM_TYPE,
          data: { stats: { ...stats, messagesAfter: stats.messagesBefore, charsAfter }, decisions },
        };
        const { edits } = run;
        if (edits.length === 0 || run.ratio < config.minReductionRatio) {
          notify(`below the ${percent(config.minReductionRatio)} minimum, no edits (${describeRun(run)})`);
          return { entries: [...event.entries, record] };
        }
        notify(`${edits.length} context edits, no summary (${describeRun(run)})`);
        return { entries: [...event.entries, ...edits, record] };
      } catch (error) {
        notify(`skipped (${failure(error)}); Pi's compaction stays the fallback`, 'warning');
        return;
      }
    });

    pi.on('session_before_compact', async (event, ctx) => {
      const notify = notifier(ctx);
      const what =
        event.reason === 'manual' ? '/compact' : event.reason === 'overflow' ? 'overflow compaction' : 'compaction';
      try {
        const endpoint = await endpointFor(ctx, event.signal);
        if (typeof endpoint === 'string') {
          notify(`${what}: ${endpoint}; Pi summarizes instead`, 'warning');
          return;
        }
        const { preparation } = event;
        const projection = ctx.sessionManager.buildSessionProjection().entries;
        const first = projection.findIndex((entry) => entry.sourceEntry.id === preparation.firstKeptEntryId);
        const carried = carriedCompaction(event.branchEntries, preparation.previousSummary);
        const previousSummary = carried ? carried.previousSummary : preparation.previousSummary;
        const { fileOps } = preparation;
        const run = await compactRegion(
          [...(carried?.messages ?? []), ...preparation.messagesToSummarize, ...preparation.turnPrefixMessages],
          first === -1 ? [] : projection.slice(first),
          config,
          askerFor(endpoint),
          {
            ...(previousSummary ? { previousSummary } : {}),
            ...(event.customInstructions ? { customInstructions: event.customInstructions } : {}),
            files: {
              read: [...(carried?.readFiles ?? []), ...fileOps.read],
              modified: [...(carried?.modifiedFiles ?? []), ...fileOps.written, ...fileOps.edited],
            },
          },
        );
        if (run.charsAfter >= run.charsBefore) {
          notify(`${what}: Jev found nothing stale to cut; Pi summarizes instead`);
          return;
        }
        // Pi's own threshold, not the window share: Pi's window can be wrong
        // (openai-codex reports 272k and accepts more), and all that matters
        // is that the compacted context leaves room before Pi compacts again.
        const after = Math.round(preparation.tokensBefore * run.remaining);
        const window = ctx.model?.contextWindow ?? ctx.getContextUsage()?.contextWindow;
        const threshold = window ? window - preparation.settings.reserveTokens : 0;
        if (threshold > 0 && after > threshold * settings.compactTarget) {
          // A context larger than the window means the provider serves more
          // than Pi assumes; the threshold is then too low, not Jev's cuts.
          const hint =
            window && preparation.tokensBefore > window
              ? `. The context (${tokenCount(preparation.tokensBefore)}) is already past Pi's ` +
                `${thousands(window)} window for this model, so that window looks too small; ` +
                `see "When Pi's context window is wrong" in the README`
              : '';
          notify(
            `${what}: Jev's cuts would leave ${tokenCount(after)}, over ${percent(settings.compactTarget)} of ` +
              `Pi's ${thousands(threshold)} compaction threshold; Pi summarizes instead${hint}`,
          );
          return;
        }
        notify(
          `${what} by Jev, no LLM summary (older history: ${describeRun(run)}; ` +
            `context ${thousands(preparation.tokensBefore)} → ${tokenCount(after)})`,
        );
        const details: FastJevDetails & Record<string, unknown> = {
          stats: run.result.stats,
          decisions: run.result.decisions,
          ratio: run.ratio,
          messages: run.messages,
          readFiles: run.readFiles,
          modifiedFiles: run.modifiedFiles,
        };
        if (previousSummary) details.previousSummary = previousSummary;
        return {
          compaction: {
            summary: run.summary,
            firstKeptEntryId: preparation.firstKeptEntryId,
            tokensBefore: preparation.tokensBefore,
            details: { fastJev: details },
          },
        };
      } catch (error) {
        notify(`${what}: Pi summarizes instead (${failure(error)})`, 'warning');
        return;
      }
    });
  };
}

export default createFastJev();
