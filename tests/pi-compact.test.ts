import { describe, expect, it } from 'vitest';
import type {
  CompactionPreparation,
  SessionBeforeCompactEvent,
  SessionBeforeCompactResult,
} from '@earendil-works/pi-coding-agent';
import { compactRegion, createFastJev, serializeMessage, type JevEndpoint } from '../pi/fast-jev.ts';
import { resolveHookConfig } from '../hooks/fast-jev.ts';
import type { JevAsker } from '../src/index.js';
import {
  asker,
  assistant,
  dropEverything,
  fakeContext,
  fakePi,
  fileA,
  fileB,
  session,
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
      fileOps: { read: new Set(['src/a.ts', 'src/b.ts']), written: new Set(['src/c.ts']), edited: new Set(['src/b.ts']) },
    });
    expect(run.summary).toContain('<read-files>\nsrc/a.ts\n</read-files>');
    expect(run.summary).toContain('<modified-files>\nsrc/b.ts\nsrc/c.ts\n</modified-files>');
  });
});

describe('the Pi extension on /compact and automatic compaction', () => {
  function preparation(): CompactionPreparation {
    return {
      firstKeptEntryId: 'a4',
      messagesToSummarize: region(),
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 5000,
      fileOps: { read: new Set(['src/a.ts']), written: new Set(), edited: new Set() },
      settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
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
      async compact(reason: SessionBeforeCompactEvent['reason'] = 'manual') {
        const event: SessionBeforeCompactEvent = {
          type: 'session_before_compact',
          preparation: preparation(),
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
    expect(ext.notes[0]).toMatch(/^fast-jev: \/compact by Jev, no LLM summary \(older history: \d+% reduction; 3 calls stubbed; .* kept verbatim\)$/);
  });

  it('serves automatic and overflow compaction the same way', async () => {
    const ext = load(env, asker(dropEverything));
    expect((await ext.compact('threshold'))?.compaction).toBeDefined();
    expect((await ext.compact('overflow'))?.compaction).toBeDefined();
  });

  it("leaves the summary to Pi without a key, when Jev fails, below the minimum or over the size budget", async () => {
    const noKey = load({}, asker(dropEverything));
    expect(await noKey.compact()).toBeUndefined();
    expect(noKey.notes[0]).toMatch(/TYPESAFE_API_KEY is not set/);

    const failing = load(env, { ask: async () => Promise.reject(new Error('Jev 503')) });
    expect(await failing.compact()).toBeUndefined();
    expect(failing.notes[0]).toMatch(/Pi summarizes instead \(Jev 503\)/);

    const keepsAll = load(env, asker({}));
    expect(await keepsAll.compact()).toBeUndefined();
    expect(keepsAll.notes[0]).toMatch(/below the 25% minimum/);

    const tinyWindow = load(env, asker(dropEverything), 100);
    expect(await tinyWindow.compact()).toBeUndefined();
    expect(tinyWindow.notes[0]).toMatch(/over the 25% budget/);
  });
});
