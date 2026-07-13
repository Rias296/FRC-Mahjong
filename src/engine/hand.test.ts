import { describe, expect, it } from 'vitest';
import { canWin, findDecomposition, waitingTiles } from './hand';
import {
  HAND_TILE_KINDS,
  kindKey,
  type DragonName,
  type FlowerNumber,
  type Rank,
  type SuitName,
  type Tile,
  type TileKind,
  type WindName,
} from './tiles';

// --- Test-local shorthand tile builder ---
// Suit tiles: 'wan1'..'wan9', 'tong1'..'tong9', 'tiao1'..'tiao9'.
// Honors: 'east' | 'south' | 'west' | 'north' | 'red' | 'green' | 'white'.
// Flowers (flower-rejection tests only): 'flower1'..'flower4', 'season1'..'season4'.
const WINDS: readonly WindName[] = ['east', 'south', 'west', 'north'];
const DRAGONS: readonly DragonName[] = ['red', 'green', 'white'];

function kindFromSpec(spec: string): TileKind {
  const suitMatch = /^(wan|tong|tiao)([1-9])$/.exec(spec);
  if (suitMatch) {
    return {
      category: 'suit',
      suit: suitMatch[1] as SuitName,
      rank: Number(suitMatch[2]) as Rank,
    };
  }
  if ((WINDS as readonly string[]).includes(spec)) {
    return { category: 'wind', wind: spec as WindName };
  }
  if ((DRAGONS as readonly string[]).includes(spec)) {
    return { category: 'dragon', dragon: spec as DragonName };
  }
  const flowerMatch = /^flower([1-4])$/.exec(spec);
  if (flowerMatch) {
    return { category: 'flower', series: 'flower', number: Number(flowerMatch[1]) as FlowerNumber };
  }
  const seasonMatch = /^season([1-4])$/.exec(spec);
  if (seasonMatch) {
    return { category: 'flower', series: 'season', number: Number(seasonMatch[1]) as FlowerNumber };
  }
  throw new Error(`Unknown tile spec: ${spec}`);
}

let idCounter = 0;

function tile(spec: string): Tile {
  const kind = kindFromSpec(spec);
  idCounter += 1;
  return { id: `${kindKey(kind)}-test${idCounter}`, kind };
}

function hand(...specs: string[]): Tile[] {
  return specs.map(tile);
}

function kindOf(spec: string): TileKind {
  return kindFromSpec(spec);
}

function indexOfHandKind(kind: TileKind): number {
  return HAND_TILE_KINDS.findIndex((k) => kindKey(k) === kindKey(kind));
}

describe('canWin', () => {
  it('returns true for a 16-tile concealed hand plus candidate forming exactly 5 sets + 1 pair (fixedMeldCount 0)', () => {
    const concealed = hand(
      'wan1', 'wan2', 'wan3', 'wan4', 'wan5', 'wan6', 'wan7', 'wan8', 'wan9',
      'tong1', 'tong2', 'tong3',
      'tiao1', 'tiao1', 'tiao1',
      'east',
    );
    const candidate = tile('east');
    expect(canWin(concealed, 0, candidate)).toBe(true);
  });

  it('returns false for a 16-tile hand plus candidate that is one tile off a winning shape', () => {
    const concealed = hand(
      'wan1', 'wan2', 'wan3', 'wan4', 'wan5', 'wan6', 'wan7', 'wan8', 'wan9',
      'tong1', 'tong2', 'tong3',
      'tiao1', 'tiao1', 'tiao1',
      'east',
    );
    const candidate = tile('south');
    expect(canWin(concealed, 0, candidate)).toBe(false);
  });

  it('returns true for a multi-interpretation hand (wan 111222333 + pung + pung + pair-completing candidate)', () => {
    const concealed = hand(
      'wan1', 'wan1', 'wan1', 'wan2', 'wan2', 'wan2', 'wan3', 'wan3', 'wan3',
      'tong5', 'tong5', 'tong5',
      'tiao7', 'tiao7', 'tiao7',
      'east',
    );
    const candidate = tile('east');
    expect(canWin(concealed, 0, candidate)).toBe(true);
  });

  it('returns true for an all-pung hand (5 pungs + pair)', () => {
    const concealed = hand(
      'wan1', 'wan1', 'wan1',
      'wan9', 'wan9', 'wan9',
      'tong1', 'tong1', 'tong1',
      'tiao1', 'tiao1', 'tiao1',
      'east', 'east', 'east',
      'south',
    );
    const candidate = tile('south');
    expect(canWin(concealed, 0, candidate)).toBe(true);
  });

  it('never forms chows from honors (consecutive winds/dragons are not a set)', () => {
    const concealed = hand(
      'wan1', 'wan2', 'wan3', 'wan4', 'wan5', 'wan6', 'wan7', 'wan8', 'wan9',
      'tong1', 'tong1', 'tong1',
      'east', 'south', 'west', 'north',
    );
    const candidate = tile('north');
    expect(canWin(concealed, 0, candidate)).toBe(false);
  });

  it('rejects wraparound chow 8-9-1 within a suit', () => {
    const concealed = hand(
      'tong1', 'tong2', 'tong3', 'tong4', 'tong5', 'tong6', 'tong7', 'tong8', 'tong9',
      'tiao1', 'tiao1', 'tiao1',
      'red', 'red',
      'wan8', 'wan9',
    );
    const candidate = tile('wan1');
    expect(canWin(concealed, 0, candidate)).toBe(false);
  });

  it('rejects a run spanning suit boundaries (tiao-9, wan-1, wan-2)', () => {
    const concealed = hand(
      'tong1', 'tong2', 'tong3', 'tong4', 'tong5', 'tong6', 'tong7', 'tong8', 'tong9',
      'tiao1', 'tiao1', 'tiao1',
      'red', 'red',
      'tiao9', 'wan1',
    );
    const candidate = tile('wan2');
    expect(canWin(concealed, 0, candidate)).toBe(false);
  });

  it('accepts the top edge chow 7-8-9', () => {
    const concealed = hand(
      'tong1', 'tong2', 'tong3', 'tong4', 'tong5', 'tong6', 'tong7', 'tong8', 'tong9',
      'tiao1', 'tiao1', 'tiao1',
      'red', 'red',
      'wan7', 'wan8',
    );
    const candidate = tile('wan9');
    expect(canWin(concealed, 0, candidate)).toBe(true);
  });

  it('handles fixedMeldCount 1 through 4 (concealed 13/10/7/4 tiles + candidate)', () => {
    // fixedMeldCount 1: concealed 13 tiles, 4 sets + pair needed
    const concealed1 = hand(
      'tong1', 'tong2', 'tong3', 'tong4', 'tong5', 'tong6', 'tong7', 'tong8', 'tong9',
      'tiao1', 'tiao1', 'tiao1',
      'red',
    );
    expect(canWin(concealed1, 1, tile('red'))).toBe(true);

    // fixedMeldCount 2: concealed 10 tiles, 3 sets + pair needed
    const concealed2 = hand(
      'tong1', 'tong2', 'tong3', 'tong4', 'tong5', 'tong6', 'tong7', 'tong8', 'tong9',
      'green',
    );
    expect(canWin(concealed2, 2, tile('green'))).toBe(true);

    // fixedMeldCount 3: concealed 7 tiles, 2 sets + pair needed
    const concealed3 = hand('tong1', 'tong2', 'tong3', 'tong4', 'tong5', 'tong6', 'white');
    expect(canWin(concealed3, 3, tile('white'))).toBe(true);

    // fixedMeldCount 4: concealed 4 tiles, 1 set + pair needed
    const concealed4 = hand('tong1', 'tong2', 'tong3', 'east');
    expect(canWin(concealed4, 4, tile('east'))).toBe(true);
  });

  it('handles fixedMeldCount 5: single concealed tile wins iff candidate matches it as the pair', () => {
    const concealed = hand('east');
    expect(canWin(concealed, 5, tile('east'))).toBe(true);
    expect(canWin(concealed, 5, tile('south'))).toBe(false);
  });

  it('throws when concealedTiles.length !== 16 - 3 * fixedMeldCount', () => {
    const concealed = hand(
      'wan1', 'wan2', 'wan3', 'wan4', 'wan5', 'wan6', 'wan7', 'wan8', 'wan9',
      'tong1', 'tong2', 'tong3',
      'tiao1', 'tiao1', 'tiao1',
    ); // 15 tiles, not 16
    expect(() => canWin(concealed, 0, tile('east'))).toThrow();
  });

  it('throws when fixedMeldCount is not an integer in 0..5', () => {
    const concealed = hand('east');
    expect(() => canWin(concealed, -1, tile('east'))).toThrow();
    expect(() => canWin(concealed, 6, tile('east'))).toThrow();
    expect(() => canWin(concealed, 2.5, tile('east'))).toThrow();
    expect(() => canWin(concealed, Number.NaN, tile('east'))).toThrow();
  });

  it('throws when a flower appears in concealedTiles or as the candidate', () => {
    const validConcealed = hand(
      'wan1', 'wan2', 'wan3', 'wan4', 'wan5', 'wan6', 'wan7', 'wan8', 'wan9',
      'tong1', 'tong2', 'tong3',
      'tiao1', 'tiao1', 'tiao1',
      'east',
    );
    const withFlower = [...validConcealed.slice(0, 15), tile('flower1')];
    expect(() => canWin(withFlower, 0, tile('east'))).toThrow();
    expect(() => canWin(validConcealed, 0, tile('season2'))).toThrow();
  });

  it('does not mutate its input arrays', () => {
    const concealed = hand(
      'wan1', 'wan2', 'wan3', 'wan4', 'wan5', 'wan6', 'wan7', 'wan8', 'wan9',
      'tong1', 'tong2', 'tong3',
      'tiao1', 'tiao1', 'tiao1',
      'east',
    );
    const candidate = tile('east');
    const concealedIdsBefore = concealed.map((t) => t.id);
    const candidateIdBefore = candidate.id;

    canWin(concealed, 0, candidate);

    expect(concealed.map((t) => t.id)).toEqual(concealedIdsBefore);
    expect(candidate.id).toBe(candidateIdBefore);
  });

  it('is order-insensitive: shuffled copies of the same hand give the same result', () => {
    const concealed = hand(
      'wan1', 'wan2', 'wan3', 'wan4', 'wan5', 'wan6', 'wan7', 'wan8', 'wan9',
      'tong1', 'tong2', 'tong3',
      'tiao1', 'tiao1', 'tiao1',
      'east',
    );
    const candidate = tile('east');

    const reversed = [...concealed].reverse();
    const shuffled = [...concealed].sort((a, b) => (a.id < b.id ? 1 : -1));

    expect(canWin(concealed, 0, candidate)).toBe(true);
    expect(canWin(reversed, 0, candidate)).toBe(true);
    expect(canWin(shuffled, 0, candidate)).toBe(true);
  });

  it('treats a concealed 4-of-a-kind as pung + spare (spare must fit elsewhere; no implicit kong)', () => {
    const concealed = hand(
      'wan1', 'wan1', 'wan1', 'wan1', 'wan2', 'wan3',
      'tong1', 'tong2', 'tong3', 'tong4', 'tong5', 'tong6', 'tong7', 'tong8', 'tong9',
      'red',
    );
    const candidate = tile('red');
    expect(canWin(concealed, 0, candidate)).toBe(true);
  });
});

describe('findDecomposition', () => {
  it('returned sets and pair partition the input tiles exactly by id', () => {
    const tiles = hand(
      'wan1', 'wan2', 'wan3', 'wan4', 'wan5', 'wan6', 'wan7', 'wan8', 'wan9',
      'tong1', 'tong2', 'tong3',
      'tiao1', 'tiao1', 'tiao1',
      'east', 'east',
    );
    const decomposition = findDecomposition(tiles, 5);
    expect(decomposition).not.toBeNull();
    const outputIds = [
      ...decomposition!.sets.flatMap((s) => s.tiles.map((t) => t.id)),
      ...decomposition!.pair.map((t) => t.id),
    ].sort();
    const inputIds = tiles.map((t) => t.id).sort();
    expect(outputIds).toEqual(inputIds);
  });

  it('returns null when no decomposition exists', () => {
    const tiles = hand(
      'wan1', 'wan3', 'wan5', 'wan7', 'wan9',
      'tong1', 'tong3', 'tong5', 'tong7', 'tong9',
      'tiao1', 'tiao3', 'tiao5', 'tiao7', 'tiao9',
      'east', 'south',
    );
    expect(findDecomposition(tiles, 5)).toBeNull();
  });

  it('pair is always two tiles of identical kindKey', () => {
    const tiles = hand(
      'wan1', 'wan2', 'wan3', 'wan4', 'wan5', 'wan6', 'wan7', 'wan8', 'wan9',
      'tong1', 'tong2', 'tong3',
      'tiao1', 'tiao1', 'tiao1',
      'east', 'east',
    );
    const decomposition = findDecomposition(tiles, 5);
    expect(decomposition).not.toBeNull();
    expect(kindKey(decomposition!.pair[0].kind)).toBe(kindKey(decomposition!.pair[1].kind));
  });

  it('emitted sets are only chow or pung, never kong', () => {
    const tiles = hand(
      'wan1', 'wan1', 'wan1', 'wan1', 'wan2', 'wan3',
      'tong1', 'tong2', 'tong3', 'tong4', 'tong5', 'tong6', 'tong7', 'tong8', 'tong9',
      'red', 'red',
    );
    const decomposition = findDecomposition(tiles, 5);
    expect(decomposition).not.toBeNull();
    for (const set of decomposition!.sets) {
      expect(['chow', 'pung']).toContain(set.kind);
    }
  });

  it('never emits a chow containing an honor tile (adversarial honor-heavy hand)', () => {
    const tiles = hand(
      'east', 'east', 'east',
      'south', 'south', 'south',
      'west', 'west', 'west',
      'north', 'north', 'north',
      'wan1', 'wan2', 'wan3',
      'red', 'red',
    );
    const decomposition = findDecomposition(tiles, 5);
    expect(decomposition).not.toBeNull();
    for (const set of decomposition!.sets) {
      if (set.kind === 'chow') {
        for (const t of set.tiles) {
          expect(t.kind.category).toBe('suit');
        }
      }
    }
  });

  it('throws when tiles.length !== 3 * setsNeeded + 2', () => {
    const tiles = hand('wan1', 'wan2', 'wan3');
    expect(() => findDecomposition(tiles, 5)).toThrow();
  });
});

describe('waitingTiles', () => {
  it('pair wait: 5 complete concealed sets + 1 lone tile waits on exactly that kind (fixedMeldCount 0)', () => {
    const concealed = hand(
      'tong1', 'tong2', 'tong3', 'tong4', 'tong5', 'tong6', 'tong7', 'tong8', 'tong9',
      'tiao1', 'tiao1', 'tiao1',
      'red', 'red', 'red',
      'wan9',
    );
    const result = waitingTiles(concealed, 0);
    expect(result).toEqual([kindOf('wan9')]);
  });

  it('two-sided wait returns both kinds', () => {
    const concealed = hand(
      'tong1', 'tong1', 'tong1',
      'tiao2', 'tiao3', 'tiao4',
      'tiao5', 'tiao6', 'tiao7',
      'east', 'east', 'east',
      'west', 'west',
      'wan4', 'wan5',
    );
    const result = waitingTiles(concealed, 0);
    expect(result).toEqual([kindOf('wan3'), kindOf('wan6')]);
  });

  it('returns [] for a non-tenpai hand', () => {
    const concealed = hand(
      'wan1', 'wan3', 'wan5', 'wan7', 'wan9',
      'tong1', 'tong3', 'tong5', 'tong7', 'tong9',
      'tiao1', 'tiao3', 'tiao5', 'tiao7', 'tiao9',
      'east',
    );
    expect(waitingTiles(concealed, 0)).toEqual([]);
  });

  it('excludes a kind whose 4 copies are all in the concealed hand', () => {
    const concealed = hand(
      'wan1', 'wan1', 'wan1', 'wan1',
      'tong1', 'tong2', 'tong3',
      'tong4', 'tong5', 'tong6',
      'tong7', 'tong8', 'tong9',
      'tiao1', 'tiao1', 'tiao1',
    );
    expect(waitingTiles(concealed, 0)).toEqual([]);
  });

  it('pure pair wait at fixedMeldCount 5 returns the lone tile\'s kind', () => {
    const concealed = hand('east');
    expect(waitingTiles(concealed, 5)).toEqual([kindOf('east')]);
  });

  it('handles fixedMeldCount 1-4 with correct waits on hand-constructed shapes', () => {
    const concealed1 = hand(
      'tong1', 'tong2', 'tong3', 'tong4', 'tong5', 'tong6', 'tong7', 'tong8', 'tong9',
      'tiao1', 'tiao1', 'tiao1',
      'red',
    );
    expect(waitingTiles(concealed1, 1)).toEqual([kindOf('red')]);

    const concealed2 = hand(
      'tong1', 'tong2', 'tong3', 'tong4', 'tong5', 'tong6', 'tong7', 'tong8', 'tong9',
      'green',
    );
    expect(waitingTiles(concealed2, 2)).toEqual([kindOf('green')]);

    const concealed3 = hand('tong1', 'tong2', 'tong3', 'tong4', 'tong5', 'tong6', 'white');
    expect(waitingTiles(concealed3, 3)).toEqual([kindOf('white')]);

    const concealed4 = hand('tong1', 'tong2', 'tong3', 'east');
    expect(waitingTiles(concealed4, 4)).toEqual([kindOf('east')]);
  });

  it('multi-kind wait (3+ waiting kinds) on a known hand shape returns the exact set', () => {
    const concealed = hand(
      'tong1', 'tong2', 'tong3', 'tong4', 'tong5', 'tong6', 'tong7', 'tong8', 'tong9',
      'red', 'red',
      'wan3', 'wan4', 'wan5', 'wan6', 'wan7',
    );
    const result = waitingTiles(concealed, 0);
    expect(result).toEqual([kindOf('wan2'), kindOf('wan5'), kindOf('wan8')]);
  });

  it('result is deduped and in HAND_TILE_KINDS canonical order', () => {
    const concealed = hand(
      'tong1', 'tong2', 'tong3', 'tong4', 'tong5', 'tong6', 'tong7', 'tong8', 'tong9',
      'red', 'red',
      'wan3', 'wan4', 'wan5', 'wan6', 'wan7',
    );
    const result = waitingTiles(concealed, 0);
    const indices = result.map(indexOfHandKind);
    for (let i = 1; i < indices.length; i++) {
      expect(indices[i]).toBeGreaterThan(indices[i - 1]);
    }
    const uniqueKeys = new Set(result.map(kindKey));
    expect(uniqueKeys.size).toBe(result.length);
  });

  it('throws when concealedTiles.length !== 16 - 3 * fixedMeldCount', () => {
    const concealed = hand('east', 'south');
    expect(() => waitingTiles(concealed, 0)).toThrow();
  });

  it('does not mutate its input', () => {
    const concealed = hand(
      'tong1', 'tong2', 'tong3', 'tong4', 'tong5', 'tong6', 'tong7', 'tong8', 'tong9',
      'tiao1', 'tiao1', 'tiao1',
      'red', 'red', 'red',
      'wan9',
    );
    const idsBefore = concealed.map((t) => t.id);
    waitingTiles(concealed, 0);
    expect(concealed.map((t) => t.id)).toEqual(idsBefore);
  });
});
