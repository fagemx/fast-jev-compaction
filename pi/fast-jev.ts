import type {
  ContextEditEntryDraft,
  CustomEntryDraft,
  ExtensionAPI,
  ProjectedSessionEntry,
} from '@earendil-works/pi-coding-agent';

import { resolveHookConfig, summarize, type HookConfig } from '../hooks/fast-jev.js';
import { JevClient } from '../src/client.js';
import { compact, reductionRatio } from '../src/compact.js';
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
  /** Entry and text of each tool result, by tool call id. */
  results: Map<string, { entryId: string; text: string }>;
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
        transcript.results.set(message.toolCallId, { entryId: sourceEntry.id, text });
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
 * Turns the library's compacted transcript into Pi context edits: a dropped
 * call leaves its assistant entry (omitted once nothing visible remains) and
 * its result entry is omitted; a truncated result replaces its entry's content.
 */
export function contextEdits(
  transcript: PiTranscript,
  compacted: readonly Message[],
): ContextEditEntryDraft[] {
  const keptCalls = new Set<string>();
  const keptResults = new Map<string, string>();
  for (const message of compacted) {
    for (const tool of message.toolUses) keptCalls.add(tool.tool_use_id);
    for (const result of message.toolResults ?? []) keptResults.set(result.tool_use_id, result.text);
  }

  const edits: ContextEditEntryDraft[] = [];
  const droppedByEntry = new Map<string, Set<string>>();
  for (const [id, entryId] of transcript.callEntries) {
    if (keptCalls.has(id)) continue;
    const dropped = droppedByEntry.get(entryId) ?? new Set<string>();
    dropped.add(id);
    droppedByEntry.set(entryId, dropped);
  }
  for (const [entryId, dropped] of droppedByEntry) {
    const content = transcript.assistants
      .get(entryId)!
      .content.filter((block) => !(block.type === 'toolCall' && dropped.has(block.id)));
    const visible = content.some(
      (block) => block.type === 'toolCall' || (block.type === 'text' && block.text.trim() !== ''),
    );
    edits.push({ type: 'context_edit', targetId: entryId, replacement: visible ? { content } : null });
  }
  for (const [id, { entryId, text }] of transcript.results) {
    if (transcript.callEntries.has(id) && !keptCalls.has(id)) {
      edits.push({ type: 'context_edit', targetId: entryId, replacement: null });
      continue;
    }
    const kept = keptResults.get(id);
    if (kept !== undefined && kept !== text) {
      edits.push({
        type: 'context_edit',
        targetId: entryId,
        replacement: { content: [{ type: 'text', text: kept }] },
      });
    }
  }
  return edits;
}

export type PiCompaction = {
  result: CompactResult;
  edits: ContextEditEntryDraft[];
};

/** Runs the library over Pi's projected context; throws when Jev fails. */
export async function compactEntries(
  entries: readonly ProjectedSessionEntry[],
  config: HookConfig,
  asker: JevAsker,
): Promise<PiCompaction> {
  const transcript = toTranscript(entries);
  const result = await compact(transcript.messages, asker, config);
  return { result, edits: contextEdits(transcript, result.messages) };
}

function percent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

/**
 * The Pi extension. At the end of a turn whose context is at or above
 * `compactAtPercent`, Jev decides which older tool calls and results still
 * matter, and the rest leave the model context through append-only
 * `context_edit` entries: verbatim, no summary. Below `minReductionRatio`, or
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
        const { result, edits } = await compactEntries(
          event.context.contextEntries,
          config,
          askerFor(config),
        );
        const record: CustomEntryDraft = {
          type: 'custom',
          customType: CUSTOM_TYPE,
          data: { stats: result.stats, decisions: result.decisions },
        };
        if (edits.length === 0 || reductionRatio(result) < config.minReductionRatio) {
          notify(`below the ${percent(config.minReductionRatio)} minimum, no edits (${summarize(result)})`);
          return { entries: [...event.entries, record] };
        }
        notify(`${edits.length} context edits, no summary (${summarize(result)})`);
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
