import { describe, expect, it } from 'vitest';
import { createPrng } from './prng';

function drawN(seed: number, n: number): number[] {
  const rand = createPrng(seed);
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(rand());
  return out;
}

describe('createPrng', () => {
  it('produces an identical sequence across two independent calls with the same seed', () => {
    const a = drawN(999, 50);
    const b = drawN(999, 50);
    expect(a).toEqual(b);
  });

  it('produces sequences that diverge within the first few draws for different seeds', () => {
    const a = drawN(1, 5);
    const b = drawN(2, 5);
    // At least one of the first 5 draws must differ.
    const anyDifferent = a.some((v, i) => v !== b[i]);
    expect(anyDifferent).toBe(true);
    // And specifically the very first draw should already differ for adjacent seeds
    // (mulberry32-style generators diverge immediately on the first output).
    expect(a[0]).not.toBe(b[0]);
  });

  it('every draw is within [0, 1)', () => {
    const values = drawN(12345, 500);
    for (const v of values) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('two independent generator closures from createPrng(seed) do not share mutable state', () => {
    const genA = createPrng(7);
    const genB = createPrng(7);
    // Advance genA several steps; genB must be unaffected.
    const advancedA = [genA(), genA(), genA()];
    const freshB = [genB(), genB(), genB()];
    expect(advancedA).toEqual(freshB);
  });
});
