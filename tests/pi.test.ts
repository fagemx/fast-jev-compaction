import { describe, expect, it } from 'vitest';
import type {
  ContextEditEntryDraft,
  ExtensionAPI,
  ExtensionContext,
  ProjectedSessionEntry,
  TurnEndEvent,
  TurnEndEventResult,
} from '@earendil-works/pi-coding-agent';
import {
  abridgeInput,
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
    expect(transcript.results.get('c2')).toEqual({ entryId: 'r2', text: 'B', isError: false });
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

/** The projection Pi rebuilds after the edits: each target's content replaced. */
function applyEdits(entries: ProjectedSessionEntry[], edits: readonly ContextEditEntryDraft[]): ProjectedSessionEntry[] {
  return entries.map((entry) => {
    const edit = edits.findLast((e) => e.targetId === entry.sourceEntry.id);
    if (!edit) return entry;
    if (!edit.replacement) return { ...entry, messages: [] };
    const content = edit.replacement.content;
    return { ...entry, messages: entry.messages.map((m) => ({ ...m, content }) as AgentMessage) };
  });
}

const textOf = (edit: ContextEditEntryDraft | undefined) =>
  (edit?.replacement?.content as { type: 'text'; text: string }[])[0]!.text;

const dropEverything = { t1: { call: 0.1, result: 0.1 }, t2: { call: 0.1, result: 0.1 }, t3: { call: 0.1, result: 0.1 } };

describe('compactEntries', () => {
  it('truncates dropped results and stubs dropped calls behind a marker result', async () => {
    const config = { ...resolveHookConfig({}), preserveRecentMessages: 0 };
    const run = await compactEntries(
      session(),
      config,
      asker({ t1: { call: 0.9, result: 0.1 }, t2: { call: 0.9, result: 0.9 }, t3: { call: 0.1, result: 0.1 } }),
    );
    expect(run.result.decisions.map((d) => d.action)).toEqual(['drop_result', 'keep', 'drop_call']);
    expect(run.edits.map((edit) => edit.targetId)).toEqual(['r1', 'r3']);
    expect(run.edits.every((edit) => edit.replacement !== null)).toBe(true);
    const truncated = textOf(run.edits[0]);
    expect(truncated.startsWith(fileA.slice(0, 300))).toBe(true);
    expect(truncated).toContain('[fast-jev-compaction truncated 700 chars');
    expect(textOf(run.edits[1])).toBe(
      '[fast-jev-compaction truncated 1000 chars of this tool result; re-run the tool if needed]',
    );
    expect(run.charsSaved).toBe(1000 - truncated.length + 1000 - textOf(run.edits[1]).length);
    expect(run.ratio).toBeCloseTo(run.charsSaved / run.result.stats.charsBefore);
  });

  it('abridges the long input of a stubbed call and keeps the rest of its entry', async () => {
    const config = { ...resolveHookConfig({}), preserveRecentMessages: 0 };
    const entries = [
      user('u1', 'Write c.ts.'),
      assistant('w1', [
        { type: 'thinking', thinking: 'write it' },
        { type: 'text', text: 'Writing.' },
        toolCall('c9', 'write', { path: 'src/c.ts', content: fileA }),
      ]),
      toolResult('rw', 'c9', 'Wrote 1000 bytes'),
      assistant('a4', [{ type: 'text', text: 'Done.' }]),
    ];
    const { edits } = await compactEntries(entries, config, asker(dropEverything));
    expect(edits).toEqual([
      {
        type: 'context_edit',
        targetId: 'w1',
        replacement: {
          content: [
            { type: 'thinking', thinking: 'write it' },
            { type: 'text', text: 'Writing.' },
            toolCall('c9', 'write', {
              path: 'src/c.ts',
              content: `${fileA.slice(0, 300)}…[fast-jev-compaction truncated 700 chars]`,
            }),
          ],
        },
      },
    ]);
  });

  it('leaves its own output unchanged when compaction runs again', async () => {
    const config = { ...resolveHookConfig({}), preserveRecentMessages: 0 };
    const entries = [
      ...session(),
      assistant('w1', [toolCall('c9', 'write', { path: 'src/c.ts', content: fileA })]),
      toolResult('rw', 'c9', fileB),
    ];
    const first = await compactEntries(entries, config, asker({ ...dropEverything, t4: { call: 0.1, result: 0.1 } }));
    expect(first.edits.length).toBeGreaterThan(0);
    const second = await compactEntries(
      applyEdits(entries, first.edits),
      config,
      asker({ ...dropEverything, t4: { call: 0.1, result: 0.1 } }),
    );
    expect(second.edits).toEqual([]);
  });

  it('makes no edits when everything is kept', () => {
    const transcript = toTranscript(session());
    expect(contextEdits(transcript, transcript.messages, 300)).toEqual({ edits: [], charsSaved: 0 });
  });

  it('cuts only long strings, at any depth', () => {
    const long = 'x'.repeat(500);
    expect(abridgeInput({ a: 'short', b: [long, { c: long }], n: 3, z: null }, 10)).toEqual({
      a: 'short',
      b: ['xxxxxxxxxx…[fast-jev-compaction truncated 490 chars]', { c: 'xxxxxxxxxx…[fast-jev-compaction truncated 490 chars]' }],
      n: 3,
      z: null,
    });
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
  const dropAll = asker(dropEverything);

  it('appends context edits and a record after the earlier proposed entries', async () => {
    const ext = load(env, dropAll);
    expect(await ext.turnEnd(59)).toBeUndefined();
    const result = await ext.turnEnd(60);
    expect(result?.entries?.[0]).toEqual({ type: 'custom', customType: 'other' });
    expect(result?.entries?.filter((e) => e.type === 'context_edit')).toHaveLength(2);
    expect(result?.entries?.at(-1)).toMatchObject({ type: 'custom', customType: CUSTOM_TYPE });
    expect(ext.notes[0]).toMatch(/^fast-jev: 2 context edits, no summary \(\d+% reduction; 3 calls stubbed;/);
    expect(result?.entries?.at(-1)).toMatchObject({ data: { stats: { messagesAfter: 9 } } });
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
