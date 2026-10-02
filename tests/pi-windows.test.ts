import { describe, expect, it } from 'vitest';
import { correctedModels, createFastJev, WINDOW_FIXES } from '../pi/fast-jev.ts';
import { asker, fakeContext, fakePi } from './pi-fixtures.ts';

const codex = () => [
  { id: 'gpt-5.5', name: 'GPT-5.5', contextWindow: 272_000 },
  { id: 'gpt-6-astra', name: 'GPT-6 Astra', contextWindow: 272_000, maxTokens: 128_000 },
  { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', contextWindow: 272_000 },
  { id: 'gpt-6-luna', name: 'GPT-6 Luna', contextWindow: 1_000_000 },
];

describe('correctedModels', () => {
  it("raises openai-codex's gpt-6 models from the 272k Pi lists to the 1M they are served with", () => {
    const corrected = correctedModels('openai-codex', codex(), WINDOW_FIXES)!;
    expect(corrected.map((m) => [m.id, m.contextWindow])).toEqual([
      ['gpt-5.5', 272_000],
      ['gpt-6-astra', 1_000_000],
      ['gpt-6.1-sol', 1_000_000],
      ['gpt-6-luna', 1_000_000],
    ]);
    // Everything else about a model stays as Pi has it.
    expect(corrected[1]).toEqual({ id: 'gpt-6-astra', name: 'GPT-6 Astra', contextWindow: 1_000_000, maxTokens: 128_000 });
  });

  it('leaves models alone once their window is right, and other providers entirely', () => {
    expect(correctedModels('openai-codex', codex().map((m) => ({ ...m, contextWindow: 1_000_000 })), WINDOW_FIXES)).toBeUndefined();
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

  it('re-registers openai-codex with the corrected windows, once, and says so', async () => {
    const ext = start({}, { 'openai-codex': codex() });
    await ext.sessionStart();
    expect(ext.registered).toHaveLength(1);
    expect(ext.registered[0]!.name).toBe('openai-codex');
    expect((ext.registered[0]!.models as Array<{ id: string; contextWindow: number }>).find((m) => m.id === 'gpt-6-astra')?.contextWindow).toBe(1_000_000);
    expect(ext.notes).toEqual([
      "fast-jev: Pi lists openai-codex gpt-6-astra, gpt-6.1-sol at 272k; using the 1M window they are served with (FAST_JEV_FIX_WINDOWS=0 turns this off)",
    ]);
  });

  it('registers nothing when the windows are already right, the provider is missing, or the fix is off', async () => {
    const right = start({}, { 'openai-codex': codex().map((m) => ({ ...m, contextWindow: 1_000_000 })) });
    await right.sessionStart();
    const missing = start({}, {});
    await missing.sessionStart();
    const off = start({ FAST_JEV_FIX_WINDOWS: '0' }, { 'openai-codex': codex() });
    await off.sessionStart();
    expect([...right.registered, ...missing.registered, ...off.registered]).toEqual([]);
    expect([...right.notes, ...missing.notes, ...off.notes]).toEqual([]);
  });
});
