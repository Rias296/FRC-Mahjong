import { describe, expect, it } from 'vitest';
import { createTileSet } from './tiles';
import { shuffle } from './shuffle';
import { deal } from './deal';
import type { Seat } from './seats';

describe('cross-module integration: createTileSet -> shuffle -> deal', () => {
  it('end-to-end produces 4 hands of 16 + 80 remaining wall tiles, all 144 accounted for with no duplicates', () => {
    const seed = 20240713;
    const dealer: Seat = 1;
    const wall = shuffle(createTileSet(), seed);
    const result = deal(wall, dealer);

    expect(result.hands).toHaveLength(4);
    for (const hand of result.hands) {
      expect(hand).toHaveLength(16);
    }
    expect(result.wall).toHaveLength(80);

    const allIds = [
      ...result.hands.flatMap((h) => h.map((t) => t.id)),
      ...result.wall.map((t) => t.id),
    ];
    expect(allIds).toHaveLength(144);

    const uniqueIds = new Set(allIds);
    expect(uniqueIds.size).toBe(144);

    // Every id from the original 144-tile set must appear exactly once across
    // hands + remaining wall.
    const originalIds = new Set(createTileSet().map((t) => t.id));
    expect(uniqueIds).toEqual(originalIds);
  });

  it('is fully deterministic end-to-end for a fixed seed and dealer', () => {
    const seed = 555;
    const dealer: Seat = 3;

    const run = () => {
      const wall = shuffle(createTileSet(), seed);
      return deal(wall, dealer);
    };

    const first = run();
    const second = run();

    expect(first.hands.map((h) => h.map((t) => t.id))).toEqual(
      second.hands.map((h) => h.map((t) => t.id)),
    );
    expect(first.wall.map((t) => t.id)).toEqual(second.wall.map((t) => t.id));
  });

  it('different seeds produce different deals (hands differ) for the same dealer', () => {
    const dealer: Seat = 0;
    const wallA = shuffle(createTileSet(), 1);
    const wallB = shuffle(createTileSet(), 2);
    const resultA = deal(wallA, dealer);
    const resultB = deal(wallB, dealer);

    expect(resultA.hands[0].map((t) => t.id)).not.toEqual(
      resultB.hands[0].map((t) => t.id),
    );
  });
});
