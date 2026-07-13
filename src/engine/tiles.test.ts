import { describe, expect, it } from 'vitest';
import { createTileSet, HAND_TILE_KINDS, isFlowerTile, kindKey, type Tile, type TileKind } from './tiles';

describe('createTileSet', () => {
  it('generates exactly 144 tiles', () => {
    expect(createTileSet()).toHaveLength(144);
  });

  it('generates correct group counts: 36 wan, 36 tong, 36 tiao, 16 winds, 12 dragons, 4 flowers, 4 seasons', () => {
    const tiles = createTileSet();
    const count = (predicate: (tile: Tile) => boolean) =>
      tiles.filter(predicate).length;

    expect(count((t) => t.kind.category === 'suit' && t.kind.suit === 'wan')).toBe(36);
    expect(count((t) => t.kind.category === 'suit' && t.kind.suit === 'tong')).toBe(36);
    expect(count((t) => t.kind.category === 'suit' && t.kind.suit === 'tiao')).toBe(36);
    expect(count((t) => t.kind.category === 'wind')).toBe(16);
    expect(count((t) => t.kind.category === 'dragon')).toBe(12);
    expect(count((t) => t.kind.category === 'flower' && t.kind.series === 'flower')).toBe(4);
    expect(count((t) => t.kind.category === 'flower' && t.kind.series === 'season')).toBe(4);
  });

  it('every suit rank has exactly 4 copies', () => {
    const tiles = createTileSet();
    const suits = ['wan', 'tong', 'tiao'] as const;
    for (const suit of suits) {
      for (let rank = 1; rank <= 9; rank++) {
        const matches = tiles.filter(
          (t) => t.kind.category === 'suit' && t.kind.suit === suit && t.kind.rank === rank,
        );
        expect(matches).toHaveLength(4);
      }
    }
  });

  it('every wind and dragon has exactly 4 copies', () => {
    const tiles = createTileSet();
    const winds = ['east', 'south', 'west', 'north'] as const;
    const dragons = ['red', 'green', 'white'] as const;
    for (const wind of winds) {
      expect(tiles.filter((t) => t.kind.category === 'wind' && t.kind.wind === wind)).toHaveLength(4);
    }
    for (const dragon of dragons) {
      expect(tiles.filter((t) => t.kind.category === 'dragon' && t.kind.dragon === dragon)).toHaveLength(4);
    }
  });

  it('flowers and seasons are 8 unique tiles numbered 1-4 in each series', () => {
    const tiles = createTileSet();
    const flowers = tiles.filter((t) => t.kind.category === 'flower');
    expect(flowers).toHaveLength(8);

    const flowerSeries = flowers.filter((t) => t.kind.category === 'flower' && t.kind.series === 'flower');
    const seasonSeries = flowers.filter((t) => t.kind.category === 'flower' && t.kind.series === 'season');
    expect(flowerSeries.map((t) => (t.kind as { number: number }).number).sort()).toEqual([1, 2, 3, 4]);
    expect(seasonSeries.map((t) => (t.kind as { number: number }).number).sort()).toEqual([1, 2, 3, 4]);

    const ids = new Set(flowers.map((t) => t.id));
    expect(ids.size).toBe(8);
  });

  it('all 144 tile ids are unique', () => {
    const tiles = createTileSet();
    const ids = new Set(tiles.map((t) => t.id));
    expect(ids.size).toBe(144);
  });

  it('returns identical ids and order on repeated calls', () => {
    const first = createTileSet();
    const second = createTileSet();
    expect(second.map((t) => t.id)).toEqual(first.map((t) => t.id));
  });

  it('isFlowerTile is true for all 8 flowers/seasons and false for the other 136 tiles', () => {
    const tiles = createTileSet();
    const flowerCount = tiles.filter(isFlowerTile).length;
    const nonFlowerCount = tiles.filter((t) => !isFlowerTile(t)).length;
    expect(flowerCount).toBe(8);
    expect(nonFlowerCount).toBe(136);
  });

  // --- Adversarial: tile identity collisions across categories ---
  it('no two tiles of different kinds collide on id, even across category boundaries', () => {
    const tiles = createTileSet();
    // Group ids by their "kind signature" (everything except the trailing copy number)
    // is implicitly tested by uniqueness of full ids, but here we explicitly probe
    // cross-category boundary cases that a naive string-concat id scheme could collide on.
    const ids = tiles.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);

    // Specific adversarial pairs that a fragile concatenation scheme might confuse:
    // e.g. suit 'wan' rank 1 copy 1 vs a hypothetical wind/dragon/flower with the
    // same textual components in a different order.
    const wan1Copy1 = tiles.find(
      (t) => t.kind.category === 'suit' && t.kind.suit === 'wan' && t.kind.rank === 1,
    );
    const eastWindCopy1 = tiles.find((t) => t.kind.category === 'wind' && t.kind.wind === 'east');
    const redDragonCopy1 = tiles.find((t) => t.kind.category === 'dragon' && t.kind.dragon === 'red');
    const flower1 = tiles.find(
      (t) => t.kind.category === 'flower' && t.kind.series === 'flower' && t.kind.number === 1,
    );
    const season1 = tiles.find(
      (t) => t.kind.category === 'flower' && t.kind.series === 'season' && t.kind.number === 1,
    );

    expect(wan1Copy1).toBeDefined();
    expect(eastWindCopy1).toBeDefined();
    expect(redDragonCopy1).toBeDefined();
    expect(flower1).toBeDefined();
    expect(season1).toBeDefined();

    const distinctIds = new Set([
      wan1Copy1!.id,
      eastWindCopy1!.id,
      redDragonCopy1!.id,
      flower1!.id,
      season1!.id,
    ]);
    expect(distinctIds.size).toBe(5);
  });

  it('every distinct TileKind value maps to a distinct kindKey (spot check across categories)', () => {
    const sampleKinds: TileKind[] = [
      { category: 'suit', suit: 'wan', rank: 1 },
      { category: 'suit', suit: 'wan', rank: 2 },
      { category: 'suit', suit: 'tong', rank: 1 },
      { category: 'suit', suit: 'tiao', rank: 1 },
      { category: 'wind', wind: 'east' },
      { category: 'wind', wind: 'south' },
      { category: 'dragon', dragon: 'red' },
      { category: 'dragon', dragon: 'green' },
      { category: 'flower', series: 'flower', number: 1 },
      { category: 'flower', series: 'season', number: 1 },
      { category: 'flower', series: 'flower', number: 2 },
    ];

    const keys = sampleKinds.map(kindKey);
    expect(new Set(keys).size).toBe(sampleKinds.length);
  });

  it('kindKey is pure and stable: equal-value kind objects (different references) yield the same key', () => {
    const a: TileKind = { category: 'suit', suit: 'tong', rank: 7 };
    const b: TileKind = { category: 'suit', suit: 'tong', rank: 7 };
    expect(a).not.toBe(b);
    expect(kindKey(a)).toBe(kindKey(b));
  });

  it('full 144-tile set has exactly 42 distinct kindKeys with correct copy counts (27 suit + 4 wind + 3 dragon + 4 flower + 4 season)', () => {
    const tiles = createTileSet();
    const counts = new Map<string, number>();
    for (const t of tiles) {
      const key = kindKey(t.kind);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    // 3 suits * 9 ranks = 27, + 4 winds + 3 dragons + 4 flowers + 4 seasons = 42
    expect(counts.size).toBe(42);

    for (const [key, count] of counts) {
      const isFlowerOrSeasonKey = key.startsWith('flower-') || key.startsWith('season-');
      expect(count).toBe(isFlowerOrSeasonKey ? 1 : 4);
    }
  });

  it('HAND_TILE_KINDS has exactly 34 kinds (27 suit + 4 winds + 3 dragons), no flowers, all kindKeys unique', () => {
    expect(HAND_TILE_KINDS).toHaveLength(34);
    expect(HAND_TILE_KINDS.every((k) => k.category !== 'flower')).toBe(true);

    const suitCount = HAND_TILE_KINDS.filter((k) => k.category === 'suit').length;
    const windCount = HAND_TILE_KINDS.filter((k) => k.category === 'wind').length;
    const dragonCount = HAND_TILE_KINDS.filter((k) => k.category === 'dragon').length;
    expect(suitCount).toBe(27);
    expect(windCount).toBe(4);
    expect(dragonCount).toBe(3);

    const keys = HAND_TILE_KINDS.map(kindKey);
    expect(new Set(keys).size).toBe(34);
  });

  it('HAND_TILE_KINDS order matches the canonical createTileSet kind order', () => {
    const tiles = createTileSet();
    const seenKeys: string[] = [];
    const seen = new Set<string>();
    for (const t of tiles) {
      if (t.kind.category === 'flower') continue;
      const key = kindKey(t.kind);
      if (!seen.has(key)) {
        seen.add(key);
        seenKeys.push(key);
      }
    }
    expect(HAND_TILE_KINDS.map(kindKey)).toEqual(seenKeys);
  });
});
