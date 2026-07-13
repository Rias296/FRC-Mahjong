import { describe, expect, it } from 'vitest';
import { createTileSet } from './tiles';
import { shuffle } from './shuffle';

describe('shuffle', () => {
  it('same seed produces the same order', () => {
    const tiles = createTileSet();
    const a = shuffle(tiles, 42);
    const b = shuffle(tiles, 42);
    expect(a.map((t) => t.id)).toEqual(b.map((t) => t.id));
  });

  it('different seeds produce different orders (seeds 0 vs 1, 1 vs 2)', () => {
    const tiles = createTileSet();
    const s0 = shuffle(tiles, 0).map((t) => t.id);
    const s1 = shuffle(tiles, 1).map((t) => t.id);
    const s2 = shuffle(tiles, 2).map((t) => t.id);
    expect(s0).not.toEqual(s1);
    expect(s1).not.toEqual(s2);
  });

  it('preserves the exact multiset of tiles (sorted ids equal)', () => {
    const tiles = createTileSet();
    const shuffled = shuffle(tiles, 7);
    const original = tiles.map((t) => t.id).sort();
    const result = shuffled.map((t) => t.id).sort();
    expect(result).toEqual(original);
  });

  it('does not mutate the input array', () => {
    const tiles = createTileSet();
    const originalIds = tiles.map((t) => t.id);
    shuffle(tiles, 123);
    expect(tiles.map((t) => t.id)).toEqual(originalIds);
  });

  // --- Adversarial: statistical sanity, not just "different from input" ---
  it('is not an identity permutation: not all tiles remain at their original index', () => {
    const tiles = createTileSet();
    const shuffled = shuffle(tiles, 42);
    const samePosition = tiles.filter((t, i) => t.id === shuffled[i].id).length;
    expect(samePosition).toBeLessThan(tiles.length);
  });

  it('looks genuinely permuted, not identity and not simple reversal: fewer than half the tiles stay at their original index across several seeds', () => {
    const tiles = createTileSet();
    for (const seed of [1, 2, 3, 4, 5]) {
      const shuffled = shuffle(tiles, seed);
      const samePositionCount = tiles.filter((t, i) => t.id === shuffled[i].id).length;
      expect(samePositionCount).toBeLessThan(tiles.length / 2);

      // Also rule out a degenerate "simple reversal" pattern.
      const reversedMatchCount = tiles.filter(
        (t, i) => t.id === shuffled[tiles.length - 1 - i].id,
      ).length;
      expect(reversedMatchCount).toBeLessThan(tiles.length / 2);
    }
  });

  it('distributes each original tile across a spread of destination indices over many seeds (no fixed-position bias)', () => {
    const tiles = createTileSet();
    const originalIndexOfFirstTile = 0;
    const destinationIndices = new Set<number>();
    for (let seed = 0; seed < 30; seed++) {
      const shuffled = shuffle(tiles, seed);
      const destIndex = shuffled.findIndex((t) => t.id === tiles[originalIndexOfFirstTile].id);
      destinationIndices.add(destIndex);
    }
    // A healthy shuffle should land the same source tile in many different
    // destination slots across 30 different seeds, not collapse to one or two.
    expect(destinationIndices.size).toBeGreaterThan(10);
  });
});
