import type {
  ExtensionAPI,
  ExtensionContext,
  ProjectedSessionEntry,
} from '@earendil-works/pi-coding-agent';
import type { JevAsker } from '../src/index.js';

export type AgentMessage = ProjectedSessionEntry['messages'][number];

export const fileA = 'export const a = 1;\n'.repeat(50);
export const fileB = 'export const b = 2;\n'.repeat(50);

export function entry(id: string, message: AgentMessage): ProjectedSessionEntry {
  return { sourceEntry: { id, type: 'message' }, messages: [message] };
}

export function user(id: string, text: string): ProjectedSessionEntry {
  return entry(id, { role: 'user', content: text, timestamp: 0 });
}

export function assistant(id: string, content: Extract<AgentMessage, { role: 'assistant' }>['content']) {
  return entry(id, { role: 'assistant', content, timestamp: 0 });
}

export function toolCall(id: string, name: string, args: Record<string, unknown>) {
  return { type: 'toolCall' as const, id, name, arguments: args };
}

export function toolResult(id: string, callId: string, text: string, isError = false) {
  return entry(id, {
    role: 'toolResult',
    toolCallId: callId,
    toolName: 'tool',
    content: [{ type: 'text', text }],
    isError,
    timestamp: 0,
  });
}

export function session(): ProjectedSessionEntry[] {
  return [
    user('u1', 'Fix the failing test.'),
    assistant('a1', [{ type: 'text', text: 'Reading.' }, toolCall('c1', 'read', { path: 'src/a.ts' })]),
    toolResult('r1', 'c1', fileA),
    assistant('a2', [toolCall('c2', 'bash', { command: 'npm test' })]),
    toolResult('r2', 'c2', 'FAIL b.test.ts: expected 2 to be 3', true),
    assistant('a3', [{ type: 'thinking', thinking: 'look at b' }, toolCall('c3', 'read', { path: 'src/b.ts' })]),
    toolResult('r3', 'c3', fileB),
    assistant('a4', [{ type: 'text', text: 'Fixing now.' }]),
    user('u2', 'go ahead'),
  ];
}

/** Answers every Jev question from the call's short id (`t1`, `t2`, ...). */
export function asker(
  answers: Record<string, { call: number; result: number }>,
  states: unknown[] = [],
): JevAsker {
  return {
    async ask(state, questions) {
      states.push(state);
      return {
        answers: Object.fromEntries(
          Object.keys(questions).map((name) => {
            const [kind, id] = name.split('_') as ['call' | 'result', string];
            return [name, { type: 'noul', noul: answers[id]?.[kind] ?? 1 }];
          }),
        ),
      };
    },
  };
}

export const dropEverything = {
  t1: { call: 0.1, result: 0.1 },
  t2: { call: 0.1, result: 0.1 },
  t3: { call: 0.1, result: 0.1 },
};

type Handler = (event: never, ctx: ExtensionContext) => unknown;

/** A Pi stand-in that keeps the handlers an extension registers, by event. */
export function fakePi(): {
  pi: ExtensionAPI;
  handlers: Map<string, Handler>;
  registered: Array<{ name: string; models: unknown[] }>;
} {
  const handlers = new Map<string, Handler>();
  const registered: Array<{ name: string; models: unknown[] }> = [];
  const pi = {
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
      return () => {};
    },
    registerProvider(name: string, config: { models: unknown[] }) {
      registered.push({ name, models: config.models });
    },
  } as unknown as ExtensionAPI;
  return { pi, handlers, registered };
}

/** An extension context over a projected session, recording notifications. */
export function fakeContext(options: {
  notes: string[];
  percent?: number;
  contextWindow?: number;
  entries?: ProjectedSessionEntry[];
  piKeys?: Record<string, string>;
  providers?: Record<string, Array<{ id: string; contextWindow?: number }>>;
}): ExtensionContext {
  const contextWindow = options.contextWindow ?? 100_000;
  const percent = options.percent ?? 0;
  return {
    hasUI: true,
    ui: { notify: (message) => void options.notes.push(message) },
    signal: undefined,
    modelRegistry: {
      getApiKeyForProvider: async (provider) => options.piKeys?.[provider],
      getProvider: (provider) => {
        const models = options.providers?.[provider];
        return models ? { getAllModels: () => models } : undefined;
      },
    },
    model: { contextWindow },
    sessionManager: { buildSessionProjection: () => ({ entries: options.entries ?? session() }) },
    getContextUsage: () => ({ tokens: (percent / 100) * contextWindow, contextWindow, percent }),
  };
}
