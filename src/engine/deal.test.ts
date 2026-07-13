import { describe, expect, it } from 'vitest';
import { createTileSet, type Tile } from './tiles';
import { shuffle } from './shuffle';
import type { Wall } from './wall';
import { deal } from './deal';

describe('deal', () => {
  it('deals 4 hands of exactly 16 tiles each', () => {
    const wall: Wall = shuffle(createTileSet(), 1);
    const result = deal(wall, 0);
    for (const hand of result.hands) {
      expect(hand).toHaveLength(16);
    }
  });

  it('dealt tiles and remaining wall partition the input wall with no overlaps (64 + 80)', () => {
    const wall: Wall = shuffle(createTileSet(), 1);
    const result = deal(wall, 0);
    const dealtIds = result.hands.flatMap((hand) => hand.map((t) => t.id));
    expect(dealtIds).toHaveLength(64);
    expect(result.wall).toHaveLength(80);

    const dealtSet = new Set(dealtIds);
    expect(dealtSet.size).toBe(64);

    const remainingIds = result.wall.map((t) => t.id);
    for (const id of remainingIds) {
      expect(dealtSet.has(id)).toBe(false);
    }

    const allIds = new Set([...dealtIds, ...remainingIds]);
    expect(allIds.size).toBe(144);
    expect(allIds).toEqual(new Set(wall.map((t) => t.id)));
  });

  it('dealer receives the first 4 tiles from the head', () => {
    const wall: Wall = shuffle(createTileSet(), 2);
    const result = deal(wall, 0);
    expect(result.hands[0].slice(0, 4)).toEqual(wall.slice(0, 4));
  });

  it('deals in 4 rounds of 4 in turn order starting from the dealer (index pattern check)', () => {
    const tiles: Tile[] = createTileSet();
    const wall: Wall = tiles; // unshuffled, index 0..143
    const dealer = 0;
    const result = deal(wall, dealer);

    // hands[dealer] should be positions {0-3, 16-19, 32-35, 48-51}
    const expectedDealerIndices = [0, 1, 2, 3, 16, 17, 18, 19, 32, 33, 34, 35, 48, 49, 50, 51];
    expect(result.hands[0].map((t) => t.id)).toEqual(expectedDealerIndices.map((i) => wall[i].id));

    // hands[nextSeat(dealer)] = hands[1] should be positions {4-7, 20-23, 36-39, 52-55}
    const expectedSeat1Indices = [4, 5, 6, 7, 20, 21, 22, 23, 36, 37, 38, 39, 52, 53, 54, 55];
    expect(result.hands[1].map((t) => t.id)).toEqual(expectedSeat1Indices.map((i) => wall[i].id));

    // hands[2] should be positions {8-11, 24-27, 40-43, 56-59}
    const expectedSeat2Indices = [8, 9, 10, 11, 24, 25, 26, 27, 40, 41, 42, 43, 56, 57, 58, 59];
    expect(result.hands[2].map((t) => t.id)).toEqual(expectedSeat2Indices.map((i) => wall[i].id));

    // hands[3] should be positions {12-15, 28-31, 44-47, 60-63}
    const expectedSeat3Indices = [12, 13, 14, 15, 28, 29, 30, 31, 44, 45, 46, 47, 60, 61, 62, 63];
    expect(result.hands[3].map((t) => t.id)).toEqual(expectedSeat3Indices.map((i) => wall[i].id));
  });

  it('indexes hands by absolute seat when dealer is not East (dealer = 2)', () => {
    const tiles: Tile[] = createTileSet();
    const wall: Wall = tiles;
    const dealer = 2;
    const result = deal(wall, dealer);

    // Dealer (seat 2) gets the first 4-tile block of each round.
    const expectedDealerIndices = [0, 1, 2, 3, 16, 17, 18, 19, 32, 33, 34, 35, 48, 49, 50, 51];
    expect(result.hands[2].map((t) => t.id)).toEqual(expectedDealerIndices.map((i) => wall[i].id));

    // Turn order after seat 2 is seat 3, then seat 0, then seat 1.
    const expectedSeat3Indices = [4, 5, 6, 7, 20, 21, 22, 23, 36, 37, 38, 39, 52, 53, 54, 55];
    expect(result.hands[3].map((t) => t.id)).toEqual(expectedSeat3Indices.map((i) => wall[i].id));

    const expectedSeat0Indices = [8, 9, 10, 11, 24, 25, 26, 27, 40, 41, 42, 43, 56, 57, 58, 59];
    expect(result.hands[0].map((t) => t.id)).toEqual(expectedSeat0Indices.map((i) => wall[i].id));

    const expectedSeat1Indices = [12, 13, 14, 15, 28, 29, 30, 31, 44, 45, 46, 47, 60, 61, 62, 63];
    expect(result.hands[1].map((t) => t.id)).toEqual(expectedSeat1Indices.map((i) => wall[i].id));
  });

  it('is deterministic for the same input wall', () => {
    const wall: Wall = shuffle(createTileSet(), 5);
    const first = deal(wall, 1);
    const second = deal(wall, 1);
    expect(first.hands.map((h) => h.map((t) => t.id))).toEqual(second.hands.map((h) => h.map((t) => t.id)));
    expect(first.wall.map((t) => t.id)).toEqual(second.wall.map((t) => t.id));
  });

  it('does not mutate the input wall', () => {
    const wall: Wall = shuffle(createTileSet(), 9);
    const originalIds = wall.map((t) => t.id);
    deal(wall, 3);
    expect(wall.map((t) => t.id)).toEqual(originalIds);
  });

  it('throws when the wall has fewer than 64 tiles', () => {
    const wall: Wall = createTileSet().slice(0, 63);
    expect(() => deal(wall, 0)).toThrow();
  });

  // --- Adversarial: dealer at every seat, exact-boundary wall sizes ---
  it('indexes hands correctly when dealer = 1 (turn order wraps South -> West -> North -> East)', () => {
    const wall: Wall = createTileSet();
    const result = deal(wall, 1);

    const expectedDealerIndices = [0, 1, 2, 3, 16, 17, 18, 19, 32, 33, 34, 35, 48, 49, 50, 51];
    expect(result.hands[1].map((t) => t.id)).toEqual(expectedDealerIndices.map((i) => wall[i].id));

    // Turn order after seat 1 is seat 2, then seat 3, then seat 0.
    const expectedSeat2Indices = [4, 5, 6, 7, 20, 21, 22, 23, 36, 37, 38, 39, 52, 53, 54, 55];
    expect(result.hands[2].map((t) => t.id)).toEqual(expectedSeat2Indices.map((i) => wall[i].id));

    const expectedSeat3Indices = [8, 9, 10, 11, 24, 25, 26, 27, 40, 41, 42, 43, 56, 57, 58, 59];
    expect(result.hands[3].map((t) => t.id)).toEqual(expectedSeat3Indices.map((i) => wall[i].id));

    const expectedSeat0Indices = [12, 13, 14, 15, 28, 29, 30, 31, 44, 45, 46, 47, 60, 61, 62, 63];
    expect(result.hands[0].map((t) => t.id)).toEqual(expectedSeat0Indices.map((i) => wall[i].id));
  });

  it('indexes hands correctly when dealer = 3 (turn order wraps North -> East -> South -> West)', () => {
    const wall: Wall = createTileSet();
    const result = deal(wall, 3);

    const expectedDealerIndices = [0, 1, 2, 3, 16, 17, 18, 19, 32, 33, 34, 35, 48, 49, 50, 51];
    expect(result.hands[3].map((t) => t.id)).toEqual(expectedDealerIndices.map((i) => wall[i].id));

    // Turn order after seat 3 is seat 0, then seat 1, then seat 2.
    const expectedSeat0Indices = [4, 5, 6, 7, 20, 21, 22, 23, 36, 37, 38, 39, 52, 53, 54, 55];
    expect(result.hands[0].map((t) => t.id)).toEqual(expectedSeat0Indices.map((i) => wall[i].id));

    const expectedSeat1Indices = [8, 9, 10, 11, 24, 25, 26, 27, 40, 41, 42, 43, 56, 57, 58, 59];
    expect(result.hands[1].map((t) => t.id)).toEqual(expectedSeat1Indices.map((i) => wall[i].id));

    const expectedSeat2Indices = [12, 13, 14, 15, 28, 29, 30, 31, 44, 45, 46, 47, 60, 61, 62, 63];
    expect(result.hands[2].map((t) => t.id)).toEqual(expectedSeat2Indices.map((i) => wall[i].id));
  });

  it('deals cleanly for all 4 possible dealer seats: 4 hands of 16 tiles, correct dealer indexing, no overlap', () => {
    const dealerSeats = [0, 1, 2, 3] as const;
    for (const dealer of dealerSeats) {
      const wall: Wall = shuffle(createTileSet(), 100 + dealer);
      const result = deal(wall, dealer);
      for (const hand of result.hands) {
        expect(hand).toHaveLength(16);
      }
      expect(result.hands[dealer].slice(0, 4)).toEqual(wall.slice(0, 4));

      const dealtIds = result.hands.flatMap((h) => h.map((t) => t.id));
      expect(new Set(dealtIds).size).toBe(64);
      expect(result.wall).toHaveLength(80);
    }
  });

  it('wall of exactly 64 tiles deals cleanly with 0 tiles remaining', () => {
    const wall: Wall = shuffle(createTileSet(), 42).slice(0, 64);
    const result = deal(wall, 0);
    for (const hand of result.hands) {
      expect(hand).toHaveLength(16);
    }
    expect(result.wall).toHaveLength(0);

    const dealtIds = result.hands.flatMap((h) => h.map((t) => t.id));
    expect(new Set(dealtIds).size).toBe(64);
  });

  it('wall of exactly 63 tiles throws (one below the deal boundary)', () => {
    const wall: Wall = shuffle(createTileSet(), 42).slice(0, 63);
    expect(() => deal(wall, 0)).toThrow();
  });
});
