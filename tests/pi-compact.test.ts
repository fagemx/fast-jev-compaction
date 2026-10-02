import { describe, expect, it } from 'vitest';
import type {
  CompactionPreparation,
  SessionBeforeCompactEvent,
  SessionBeforeCompactResult,
} from '@earendil-works/pi-coding-agent';
import {
  carriedCompaction,
  compactRegion,
  createFastJev,
  serializeMessage,
  type JevEndpoint,
} from '../pi/fast-jev.ts';
import { resolveHookConfig } from '../hooks/fast-jev.ts';
import type { JevAsker } from '../src/index.js';
import {
  asker,
  assistant,
  dropEverything,
  fakeContext,
  entry,
  fakePi,
  fileA,
  fileB,
  session,
  user,
  toolCall,
  toolResult,
  type AgentMessage,
} from './pi-fixtures.ts';

const messagesOf = (entries: ReturnType<typeof session>) => entries.flatMap((e) => e.messages);
/** What Pi summarizes in the fixture session: everything before `a4`. */
const region = () => messagesOf(session().slice(0, 7));
const kept = () => session().slice(7);
const config = { ...resolveHookConfig({}), preserveRecentMessages: 0 };

describe('serializeMessage', () => {
  const one = (message: AgentMessage) => serializeMessage(message);

  it('writes each role verbatim and leaves thinking and system messages out', () => {
    expect(one({ role: 'user', content: 'Fix it', timestamp: 0 })).toBe('[User]: Fix it');
    expect(
      one({
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'secret plan' },
          { type: 'text', text: 'Reading.' },
          toolCall('c1', 'read', { path: 'src/a.ts' }),
        ],
        timestamp: 0,
      }),
    ).toBe('[Assistant]: Reading.\n[Assistant tool call]: read({"path":"src/a.ts"})');
    expect(
      one({
        role: 'toolResult',
        toolCallId: 'c2',
        toolName: 'bash',
        content: [{ type: 'text', text: 'FAIL' }, { type: 'image', data: 'x', mimeType: 'image/png' }],
        isError: true,
        timestamp: 0,
      }),
    ).toBe('[Tool result bash (error)]: FAIL\n[image]');
    expect(one({ role: 'bashExecution', command: 'ls', output: 'a.ts', timestamp: 0 })).toBe('[User bash]: $ ls\na.ts');
    expect(one({ role: 'compactionSummary', summary: 'Earlier', timestamp: 0 })).toBe('[Summary]: Earlier');
    expect(one({ role: 'system', timestamp: 0 })).toBeUndefined();
    expect(one({ role: 'assistant', content: [{ type: 'thinking', thinking: 'only' }], timestamp: 0 })).toBeUndefined();
  });
});

describe('compactRegion', () => {
  it('writes the region verbatim with the stale tool outputs cut to their marker', async () => {
    const run = await compactRegion(region(), kept(), config, asker(dropEverything), {});
    expect(run.summary).toContain('[User]: Fix the failing test.');
    expect(run.summary).toContain('[Assistant tool call]: read({"path":"src/a.ts"})');
    expect(run.summary).toContain(
      '[Tool result tool]: [fast-jev-compaction truncated 1000 chars of this tool result; re-run the tool if needed]',
    );
    expect(run.summary).not.toContain(fileA.slice(0, 40));
    expect(run.summary).not.toContain('look at b');
    expect(run.ratio).toBeGreaterThan(0.5);
    expect(run.charsAfter).toBeLessThan(run.charsBefore);
  });

  it('keeps the kept messages pinned, the previous summary first, and instructions in the goal', async () => {
    const states: unknown[] = [];
    const keptWithCall = [
      assistant('k1', [toolCall('k9', 'read', { path: 'src/c.ts' })]),
      toolResult('kr', 'k9', fileB),
      ...kept(),
    ];
    const run = await compactRegion(region(), keptWithCall, config, asker(dropEverything, states), {
      previousSummary: 'Earlier: set up the repo.',
      customInstructions: 'Focus on the b.test.ts failure',
    });
    expect(run.result.decisions.at(-1)).toMatchObject({ reason: 'pinned' });
    expect(run.summary.indexOf('Earlier: set up the repo.')).toBeLessThan(run.summary.indexOf('[User]: Fix'));
    expect((states[0] as { goal: string }).goal).toMatch(/^Focus on the b\.test\.ts failure\nFix the failing test\./);
  });

  it("lets Pi's kept window stand in for the default recent-message pin", async () => {
    // a4 and u2 are kept; without the default pin of 6, the region's last calls are candidates too.
    const defaults = await compactRegion(region(), kept(), resolveHookConfig({}), asker(dropEverything), {});
    expect(defaults.result.decisions.map((d) => d.reason)).toEqual(['call_dropped', 'call_dropped', 'call_dropped']);
    // An explicit setting is still honoured on top of the kept window.
    const explicit = await compactRegion(
      region(),
      kept(),
      resolveHookConfig({ preserveRecentMessages: 6 }),
      asker(dropEverything),
      {},
    );
    expect(explicit.result.decisions.filter((d) => d.reason === 'pinned')).toHaveLength(2);
  });

  it('lists the files the region read and changed, as Pi does', async () => {
    const run = await compactRegion(region(), kept(), config, asker(dropEverything), {
      files: { read: ['src/a.ts', 'src/b.ts'], modified: ['src/c.ts', 'src/b.ts'] },
    });
    expect(run.summary).toContain('<read-files>\nsrc/a.ts\n</read-files>');
    expect(run.summary).toContain('<modified-files>\nsrc/b.ts\nsrc/c.ts\n</modified-files>');
    expect(run).toMatchObject({ readFiles: ['src/a.ts'], modifiedFiles: ['src/b.ts', 'src/c.ts'] });
  });

  it('returns the cut messages without thinking or image data, for the next compaction to carry', async () => {
    const withImage = [
      ...region(),
      ...messagesOf([
        entry('i', {
          role: 'toolResult',
          toolCallId: 'c3',
          toolName: 'screenshot',
          content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }],
          isError: false,
          timestamp: 0,
        }),
      ]),
    ];
    const run = await compactRegion(withImage, kept(), config, asker(dropEverything), {});
    const stored = JSON.stringify(run.messages);
    expect(stored).not.toContain('look at b');
    expect(stored).not.toContain('AAAA');
    expect(stored).toContain('[fast-jev-compaction truncated 1000 chars');
  });

  it('measures how much of the context is left, kept window included', async () => {
    const run = await compactRegion(region(), kept(), config, asker(dropEverything), {});
    expect(run.remaining).toBeGreaterThan(0);
    expect(run.remaining).toBeLessThan(0.5);
    const nothing = await compactRegion(region(), kept(), config, asker({}), {});
    expect(nothing.remaining).toBeGreaterThan(0.99);
  });
});

describe('carriedCompaction', () => {
  const details = { fastJev: { messages: [], readFiles: [], modifiedFiles: [] } };
  it("picks up the latest compaction when it is Jev's and the one Pi builds on", () => {
    const entries = [
      { type: 'compaction' as const, id: 'old', summary: 'older', firstKeptEntryId: 'x', details },
      { type: 'message' as const, id: 'm' },
      { type: 'compaction' as const, id: 'new', summary: 'latest', firstKeptEntryId: 'y', details },
    ];
    expect(carriedCompaction(entries, 'latest')).toBe(details.fastJev);
    expect(carriedCompaction(entries, 'older')).toBeUndefined();
    expect(carriedCompaction([{ type: 'compaction', id: 'p', summary: 'pi', firstKeptEntryId: 'z' }], 'pi')).toBeUndefined();
    expect(carriedCompaction([], undefined)).toBeUndefined();
  });
});

describe('the Pi extension on /compact and automatic compaction', () => {
  function preparation(overrides: Partial<CompactionPreparation> = {}): CompactionPreparation {
    return {
      firstKeptEntryId: 'a4',
      messagesToSummarize: region(),
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 5000,
      fileOps: { read: new Set(['src/a.ts']), written: new Set(), edited: new Set() },
      settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
      ...overrides,
    };
  }

  function load(env: Record<string, string>, jev: JevAsker, contextWindow = 100_000) {
    const { pi, handlers } = fakePi();
    const endpoints: JevEndpoint[] = [];
    createFastJev(env, (endpoint) => {
      endpoints.push(endpoint);
      return jev;
    })(pi);
    const notes: string[] = [];
    const turn = new AbortController();
    return {
      notes,
      endpoints,
      signal: turn.signal,
      async compact(
        reason: SessionBeforeCompactEvent['reason'] = 'manual',
        prepared: CompactionPreparation = preparation(),
        branchEntries: SessionBeforeCompactEvent['branchEntries'] = [],
      ) {
        const event: SessionBeforeCompactEvent = {
          type: 'session_before_compact',
          preparation: prepared,
          branchEntries,
          reason,
          willRetry: false,
          signal: turn.signal,
        };
        const handler = handlers.get('session_before_compact')!;
        return (await handler(event as never, fakeContext({ notes, contextWindow }))) as
          | SessionBeforeCompactResult
          | undefined;
      },
    };
  }

  const env = { TYPESAFE_API_KEY: 'k', FAST_JEV_PRESERVE_RECENT_MESSAGES: '0' };

  it('hands Pi a verbatim summary instead of an LLM one', async () => {
    const ext = load(env, asker(dropEverything));
    const result = await ext.compact();
    expect(result?.compaction).toMatchObject({ firstKeptEntryId: 'a4', tokensBefore: 5000 });
    expect(result?.compaction?.summary).toContain('[User]: Fix the failing test.');
    expect(result?.compaction?.details).toMatchObject({ fastJev: { stats: { callsDropped: 3 } } });
    expect(ext.endpoints[0]?.signal).toBe(ext.signal);
    expect(ext.notes[0]).toMatch(/^fast-jev: \/compact by Jev, no LLM summary \(older history: \d+% reduction; 3 calls stubbed; .*; context ~5k → .* tokens\)$/);
  });

  it('serves automatic and overflow compaction the same way', async () => {
    const ext = load(env, asker(dropEverything));
    expect((await ext.compact('threshold'))?.compaction).toBeDefined();
    expect((await ext.compact('overflow'))?.compaction).toBeDefined();
  });

  it('carries the previous Jev compaction into the next one and scores it again', async () => {
    // Round 1 keeps a.ts verbatim; round 2, with more work done, no longer needs it.
    const first = load(env, asker({ t1: { call: 0.9, result: 0.9 }, t2: { call: 0.1, result: 0.1 }, t3: { call: 0.1, result: 0.1 } }));
    const round1 = (await first.compact())!.compaction!;
    expect(round1.summary).toContain(fileA.slice(0, 40));

    const later = messagesOf([
      user('u3', 'Now also check src/d.ts.'),
      assistant('a5', [toolCall('c5', 'read', { path: 'src/d.ts' })]),
      toolResult('r5', 'c5', fileB),
    ]);
    const dropAll4 = { ...dropEverything, t4: { call: 0.1, result: 0.1 } };
    const second = load(env, asker(dropAll4));
    const round2 = (await second.compact(
      'threshold',
      preparation({ messagesToSummarize: [...messagesOf(kept()), ...later], previousSummary: round1.summary }),
      [
        { type: 'compaction', id: 'c-1', summary: round1.summary, firstKeptEntryId: 'a4', details: round1.details },
        { type: 'message', id: 'u3' },
      ],
    ))!.compaction!;
    expect(round2.summary.split('[User]: Fix the failing test.').length).toBe(2);
    expect(round2.summary).not.toContain(fileA.slice(0, 40));
    expect(round2.summary).toContain('[User]: Now also check src/d.ts.');
    expect(round2.summary).not.toContain('<previous-summary>');
  });

  it("leaves the summary to Pi without a key, when Jev fails or cuts nothing, and when the result stays too large", async () => {
    const noKey = load({}, asker(dropEverything));
    expect(await noKey.compact()).toBeUndefined();
    expect(noKey.notes[0]).toMatch(/TYPESAFE_API_KEY is not set/);

    const failing = load(env, { ask: async () => Promise.reject(new Error('Jev 503')) });
    expect(await failing.compact()).toBeUndefined();
    expect(failing.notes[0]).toMatch(/Pi summarizes instead \(Jev 503\)/);

    const keepsAll = load(env, asker({}));
    expect(await keepsAll.compact()).toBeUndefined();
    expect(keepsAll.notes[0]).toMatch(/Jev found nothing stale to cut; Pi summarizes instead/);

    // Only a.ts goes: 200k tokens shrink to ~100k, still over half of the ~84k threshold.
    const tooLarge = load(env, asker({ t1: { call: 0.1, result: 0.1 } }));
    expect(await tooLarge.compact('manual', preparation({ tokensBefore: 200_000 }))).toBeUndefined();
    expect(tooLarge.notes[0]).toMatch(/would leave ~\d+k tokens, over 50% of Pi's ~84k compaction threshold; Pi summarizes instead/);
  });

  it('compacts a context past the window Pi assumes, when Jev cuts it well', async () => {
    // Long tool outputs, as in a real session: 366k tokens on a window Pi takes for 272k.
    const heavy = messagesOf([
      user('u1', 'Fix the failing test.'),
      assistant('a1', [toolCall('c1', 'read', { path: 'src/a.ts' })]),
      toolResult('r1', 'c1', fileA.repeat(40)),
      assistant('a3', [toolCall('c3', 'read', { path: 'src/b.ts' })]),
      toolResult('r3', 'c3', fileB.repeat(40)),
    ]);
    const ext = load(env, asker(dropEverything), 272_000);
    const result = await ext.compact('manual', preparation({ tokensBefore: 366_000, messagesToSummarize: heavy }));
    expect(result?.compaction).toBeDefined();
    expect(ext.notes[0]).toMatch(/context ~366k → ~\d+k tokens/);
  });

  it("says so when the context is already past the window Pi assumes", async () => {
    // Jev cuts little (only a.ts) from a 300k context Pi thinks cannot exceed 272k.
    const ext = load(env, asker({ t1: { call: 0.1, result: 0.1 } }), 272_000);
    expect(await ext.compact('manual', preparation({ tokensBefore: 300_000 }))).toBeUndefined();
    expect(ext.notes[0]).toMatch(
      /Pi summarizes instead\. The context \(~300k tokens\) is already past Pi's ~272k window for this model, so that window looks too small; see "When Pi's context window is wrong" in the README$/,
    );

    // Within the window, the plain reason is enough.
    const fits = load(env, asker({ t1: { call: 0.1, result: 0.1 } }));
    expect(await fits.compact('manual', preparation({ tokensBefore: 90_000 }))).toBeUndefined();
    expect(fits.notes[0]).toMatch(/Pi summarizes instead$/);
  });
});
