import { describe, expect, it } from 'vitest';
import type {
  ExtensionAPI,
  ExtensionContext,
  ProjectedSessionEntry,
  TurnEndEvent,
  TurnEndEventResult,
} from '@earendil-works/pi-coding-agent';
import {
  compactEntries,
  contextEdits,
  createFastJev,
  CUSTOM_TYPE,
  envName,
  optionsFromEnv,
  toTranscript,
} from '../pi/fast-jev.ts';
import { resolveHookConfig } from '../hooks/fast-jev.ts';
import type { JevAsker } from '../src/index.js';

type AgentMessage = ProjectedSessionEntry['messages'][number];

const fileA = 'export const a = 1;\n'.repeat(50);
const fileB = 'export const b = 2;\n'.repeat(50);

function entry(id: string, message: AgentMessage): ProjectedSessionEntry {
  return { sourceEntry: { id, type: 'message' }, messages: [message] };
}

function user(id: string, text: string): ProjectedSessionEntry {
  return entry(id, { role: 'user', content: text, timestamp: 0 });
}

function assistant(id: string, content: Extract<AgentMessage, { role: 'assistant' }>['content']) {
  return entry(id, { role: 'assistant', content, timestamp: 0 });
}

function toolCall(id: string, name: string, args: Record<string, unknown>) {
  return { type: 'toolCall' as const, id, name, arguments: args };
}

function toolResult(id: string, callId: string, text: string, isError = false) {
  return entry(id, {
    role: 'toolResult',
    toolCallId: callId,
    toolName: 'tool',
    content: [{ type: 'text', text }],
    isError,
    timestamp: 0,
  });
}

function session(): ProjectedSessionEntry[] {
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
function asker(answers: Record<string, { call: number; result: number }>): JevAsker {
  return {
    async ask(_state, questions) {
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

describe('toTranscript', () => {
  it('maps assistant tool calls and groups consecutive tool results into one user message', () => {
    const transcript = toTranscript([
      ...session().slice(0, 1),
      assistant('a1', [toolCall('c1', 'read', { path: 'a' }), toolCall('c2', 'read', { path: 'b' })]),
      toolResult('r1', 'c1', 'A'),
      toolResult('r2', 'c2', 'B'),
      { sourceEntry: { id: 's1', type: 'compaction' }, messages: [{ role: 'system', timestamp: 0 }] },
    ]);
    expect(transcript.messages).toEqual([
      { role: 'user', text: 'Fix the failing test.', toolUses: [] },
      {
        role: 'assistant',
        text: '',
        toolUses: [
          { tool_use_id: 'c1', tool: 'read', input: { path: 'a' } },
          { tool_use_id: 'c2', tool: 'read', input: { path: 'b' } },
        ],
      },
      {
        role: 'user',
        text: '',
        toolUses: [],
        toolResults: [
          { tool_use_id: 'c1', text: 'A', isError: false },
          { tool_use_id: 'c2', text: 'B', isError: false },
        ],
      },
    ]);
    expect([...transcript.callEntries]).toEqual([
      ['c1', 'a1'],
      ['c2', 'a1'],
    ]);
    expect(transcript.results.get('c2')).toEqual({ entryId: 'r2', text: 'B' });
  });

  it('gives summaries, bash runs and unknown roles a user text', () => {
    const transcript = toTranscript([
      entry('s', { role: 'compactionSummary', summary: 'Earlier work', timestamp: 0 }),
      entry('b', { role: 'bashExecution', command: 'ls', output: 'a.ts', timestamp: 0 }),
      entry('x', { role: 'mystery', timestamp: 0 } as unknown as AgentMessage),
    ]);
    expect(transcript.messages.map((m) => m.text)).toEqual(['Earlier work', '$ ls\na.ts', '']);
  });
});

describe('compactEntries', () => {
  it('omits dropped calls and their results, truncates dropped results, and leaves kept calls alone', async () => {
    const config = { ...resolveHookConfig({}), preserveRecentMessages: 0 };
    const { result, edits } = await compactEntries(
      session(),
      config,
      asker({ t1: { call: 0.9, result: 0.1 }, t2: { call: 0.9, result: 0.9 }, t3: { call: 0.1, result: 0.1 } }),
    );
    expect(result.decisions.map((d) => d.action)).toEqual(['drop_result', 'keep', 'drop_call']);
    expect(edits).toHaveLength(3);
    expect(edits).toContainEqual({ type: 'context_edit', targetId: 'a3', replacement: null });
    expect(edits).toContainEqual({ type: 'context_edit', targetId: 'r3', replacement: null });
    const truncated = edits.find((edit) => edit.targetId === 'r1');
    const text = (truncated?.replacement?.content as { type: 'text'; text: string }[])[0]!.text;
    expect(text.startsWith(fileA.slice(0, 300))).toBe(true);
    expect(text).toContain('[fast-jev-compaction truncated');
  });

  it('keeps the visible rest of an assistant entry whose call is dropped', async () => {
    const config = { ...resolveHookConfig({}), preserveRecentMessages: 0 };
    const { edits } = await compactEntries(session(), config, asker({ t1: { call: 0.1, result: 0.1 } }));
    expect(edits).toEqual([
      { type: 'context_edit', targetId: 'a1', replacement: { content: [{ type: 'text', text: 'Reading.' }] } },
      { type: 'context_edit', targetId: 'r1', replacement: null },
    ]);
  });

  it('makes no edits when everything is kept', () => {
    const transcript = toTranscript(session());
    expect(contextEdits(transcript, transcript.messages)).toEqual([]);
  });
});

describe('options from the environment', () => {
  it('reads FAST_JEV_* variables and TYPESAFE_API_KEY', () => {
    expect(envName('preserveRecentMessages')).toBe('FAST_JEV_PRESERVE_RECENT_MESSAGES');
    const options = optionsFromEnv({
      TYPESAFE_API_KEY: 'k',
      FAST_JEV_COMPACT_AT_PERCENT: '40',
      FAST_JEV_KEEP_THRESHOLD: 'nope',
      FAST_JEV_MODEL: 'jev-x',
      FAST_JEV_TRUNCATE_HEAD_CHARS: ' ',
    });
    expect(resolveHookConfig(options)).toEqual({
      apiKey: 'k',
      compactAtPercent: 40,
      minReductionRatio: 0.25,
      model: 'jev-x',
    });
  });
});

describe('the Pi extension', () => {
  function load(env: Record<string, string>, jev: JevAsker) {
    let handler: ((event: TurnEndEvent, ctx: ExtensionContext) => unknown) | undefined;
    const pi = {
      on(_event: 'turn_end', h: typeof handler) {
        handler = h;
        return () => {};
      },
    } as unknown as ExtensionAPI;
    createFastJev(env, () => jev)(pi);
    const notes: string[] = [];
    return {
      notes,
      async turnEnd(percent: number): Promise<TurnEndEventResult | undefined> {
        const prior = { type: 'custom' as const, customType: 'other' };
        const ctx: ExtensionContext = {
          hasUI: true,
          ui: { notify: (message) => notes.push(message) },
          getContextUsage: () => ({ tokens: percent * 1000, contextWindow: 100_000, percent }),
        };
        const event: TurnEndEvent = {
          type: 'turn_end',
          entries: [prior],
          continue: false,
          context: { contextEntries: session() },
        };
        return (await handler!(event, ctx)) as TurnEndEventResult | undefined;
      },
    };
  }

  const env = { TYPESAFE_API_KEY: 'k', FAST_JEV_PRESERVE_RECENT_MESSAGES: '0' };
  const dropAll = asker({ t1: { call: 0.1, result: 0.1 }, t2: { call: 0.1, result: 0.1 }, t3: { call: 0.1, result: 0.1 } });

  it('appends context edits and a record after the earlier proposed entries', async () => {
    const ext = load(env, dropAll);
    expect(await ext.turnEnd(59)).toBeUndefined();
    const result = await ext.turnEnd(60);
    expect(result?.entries?.[0]).toEqual({ type: 'custom', customType: 'other' });
    expect(result?.entries?.filter((e) => e.type === 'context_edit')).toHaveLength(6);
    expect(result?.entries?.at(-1)).toMatchObject({ type: 'custom', customType: CUSTOM_TYPE });
    expect(ext.notes[0]).toMatch(/^fast-jev: 6 context edits, no summary/);
  });

  it('waits for another 10% of the window, or a drop below the threshold, before running again', async () => {
    const ext = load(env, dropAll);
    expect(await ext.turnEnd(70)).toBeDefined();
    expect(await ext.turnEnd(75)).toBeUndefined();
    expect(await ext.turnEnd(80)).toBeDefined();
    expect(await ext.turnEnd(50)).toBeUndefined();
    expect(await ext.turnEnd(61)).toBeDefined();
  });

  it('records the run but edits nothing below the minimum reduction', async () => {
    const ext = load(env, asker({}));
    const result = await ext.turnEnd(65);
    expect(result?.entries).toHaveLength(2);
    expect(ext.notes[0]).toMatch(/below the 25% minimum, no edits/);
  });

  it('leaves the context to Pi without a key or when Jev fails', async () => {
    const noKey = load({}, dropAll);
    expect(await noKey.turnEnd(90)).toBeUndefined();
    expect(noKey.notes[0]).toMatch(/TYPESAFE_API_KEY is not set/);

    const failing = load(env, { ask: async () => Promise.reject(new Error('Jev 503')) });
    expect(await failing.turnEnd(90)).toBeUndefined();
    expect(failing.notes[0]).toMatch(/skipped \(Jev 503\)/);
  });
});
