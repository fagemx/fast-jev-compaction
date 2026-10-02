import { describe, expect, it } from 'vitest';
import { correctedModels, createFastJev, WINDOW_FIXES } from '../pi/fast-jev.ts';
import { asker, fakeContext, fakePi } from './pi-fixtures.ts';

const codex = () => [
  { id: 'gpt-5.3-codex-spark', name: 'GPT-5.3 Codex Spark', contextWindow: 128_000 },
  { id: 'gpt-5.5', name: 'GPT-5.5', contextWindow: 272_000 },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', contextWindow: 272_000 },
  { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', contextWindow: 272_000 },
  { id: 'gpt-6-astra', name: 'GPT-6 Astra', contextWindow: 272_000, maxTokens: 128_000 },
  { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', contextWindow: 272_000 },
  { id: 'gpt-6-luna', name: 'GPT-6 Luna', contextWindow: 500_000 },
];

describe('correctedModels', () => {
  it("opens openai-codex's gpt-5.6 and gpt-6 models from the 272k default to Codex's 872k maximum, gpt-5.5 not", () => {
    const corrected = correctedModels('openai-codex', codex(), WINDOW_FIXES)!;
    expect(corrected.map((m) => [m.id, m.contextWindow])).toEqual([
      ['gpt-5.3-codex-spark', 128_000],
      ['gpt-5.5', 272_000],
      ['gpt-5.6-luna', 872_000],
      ['gpt-5.6-terra', 872_000],
      ['gpt-6-astra', 872_000],
      ['gpt-6.1-sol', 872_000],
      // A window someone already set is theirs.
      ['gpt-6-luna', 500_000],
    ]);
    // Everything else about a model stays as Pi has it.
    expect(corrected[4]).toEqual({ id: 'gpt-6-astra', name: 'GPT-6 Astra', contextWindow: 872_000, maxTokens: 128_000 });
  });

  it('leaves models alone once their window is set, and other providers entirely', () => {
    expect(correctedModels('openai-codex', codex().map((m) => ({ ...m, contextWindow: 872_000 })), WINDOW_FIXES)).toBeUndefined();
    expect(correctedModels('openrouter', codex(), WINDOW_FIXES)).toBeUndefined();
  });
});

describe('the Pi extension at session start', () => {
  function start(env: Record<string, string>, providers: Record<string, Array<{ id: string; contextWindow?: number }>>) {
    const { pi, handlers, registered } = fakePi();
    createFastJev(env, () => asker({}))(pi);
    const notes: string[] = [];
    return {
      notes,
      registered,
      async sessionStart() {
        await handlers.get('session_start')!({ type: 'session_start' } as never, fakeContext({ notes, providers }));
      },
    };
  }

  it("keeps Pi's 272k by default, as Pi and Codex do", async () => {
    const ext = start({}, { 'openai-codex': codex() });
    await ext.sessionStart();
    expect(ext.registered).toEqual([]);
    expect(ext.notes).toEqual([]);
  });

  it('opens the long context with FAST_JEV_LONG_CONTEXT, once, and says what it costs', async () => {
    const ext = start({ FAST_JEV_LONG_CONTEXT: '1' }, { 'openai-codex': codex() });
    await ext.sessionStart();
    expect(ext.registered).toHaveLength(1);
    expect(ext.registered[0]!.name).toBe('openai-codex');
    expect((ext.registered[0]!.models as Array<{ id: string; contextWindow: number }>).find((m) => m.id === 'gpt-6-astra')?.contextWindow).toBe(872_000);
    expect(ext.notes).toEqual([
      'fast-jev: FAST_JEV_LONG_CONTEXT is on: openai-codex gpt-5.6-luna, gpt-5.6-terra, gpt-6-astra, gpt-6.1-sol ' +
        "use Codex's 872k maximum instead of 272k; requests past 272k are billed 2x input, 1.5x output",
    ]);
  });

  it('registers nothing with the long context on when the windows are already open or the provider is missing', async () => {
    const open = start({ FAST_JEV_LONG_CONTEXT: 'true' }, { 'openai-codex': codex().map((m) => ({ ...m, contextWindow: 872_000 })) });
    await open.sessionStart();
    const missing = start({ FAST_JEV_LONG_CONTEXT: '1' }, {});
    await missing.sessionStart();
    expect([...open.registered, ...missing.registered]).toEqual([]);
    expect([...open.notes, ...missing.notes]).toEqual([]);
  });
});
