import { describe, expect, it } from 'vitest';
import { abridgeInput, headOf, tailOf, truncate } from '../src/index.js';

const emoji = '\u{1F600}';
const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

describe('code point safe cuts', () => {
  it('backs a head off a surrogate pair it would split, and keeps an aligned one whole', () => {
    expect(headOf(`${'x'.repeat(9)}${emoji}`, 10)).toBe('x'.repeat(9));
    expect(headOf(`${'x'.repeat(8)}${emoji}`, 10)).toBe(`${'x'.repeat(8)}${emoji}`);
    expect(headOf('abc', 0)).toBe('');
  });

  it('moves a tail start past a surrogate pair it would split', () => {
    expect(tailOf(`${emoji}${'x'.repeat(9)}`, 10)).toBe('x'.repeat(9));
    expect(tailOf(`${emoji}${'x'.repeat(8)}`, 10)).toBe(`${emoji}${'x'.repeat(8)}`);
  });

  it('never leaves a lone surrogate in truncated state text or an abridged tool input', () => {
    const text = emoji.repeat(400);
    for (const limit of [1, 2, 3, 99, 100, 101]) {
      expect(truncate(text, limit)).not.toMatch(lone);
      expect(abridgeInput({ content: text }, limit)).not.toMatchObject({ content: expect.stringMatching(lone) });
    }
  });
});
