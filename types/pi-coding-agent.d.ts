// The subset of @earendil-works/pi-coding-agent (1.0) that pi/fast-jev.ts uses.
//
// Pi supplies the real module to extensions at run time and the extension only
// imports types from it, so the repo does not depend on the host package. The
// shapes below are copied from the package's own declarations; check them
// against `dist/core/extensions/types.d.ts` and `dist/core/session-manager.d.ts`
// after a Pi update.
declare module '@earendil-works/pi-coding-agent' {
  // Message and content types live in pi-agent-core and pi-ai; they are not
  // exported here, so the extension derives them from ProjectedSessionEntry.
  export {};

  interface TextContent {
    type: 'text';
    text: string;
  }

  interface ImageContent {
    type: 'image';
    data: string;
    mimeType: string;
  }

  interface ThinkingContent {
    type: 'thinking';
    thinking: string;
  }

  interface ToolCall {
    type: 'toolCall';
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }

  type AgentMessage =
    | { role: 'user'; content: string | (TextContent | ImageContent)[]; timestamp: number }
    | { role: 'assistant'; content: (TextContent | ThinkingContent | ToolCall)[]; timestamp: number }
    | {
        role: 'toolResult';
        toolCallId: string;
        toolName: string;
        content: (TextContent | ImageContent)[];
        isError: boolean;
        timestamp: number;
      }
    | { role: 'system'; timestamp: number }
    | { role: 'custom'; customType: string; content: string | (TextContent | ImageContent)[]; timestamp: number }
    | { role: 'bashExecution'; command: string; output: string; timestamp: number }
    | { role: 'branchSummary'; summary: string; timestamp: number }
    | { role: 'compactionSummary'; summary: string; timestamp: number };

  type ContextEditableContent =
    | string
    | (TextContent | ImageContent)[]
    | (TextContent | ThinkingContent | ToolCall)[];

  export interface ProjectedSessionEntry {
    /** Raw append-only entry that owns this projected contribution. */
    sourceEntry: { id: string; type: string };
    /** Model-visible messages after context edits. Empty for state-only entries and omissions. */
    messages: AgentMessage[];
  }

  export interface ContextEditEntryDraft {
    type: 'context_edit';
    targetId: string;
    replacement: { content: ContextEditableContent } | null;
  }

  export interface CustomEntryDraft {
    type: 'custom';
    customType: string;
    data?: unknown;
  }

  export type SessionBoundaryDraft = CustomEntryDraft | ContextEditEntryDraft;

  export interface TurnEndEvent {
    type: 'turn_end';
    entries: SessionBoundaryDraft[];
    continue: boolean;
    context: { contextEntries: ProjectedSessionEntry[] };
  }

  export interface TurnEndEventResult {
    entries?: SessionBoundaryDraft[];
    continue?: boolean;
  }

  export interface CompactionPreparation {
    /** UUID of first entry to keep */
    firstKeptEntryId: string;
    /** Messages that will be summarized and discarded */
    messagesToSummarize: AgentMessage[];
    /** Messages that will be turned into turn prefix summary (if splitting) */
    turnPrefixMessages: AgentMessage[];
    isSplitTurn: boolean;
    tokensBefore: number;
    /** Summary from previous compaction, for iterative update */
    previousSummary?: string;
    fileOps: { read: Set<string>; written: Set<string>; edited: Set<string> };
    settings: { enabled: boolean; reserveTokens: number; keepRecentTokens: number };
  }

  export interface SessionBeforeCompactEvent {
    type: 'session_before_compact';
    preparation: CompactionPreparation;
    customInstructions?: string;
    /** What triggered the compaction: manual /compact, the context threshold, or context overflow recovery */
    reason: 'manual' | 'threshold' | 'overflow';
    willRetry: boolean;
    signal: AbortSignal;
  }

  export interface CompactionResult {
    summary: string;
    firstKeptEntryId: string;
    tokensBefore: number;
    details?: unknown;
  }

  export interface SessionBeforeCompactResult {
    cancel?: boolean;
    compaction?: CompactionResult;
  }

  export interface ContextUsage {
    /** Estimated context tokens, or null if unknown (e.g. right after compaction). */
    tokens: number | null;
    contextWindow: number;
    /** Context usage as percentage of the context window, or null if tokens is unknown. */
    percent: number | null;
  }

  export interface ExtensionContext {
    hasUI: boolean;
    ui: { notify(message: string, type?: 'info' | 'warning' | 'error'): void };
    /** The current abort signal, or undefined when the agent is not streaming. */
    signal: AbortSignal | undefined;
    modelRegistry: { getApiKeyForProvider(provider: string): Promise<string | undefined> };
    model: { contextWindow: number } | undefined;
    sessionManager: { buildSessionProjection(): { entries: ProjectedSessionEntry[] } };
    getContextUsage(): ContextUsage | undefined;
  }

  export interface ExtensionAPI {
    on(
      event: 'session_before_compact',
      handler: (
        event: SessionBeforeCompactEvent,
        ctx: ExtensionContext,
      ) => Promise<SessionBeforeCompactResult | void> | SessionBeforeCompactResult | void,
    ): () => void;
    on(
      event: 'turn_end',
      handler: (
        event: TurnEndEvent,
        ctx: ExtensionContext,
      ) => Promise<TurnEndEventResult | void> | TurnEndEventResult | void,
    ): () => void;
  }
}
