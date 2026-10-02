import type {
  ContextEditEntryDraft,
  CustomEntryDraft,
  ExtensionAPI,
  ProjectedSessionEntry,
} from '@earendil-works/pi-coding-agent';

import { resolveHookConfig, type HookConfig } from '../hooks/fast-jev.js';
import { JevClient } from '../src/client.js';
import { compact, resolveOptions, truncatedResultText } from '../src/compact.js';
import { headOf } from '../src/state.js';
import type { CompactResult, JevAsker, Message, ToolUse } from '../src/types.js';

/** `customType` of the session entry recording each run's stats and decisions. */
export const CUSTOM_TYPE = 'fast-jev-compaction';

/** After a run, wait until this share of the context window has accrued again. */
const RETRY_GROWTH = 0.1;

// Pi's message and content types, from the one module an extension can rely on.
type AgentMessage = ProjectedSessionEntry['messages'][number];
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

/**
 * The Claude Code plugin's options, read from `FAST_JEV_*` variables, with the
 * key from `TYPESAFE_API_KEY`; `resolveHookConfig` fills in the defaults.
 */
export function optionsFromEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string | number> {
  const options: Record<string, string | number> = {};
  for (const option of NUMBER_OPTIONS) {
    const raw = env[envName(option)];
    if (raw !== undefined && raw.trim() !== '') options[option] = Number(raw);
  }
  for (const option of ['model', 'goal']) {
    const raw = env[envName(option)];
    if (raw) options[option] = raw;
  }
  if (env.TYPESAFE_API_KEY) options.apiKey = env.TYPESAFE_API_KEY;
  return options;
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
}

/**
 * Maps Pi's projected context onto library messages. A run of tool results
 * becomes one user message, as in a Claude Code transcript, so
 * `preserveRecentMessages` counts the same; system messages are left out.
 */
export function toTranscript(entries: readonly ProjectedSessionEntry[]): PiTranscript {
  const transcript: PiTranscript = {
    messages: [],
    callEntries: new Map(),
    results: new Map(),
    assistants: new Map(),
  };
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
        transcript.messages.push({ role: 'user', text: messageText(message), toolUses: [] });
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
  const result = await compact(transcript.messages, asker, config);
  const { edits, charsSaved } = contextEdits(
    transcript,
    result.messages,
    resolveOptions(config).truncateHeadChars,
  );
  const { charsBefore } = result.stats;
  return { result, edits, charsSaved, ratio: charsBefore === 0 ? 0 : charsSaved / charsBefore };
}

function percent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
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

/**
 * The Pi extension. At the end of a turn whose context is at or above
 * `compactAtPercent`, Jev decides which older tool calls and results still
 * matter, and the rest shrink in the model context through append-only
 * `context_edit` entries (see `contextEdits`); everything kept stays
 * verbatim, no summary. Below `minReductionRatio`, or
 * when Jev fails, nothing changes and Pi's own summary compaction stays the
 * fallback. A run is retried only after the context grows by another 10% of
 * the window, or after it drops below the threshold.
 */
export function createFastJev(
  env: Readonly<Record<string, string | undefined>> = process.env,
  askerFor: (config: HookConfig) => JevAsker = (config) =>
    new JevClient({ apiKey: config.apiKey, model: config.model }),
) {
  return (pi: ExtensionAPI): void => {
    const config = resolveHookConfig(optionsFromEnv(env));
    let lastAttemptTokens: number | undefined;

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

      const notify = (text: string, type: 'info' | 'warning' = 'info') => {
        if (ctx.hasUI) ctx.ui.notify(`fast-jev: ${text}`, type);
      };
      if (!config.apiKey) {
        notify("TYPESAFE_API_KEY is not set; Pi's built-in compaction stays in charge", 'warning');
        return;
      }
      try {
        const run = await compactEntries(event.context.contextEntries, config, askerFor(config));
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
        notify(
          `skipped (${error instanceof Error ? error.message : String(error)}); Pi's compaction stays the fallback`,
          'warning',
        );
        return;
      }
    });
  };
}

export default createFastJev();
