import { describe, expect, it } from 'vitest';
import {
  canAddedKong,
  canChow,
  canConcealedKong,
  canKongFromDiscard,
  canPung,
  isLegalDiscard,
  resolveClaims,
  type ChowOption,
  type Claim,
  type PlayerHand,
  type PlayerMeld,
} from './actions';
import {
  kindKey,
  type DragonName,
  type FlowerNumber,
  type Rank,
  type SuitName,
  type Tile,
  type TileKind,
  type WindName,
} from './tiles';
import type { Seat } from './seats';

// --- Test-local shorthand tile builder (duplicated per-file convention, see hand.test.ts) ---
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

function meld(kind: 'chow' | 'pung' | 'kong', concealed: boolean, ...specs: string[]): PlayerMeld {
  return { kind, concealed, tiles: hand(...specs) };
}

// --- Test-local fixtures ---

/** A 17-tile must-act hand with no melds: legal for isLegalDiscard / canAddedKong / canConcealedKong. */
function baseMustActHand(): { hand: PlayerHand; concealed: Tile[] } {
  const concealed = hand(
    'wan1', 'wan2', 'wan3', 'wan4', 'wan5', 'wan6', 'wan7', 'wan8', 'wan9',
    'tong1', 'tong2', 'tong3',
    'tiao1', 'tiao1', 'tiao1',
    'east', 'south',
  );
  return { hand: { concealedTiles: concealed, melds: [] }, concealed };
}

/** A 16-tile at-rest hand with no melds: legal for canChow / canPung / canKongFromDiscard. */
function baseAtRestHand(): { hand: PlayerHand; concealed: Tile[] } {
  const concealed = hand(
    'wan1', 'wan2', 'wan3', 'wan4', 'wan5', 'wan6', 'wan7', 'wan8', 'wan9',
    'tong1', 'tong2', 'tong3',
    'tiao1', 'tiao1',
    'east', 'south',
  );
  return { hand: { concealedTiles: concealed, melds: [] }, concealed };
}

function dummyChowOption(): ChowOption {
  const t1 = tile('tong4');
  const t2 = tile('tong6');
  const discard = tile('tong5');
  return {
    concealedTilesUsed: [t1, t2],
    meld: { kind: 'chow', tiles: [t1, discard, t2] },
  };
}

describe('PlayerHand validation', () => {
  it('throws when concealedTiles contains a flower tile', () => {
    const concealed = hand(
      'wan1', 'wan2', 'wan3', 'wan4', 'wan5', 'wan6', 'wan7', 'wan8', 'wan9',
      'tong1', 'tong2', 'tong3',
      'tiao1', 'tiao1',
      'east', 'flower1',
    );
    const h: PlayerHand = { concealedTiles: concealed, melds: [] };
    expect(() => canPung(h, tile('south'))).toThrow();
  });

  it('throws when a chow or pung meld is marked concealed', () => {
    const badPung = meld('pung', true, 'tong9', 'tong9', 'tong9');
    const concealed = hand(
      'wan1', 'wan2', 'wan3', 'wan4', 'wan5', 'wan6', 'wan7', 'wan8', 'wan9',
      'tiao1', 'tiao1',
      'east', 'south',
    );
    const h: PlayerHand = { concealedTiles: concealed, melds: [badPung] };
    expect(() => canPung(h, tile('south'))).toThrow();

    const badChow = meld('chow', true, 'tong4', 'tong5', 'tong6');
    const h2: PlayerHand = { concealedTiles: concealed, melds: [badChow] };
    expect(() => canPung(h2, tile('south'))).toThrow();
  });

  it('throws when meld tile counts are wrong (chow/pung !== 3, kong !== 4)', () => {
    const shortChow = meld('chow', false, 'tong4', 'tong5');
    const h1: PlayerHand = { concealedTiles: hand('east', 'south'), melds: [shortChow] };
    expect(() => canPung(h1, tile('north'))).toThrow();

    const shortKong = meld('kong', true, 'tong4', 'tong4', 'tong4');
    const h2: PlayerHand = { concealedTiles: hand('east', 'south'), melds: [shortKong] };
    expect(() => canPung(h2, tile('north'))).toThrow();
  });

  it('claim functions throw when concealed length !== 16 - 3 * meldCount', () => {
    const concealed = hand(
      'wan1', 'wan2', 'wan3', 'wan4', 'wan5', 'wan6', 'wan7', 'wan8', 'wan9',
      'tong1', 'tong2', 'tong3',
      'tiao1', 'tiao1',
      'east', // 15 tiles, not 16
    );
    const h: PlayerHand = { concealedTiles: concealed, melds: [] };
    const discard = tile('south');
    expect(() => canPung(h, discard)).toThrow();
    expect(() => canKongFromDiscard(h, discard)).toThrow();
    expect(() => canChow(h, tile('tong5'), 1 as Seat, 0 as Seat)).toThrow();
  });

  it('own-turn functions throw when concealed length !== 17 - 3 * meldCount', () => {
    const concealed = hand(
      'wan1', 'wan2', 'wan3', 'wan4', 'wan5', 'wan6', 'wan7', 'wan8', 'wan9',
      'tong1', 'tong2', 'tong3',
      'tiao1', 'tiao1',
      'east', 'south', // 16 tiles, not 17
    );
    const h: PlayerHand = { concealedTiles: concealed, melds: [] };
    expect(() => isLegalDiscard(h, concealed[0])).toThrow();
    expect(() => canAddedKong(h)).toThrow();
    expect(() => canConcealedKong(h)).toThrow();
  });
});

describe('isLegalDiscard', () => {
  it('returns true for a tile id present in concealedTiles', () => {
    const { hand: h, concealed } = baseMustActHand();
    expect(isLegalDiscard(h, concealed[15])).toBe(true); // 'south'
  });

  it('returns false for a same-kind tile whose id is not in concealedTiles', () => {
    const { hand: h } = baseMustActHand();
    const otherEast = tile('east');
    expect(isLegalDiscard(h, otherEast)).toBe(false);
  });

  it('returns false for a tile held inside a meld', () => {
    const exposedPung = meld('pung', false, 'tong9', 'tong9', 'tong9');
    const concealed = hand(
      'wan1', 'wan2', 'wan3', 'wan4', 'wan5', 'wan6', 'wan7', 'wan8', 'wan9',
      'tiao1', 'tiao1', 'tiao1',
      'east', 'south',
    ); // 14 tiles = 17 - 3*1
    const h: PlayerHand = { concealedTiles: concealed, melds: [exposedPung] };
    expect(isLegalDiscard(h, exposedPung.tiles[0])).toBe(false);
  });
});

describe('canChow', () => {
  it('returns empty when claimant is not the seat immediately after the discarder', () => {
    const { hand: h } = baseAtRestHandWith('tong3', 'tong4', 'tong6', 'tong7');
    const discard = tile('tong5');
    // discarder = 0 (east); next-in-order is seat 1; claimant here is seat 2.
    expect(canChow(h, discard, 2 as Seat, 0 as Seat)).toEqual([]);
  });

  it('returns only middle and high windows when the low pair is incomplete', () => {
    const { hand: h } = baseAtRestHandWith('tong4', 'tong6', 'tong7');
    const discard = tile('tong5');
    const result = canChow(h, discard, 1 as Seat, 0 as Seat);
    expect(result).toHaveLength(2);
    expect(result.map((o) => o.meld.tiles.map((t) => t.kind))).toEqual([
      [kindOf('tong4'), kindOf('tong5'), kindOf('tong6')],
      [kindOf('tong5'), kindOf('tong6'), kindOf('tong7')],
    ]);
  });

  it('returns all three windows when hand holds r-2,r-1,r+1,r+2', () => {
    const { hand: h } = baseAtRestHandWith('tong3', 'tong4', 'tong6', 'tong7');
    const discard = tile('tong5');
    const result = canChow(h, discard, 1 as Seat, 0 as Seat);
    expect(result).toHaveLength(3);
    expect(result.map((o) => o.meld.tiles.map((t) => t.kind))).toEqual([
      [kindOf('tong3'), kindOf('tong4'), kindOf('tong5')],
      [kindOf('tong4'), kindOf('tong5'), kindOf('tong6')],
      [kindOf('tong5'), kindOf('tong6'), kindOf('tong7')],
    ]);
  });

  it('returns only the upward window for a rank-1 discard and only the downward window for rank-9 (no wraparound)', () => {
    const lowHand = baseAtRestHandWith('tong2', 'tong3').hand;
    const lowResult = canChow(lowHand, tile('tong1'), 1 as Seat, 0 as Seat);
    expect(lowResult).toHaveLength(1);
    expect(lowResult[0].meld.tiles.map((t) => t.kind)).toEqual([kindOf('tong1'), kindOf('tong2'), kindOf('tong3')]);

    const highHand = baseAtRestHandWith('tong7', 'tong8').hand;
    const highResult = canChow(highHand, tile('tong9'), 1 as Seat, 0 as Seat);
    expect(highResult).toHaveLength(1);
    expect(highResult[0].meld.tiles.map((t) => t.kind)).toEqual([kindOf('tong7'), kindOf('tong8'), kindOf('tong9')]);
  });

  it('returns empty for a wind or dragon discard', () => {
    const { hand: h } = baseAtRestHand();
    expect(canChow(h, tile('east'), 1 as Seat, 0 as Seat)).toEqual([]);
    expect(canChow(h, tile('red'), 1 as Seat, 0 as Seat)).toEqual([]);
  });

  it('deduplicates options when the hand holds duplicate copies of a needed rank', () => {
    const { hand: h } = baseAtRestHandWith('tong4', 'tong4', 'tong6');
    const discard = tile('tong5');
    const result = canChow(h, discard, 1 as Seat, 0 as Seat);
    expect(result).toHaveLength(1);
    expect(result[0].meld.tiles.map((t) => t.kind)).toEqual([kindOf('tong4'), kindOf('tong5'), kindOf('tong6')]);
  });

  it('returned meld is a chow of 3 tiles in ascending rank including the discarded tile, and concealedTilesUsed come from the hand', () => {
    const { hand: h, concealed } = baseAtRestHandWith('tong4', 'tong6');
    const discard = tile('tong5');
    const result = canChow(h, discard, 1 as Seat, 0 as Seat);
    expect(result).toHaveLength(1);
    const option = result[0];
    expect(option.meld.kind).toBe('chow');
    expect(option.meld.tiles).toHaveLength(3);
    expect(option.meld.tiles.map((t) => t.id)).toContain(discard.id);
    const concealedIds = new Set(concealed.map((t) => t.id));
    expect(concealedIds.has(option.concealedTilesUsed[0].id)).toBe(true);
    expect(concealedIds.has(option.concealedTilesUsed[1].id)).toBe(true);
  });

  it('throws when the discarded tile is a flower', () => {
    const { hand: h } = baseAtRestHand();
    expect(() => canChow(h, tile('flower1'), 1 as Seat, 0 as Seat)).toThrow();
  });
});

/** Builds an at-rest (16-tile, no-meld) hand containing the given extra suit specs, padded with filler. */
function baseAtRestHandWith(...extraSpecs: string[]): { hand: PlayerHand; concealed: Tile[] } {
  const fillerPool = ['wan1', 'wan2', 'wan3', 'wan7', 'wan8', 'wan9', 'tiao1', 'tiao1', 'tiao1', 'east', 'south', 'west', 'north', 'red', 'green', 'white'];
  const needed = 16 - extraSpecs.length;
  const filler = fillerPool.slice(0, needed);
  const concealed = hand(...extraSpecs, ...filler);
  return { hand: { concealedTiles: concealed, melds: [] }, concealed };
}

describe('canPung', () => {
  it('returns true with exactly two concealed copies', () => {
    const { hand: h } = baseAtRestHandWith('tong5', 'tong5');
    expect(canPung(h, tile('tong5'))).toBe(true);
  });

  it('returns false with one concealed copy plus copies locked in melds', () => {
    const exposedPung = meld('pung', false, 'tong5', 'tong5', 'tong5');
    const concealed = hand(
      'wan1', 'wan2', 'wan3', 'wan4', 'wan5', 'wan6', 'wan7', 'wan8',
      'tiao1', 'tiao1',
      'east', 'south', 'tong5',
    ); // 13 tiles = 16 - 3*1
    const h: PlayerHand = { concealedTiles: concealed, melds: [exposedPung] };
    expect(canPung(h, tile('tong5'))).toBe(false);
  });
});

describe('canKongFromDiscard', () => {
  it('returns true with three concealed copies', () => {
    const { hand: h } = baseAtRestHandWith('tong7', 'tong7', 'tong7');
    expect(canKongFromDiscard(h, tile('tong7'))).toBe(true);
  });

  it('returns false with two concealed copies even when an exposed pung of the same kind exists', () => {
    const exposedPung = meld('pung', false, 'tong7', 'tong7', 'tong7');
    const concealed = hand(
      'wan1', 'wan2', 'wan3', 'wan4', 'wan5', 'wan6', 'wan7',
      'tiao1', 'tiao1',
      'east', 'south', 'tong7', 'tong7',
    ); // 13 tiles = 16 - 3*1
    const h: PlayerHand = { concealedTiles: concealed, melds: [exposedPung] };
    expect(canKongFromDiscard(h, tile('tong7'))).toBe(false);
  });
});

describe('canAddedKong', () => {
  it('returns the pung kind when its 4th copy is concealed', () => {
    const exposedPung = meld('pung', false, 'tong8', 'tong8', 'tong8');
    const concealed = hand(
      'wan1', 'wan2', 'wan3', 'wan4', 'wan5', 'wan6', 'wan7', 'wan8', 'wan9',
      'tiao1', 'tiao1', 'tiao1',
      'east', 'tong8',
    ); // 14 tiles = 17 - 3*1
    const h: PlayerHand = { concealedTiles: concealed, melds: [exposedPung] };
    expect(canAddedKong(h)).toEqual([kindOf('tong8')]);
  });

  it('returns multiple kinds when two exposed pungs are both completable', () => {
    const pungA = meld('pung', false, 'tong8', 'tong8', 'tong8');
    const pungB = meld('pung', false, 'east', 'east', 'east');
    const concealed = hand(
      'wan1', 'wan2', 'wan3', 'wan4', 'wan5', 'wan6', 'wan7', 'wan8', 'wan9',
      'tong8', 'east',
    ); // 11 tiles = 17 - 3*2
    const h: PlayerHand = { concealedTiles: concealed, melds: [pungA, pungB] };
    expect(canAddedKong(h)).toEqual([kindOf('tong8'), kindOf('east')]);
  });

  it('ignores chows and concealed kongs and returns empty when no 4th copy is concealed', () => {
    const chow = meld('chow', false, 'wan1', 'wan2', 'wan3');
    const concealedKong = meld('kong', true, 'tong9', 'tong9', 'tong9', 'tong9');
    const concealed = hand(
      'wan4', 'wan5', 'wan6', 'wan7', 'wan8', 'wan9',
      'tiao1', 'tiao1', 'tiao1',
      'east', 'south',
    ); // 11 tiles = 17 - 3*2
    const h: PlayerHand = { concealedTiles: concealed, melds: [chow, concealedKong] };
    expect(canAddedKong(h)).toEqual([]);
  });
});

describe('canConcealedKong', () => {
  it('returns kinds with all four copies concealed, in canonical order', () => {
    const concealed = hand(
      'tong2', 'tong2', 'tong2', 'tong2',
      'east', 'east', 'east', 'east',
      'wan1', 'wan3', 'wan5', 'wan7', 'wan9', 'tiao1', 'tiao3', 'tiao5', 'tiao7',
    ); // 17 tiles
    const h: PlayerHand = { concealedTiles: concealed, melds: [] };
    expect(canConcealedKong(h)).toEqual([kindOf('tong2'), kindOf('east')]);
  });

  it('excludes kinds with three concealed copies plus one melded copy', () => {
    const chow = meld('chow', false, 'tong2', 'tong3', 'tong4');
    const concealed = hand(
      'tong3', 'tong3', 'tong3',
      'wan1', 'wan2', 'wan4', 'wan5', 'wan6', 'wan7', 'wan8', 'wan9',
      'tiao1', 'tiao3', 'tiao5',
    ); // 14 tiles = 17 - 3*1
    const h: PlayerHand = { concealedTiles: concealed, melds: [chow] };
    expect(canConcealedKong(h)).toEqual([]);
  });
});

describe('resolveClaims', () => {
  it('hu beats kong, pung, and chow regardless of proximity', () => {
    // Only 3 non-discarder seats exist, so kong+pung+chow+hu cannot all be
    // distinct claims in one resolution; split across two claim sets instead.
    const claimsAgainstKongAndPung: Claim[] = [
      { type: 'kong', seat: 1 as Seat },
      { type: 'pung', seat: 2 as Seat },
      { type: 'hu', seat: 3 as Seat },
    ];
    expect(resolveClaims(claimsAgainstKongAndPung, 0 as Seat)).toEqual([{ type: 'hu', seat: 3 as Seat }]);

    const claimsAgainstChow: Claim[] = [
      { type: 'chow', seat: 1 as Seat, option: dummyChowOption() },
      { type: 'hu', seat: 2 as Seat },
    ];
    expect(resolveClaims(claimsAgainstChow, 0 as Seat)).toEqual([{ type: 'hu', seat: 2 as Seat }]);
  });

  it('kong vs pung from different seats resolves by proximity to the discarder', () => {
    const claims: Claim[] = [
      { type: 'kong', seat: 1 as Seat },
      { type: 'pung', seat: 3 as Seat },
    ];
    expect(resolveClaims(claims, 0 as Seat)).toEqual([{ type: 'kong', seat: 1 as Seat }]);
  });

  it('pung or kong beats chow regardless of proximity', () => {
    const claims: Claim[] = [
      { type: 'chow', seat: 1 as Seat, option: dummyChowOption() },
      { type: 'pung', seat: 3 as Seat },
    ];
    expect(resolveClaims(claims, 0 as Seat)).toEqual([{ type: 'pung', seat: 3 as Seat }]);
  });

  it('returns all simultaneous hu claims sorted nearest-first', () => {
    const claims: Claim[] = [
      { type: 'hu', seat: 2 as Seat },
      { type: 'hu', seat: 1 as Seat },
    ];
    expect(resolveClaims(claims, 0 as Seat)).toEqual([
      { type: 'hu', seat: 1 as Seat },
      { type: 'hu', seat: 2 as Seat },
    ]);
  });

  it('returns all three hu claims in proximity order with seat wraparound (discarder seat 3)', () => {
    const claims: Claim[] = [
      { type: 'hu', seat: 2 as Seat },
      { type: 'hu', seat: 0 as Seat },
      { type: 'hu', seat: 1 as Seat },
    ];
    expect(resolveClaims(claims, 3 as Seat)).toEqual([
      { type: 'hu', seat: 0 as Seat },
      { type: 'hu', seat: 1 as Seat },
      { type: 'hu', seat: 2 as Seat },
    ]);
  });

  it('returns the lone chow claim when it is the only claim', () => {
    const chowClaim: Claim = { type: 'chow', seat: 1 as Seat, option: dummyChowOption() };
    expect(resolveClaims([chowClaim], 0 as Seat)).toEqual([chowClaim]);
  });

  it('returns empty for an empty claims array', () => {
    expect(resolveClaims([], 0 as Seat)).toEqual([]);
  });

  it('is deterministic under permutation of the input claims array', () => {
    const claims: Claim[] = [
      { type: 'hu', seat: 2 as Seat },
      { type: 'hu', seat: 0 as Seat },
      { type: 'hu', seat: 1 as Seat },
    ];
    const permuted = [claims[2], claims[0], claims[1]];
    expect(resolveClaims(claims, 3 as Seat)).toEqual(resolveClaims(permuted, 3 as Seat));
  });

  it('throws on a claim from the discarder seat', () => {
    const claims: Claim[] = [{ type: 'pung', seat: 0 as Seat }];
    expect(() => resolveClaims(claims, 0 as Seat)).toThrow();
  });

  it('throws on two claims from the same seat', () => {
    const claims: Claim[] = [
      { type: 'pung', seat: 1 as Seat },
      { type: 'chow', seat: 1 as Seat, option: dummyChowOption() },
    ];
    expect(() => resolveClaims(claims, 0 as Seat)).toThrow();
  });
});

// --- Adversarial additions (tester pass) ---

/** All permutations of `items` (used to stress loop-order / arrival-order independence). */
function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [items.slice()];
  const result: T[][] = [];
  for (let i = 0; i < items.length; i++) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const perm of permutations(rest)) {
      result.push([items[i], ...perm]);
    }
  }
  return result;
}

describe('resolveClaims — claim-priority race: hu wins regardless of array/loop order', () => {
  it('hu beats a simultaneous kong+pung claim under every ordering of the 3-claim array (6 permutations)', () => {
    const hu: Claim = { type: 'hu', seat: 1 as Seat };
    const kong: Claim = { type: 'kong', seat: 2 as Seat };
    const pung: Claim = { type: 'pung', seat: 3 as Seat };
    for (const perm of permutations([hu, kong, pung])) {
      expect(resolveClaims(perm, 0 as Seat)).toEqual([hu]);
    }
  });

  it('hu beats a simultaneous kong+chow claim under every ordering (concurrency: simulates out-of-order network arrival of claims)', () => {
    const hu: Claim = { type: 'hu', seat: 3 as Seat };
    const kong: Claim = { type: 'kong', seat: 2 as Seat };
    const chow: Claim = { type: 'chow', seat: 1 as Seat, option: dummyChowOption() };
    for (const perm of permutations([hu, kong, chow])) {
      expect(resolveClaims(perm, 0 as Seat)).toEqual([hu]);
    }
  });

  it('hu beats a simultaneous pung+chow claim under every ordering, with pung and hu swapped between the two non-priority-1 slots', () => {
    // Guards against an implementation that special-cases "the first claim in
    // the array" rather than scanning for type === 'hu'.
    const hu: Claim = { type: 'hu', seat: 2 as Seat };
    const pung: Claim = { type: 'pung', seat: 3 as Seat };
    const chow: Claim = { type: 'chow', seat: 1 as Seat, option: dummyChowOption() };
    for (const perm of permutations([pung, hu, chow])) {
      expect(resolveClaims(perm, 0 as Seat)).toEqual([hu]);
    }
  });
});

describe('resolveClaims — full-permutation determinism, no hu present (kong/pung/chow, 3 distinct seats)', () => {
  it('same single winner across all 6 orderings when kong is nearest the discarder', () => {
    const kong: Claim = { type: 'kong', seat: 1 as Seat }; // proximity 1 from discarder 0
    const pung: Claim = { type: 'pung', seat: 2 as Seat }; // proximity 2
    const chow: Claim = { type: 'chow', seat: 3 as Seat, option: dummyChowOption() }; // proximity 3, lowest priority regardless
    for (const perm of permutations([kong, pung, chow])) {
      expect(resolveClaims(perm, 0 as Seat)).toEqual([kong]);
    }
  });

  it('same single winner across all 6 orderings when pung is nearest the discarder', () => {
    const pung: Claim = { type: 'pung', seat: 1 as Seat }; // proximity 1
    const kong: Claim = { type: 'kong', seat: 2 as Seat }; // proximity 2
    const chow: Claim = { type: 'chow', seat: 3 as Seat, option: dummyChowOption() }; // proximity 3
    for (const perm of permutations([pung, kong, chow])) {
      expect(resolveClaims(perm, 0 as Seat)).toEqual([pung]);
    }
  });
});

describe('resolveClaims — proximity tie-break across every discarder seat (modulo wraparound)', () => {
  it('discarder seat 0: kong(seat3, proximity3) loses to pung(seat1, proximity1)', () => {
    const claims: Claim[] = [
      { type: 'kong', seat: 3 as Seat },
      { type: 'pung', seat: 1 as Seat },
    ];
    expect(resolveClaims(claims, 0 as Seat)).toEqual([{ type: 'pung', seat: 1 as Seat }]);
  });

  it('discarder seat 0: pung(seat3, proximity3) loses to kong(seat1, proximity1)', () => {
    const claims: Claim[] = [
      { type: 'pung', seat: 3 as Seat },
      { type: 'kong', seat: 1 as Seat },
    ];
    expect(resolveClaims(claims, 0 as Seat)).toEqual([{ type: 'kong', seat: 1 as Seat }]);
  });

  it('discarder seat 1: kong(seat0, proximity3) loses to pung(seat2, proximity1)', () => {
    const claims: Claim[] = [
      { type: 'kong', seat: 0 as Seat },
      { type: 'pung', seat: 2 as Seat },
    ];
    expect(resolveClaims(claims, 1 as Seat)).toEqual([{ type: 'pung', seat: 2 as Seat }]);
  });

  it('discarder seat 1: pung(seat0, proximity3) loses to kong(seat3, proximity2)', () => {
    const claims: Claim[] = [
      { type: 'pung', seat: 0 as Seat },
      { type: 'kong', seat: 3 as Seat },
    ];
    expect(resolveClaims(claims, 1 as Seat)).toEqual([{ type: 'kong', seat: 3 as Seat }]);
  });

  it('discarder seat 2: kong(seat1, proximity3) loses to pung(seat3, proximity1)', () => {
    const claims: Claim[] = [
      { type: 'kong', seat: 1 as Seat },
      { type: 'pung', seat: 3 as Seat },
    ];
    expect(resolveClaims(claims, 2 as Seat)).toEqual([{ type: 'pung', seat: 3 as Seat }]);
  });

  it('discarder seat 2: pung(seat1, proximity3) loses to kong(seat0, proximity2)', () => {
    const claims: Claim[] = [
      { type: 'pung', seat: 1 as Seat },
      { type: 'kong', seat: 0 as Seat },
    ];
    expect(resolveClaims(claims, 2 as Seat)).toEqual([{ type: 'kong', seat: 0 as Seat }]);
  });

  it('discarder seat 3: kong(seat2, proximity3) loses to pung(seat0, proximity1)', () => {
    const claims: Claim[] = [
      { type: 'kong', seat: 2 as Seat },
      { type: 'pung', seat: 0 as Seat },
    ];
    expect(resolveClaims(claims, 3 as Seat)).toEqual([{ type: 'pung', seat: 0 as Seat }]);
  });

  it('discarder seat 3: pung(seat2, proximity3) loses to kong(seat1, proximity2)', () => {
    const claims: Claim[] = [
      { type: 'pung', seat: 2 as Seat },
      { type: 'kong', seat: 1 as Seat },
    ];
    expect(resolveClaims(claims, 3 as Seat)).toEqual([{ type: 'kong', seat: 1 as Seat }]);
  });
});

describe('resolveClaims — single-claim sanity (validation must not be overly aggressive)', () => {
  it('a single hu claim from a valid non-discarder seat does not throw and returns that claim', () => {
    const claim: Claim = { type: 'hu', seat: 2 as Seat };
    expect(() => resolveClaims([claim], 0 as Seat)).not.toThrow();
    expect(resolveClaims([claim], 0 as Seat)).toEqual([claim]);
  });

  it('a single pung claim from a valid non-discarder seat does not throw and returns that claim', () => {
    const claim: Claim = { type: 'pung', seat: 3 as Seat };
    expect(() => resolveClaims([claim], 1 as Seat)).not.toThrow();
    expect(resolveClaims([claim], 1 as Seat)).toEqual([claim]);
  });

  it('a single kong claim from a valid non-discarder seat does not throw and returns that claim', () => {
    const claim: Claim = { type: 'kong', seat: 0 as Seat };
    expect(() => resolveClaims([claim], 2 as Seat)).not.toThrow();
    expect(resolveClaims([claim], 2 as Seat)).toEqual([claim]);
  });
});

describe('canChow — window boundary at rank 2 (second-to-edge low rank)', () => {
  it('rank-2 discard: low window [0,1] is structurally invalid; only [1,3] and [3,4] windows exist', () => {
    const { hand: h } = baseAtRestHandWith('tong1', 'tong3', 'tong4');
    const discard = tile('tong2');
    const result = canChow(h, discard, 1 as Seat, 0 as Seat);
    expect(result).toHaveLength(2);
    expect(result.map((o) => o.meld.tiles.map((t) => t.kind))).toEqual([
      [kindOf('tong1'), kindOf('tong2'), kindOf('tong3')],
      [kindOf('tong2'), kindOf('tong3'), kindOf('tong4')],
    ]);
  });

  it('rank-2 discard with only the [1,3] window tiles present returns exactly one option', () => {
    const { hand: h } = baseAtRestHandWith('tong1', 'tong3');
    const discard = tile('tong2');
    const result = canChow(h, discard, 1 as Seat, 0 as Seat);
    expect(result).toHaveLength(1);
    expect(result[0].meld.tiles.map((t) => t.kind)).toEqual([kindOf('tong1'), kindOf('tong2'), kindOf('tong3')]);
  });
});

describe('canChow — window boundary at rank 8 (second-to-edge high rank)', () => {
  it('rank-8 discard: high window [9,10] is structurally invalid; only [6,7] and [7,9] windows exist', () => {
    const { hand: h } = baseAtRestHandWith('tong6', 'tong7', 'tong9');
    const discard = tile('tong8');
    const result = canChow(h, discard, 1 as Seat, 0 as Seat);
    expect(result).toHaveLength(2);
    expect(result.map((o) => o.meld.tiles.map((t) => t.kind))).toEqual([
      [kindOf('tong6'), kindOf('tong7'), kindOf('tong8')],
      [kindOf('tong7'), kindOf('tong8'), kindOf('tong9')],
    ]);
  });

  it('rank-8 discard with only the [6,7] window tiles present returns exactly one option', () => {
    const { hand: h } = baseAtRestHandWith('tong6', 'tong7');
    const discard = tile('tong8');
    const result = canChow(h, discard, 1 as Seat, 0 as Seat);
    expect(result).toHaveLength(1);
    expect(result[0].meld.tiles.map((t) => t.kind)).toEqual([kindOf('tong6'), kindOf('tong7'), kindOf('tong8')]);
  });
});

describe('canChow — deterministic tile selection with duplicate ranks', () => {
  it('always selects the same (first-in-concealedTiles-array) tile id across repeated calls, not a varying one', () => {
    const { hand: h } = baseAtRestHandWith('tong4', 'tong4', 'tong4', 'tong6');
    const discard = tile('tong5');

    const first = canChow(h, discard, 1 as Seat, 0 as Seat);
    const second = canChow(h, discard, 1 as Seat, 0 as Seat);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);

    const usedId1 = first[0].concealedTilesUsed[0].id;
    const usedId2 = second[0].concealedTilesUsed[0].id;
    expect(usedId1).toBe(usedId2);

    const tong4Copies = h.concealedTiles.filter(
      (t) => t.kind.category === 'suit' && t.kind.suit === 'tong' && t.kind.rank === 4,
    );
    expect(tong4Copies).toHaveLength(3);
    expect(usedId1).toBe(tong4Copies[0].id);
  });
});

describe('canPung / canKongFromDiscard — boundary counts', () => {
  it('canPung returns true with exactly 3 concealed copies (a strict superset of the >=2 threshold)', () => {
    const { hand: h } = baseAtRestHandWith('tong5', 'tong5', 'tong5');
    expect(canPung(h, tile('tong5'))).toBe(true);
  });

  it('canKongFromDiscard returns true with exactly 4 concealed copies of the discarded kind (an unreachable hand shape under a real 144-tile wall, since it implies a 5th copy on the discard — verifying the function is purely count-based and does not sanity-check against wall scarcity)', () => {
    const { hand: h } = baseAtRestHandWith('tong5', 'tong5', 'tong5', 'tong5');
    expect(canKongFromDiscard(h, tile('tong5'))).toBe(true);
  });
});

describe('canPung / canKongFromDiscard — meld tiles are fully ignored, even same-kind melds', () => {
  it('canPung is true from concealed tiles alone even when an exposed pung of the same kind also exists in melds', () => {
    const exposedPung = meld('pung', false, 'tong5', 'tong5', 'tong5');
    const concealed = hand(
      'wan1', 'wan2', 'wan3', 'wan4', 'wan5', 'wan6', 'wan7',
      'tiao1', 'tiao1',
      'east', 'south', 'tong5', 'tong5',
    ); // 13 tiles = 16 - 3*1
    const h: PlayerHand = { concealedTiles: concealed, melds: [exposedPung] };
    expect(canPung(h, tile('tong5'))).toBe(true);
  });

  it('canKongFromDiscard is true from concealed tiles alone; an unrelated concealed kong in melds does not interfere', () => {
    const concealedKong = meld('kong', true, 'east', 'east', 'east', 'east');
    const concealed = hand(
      'wan1', 'wan2', 'wan3', 'wan4', 'wan5', 'wan6', 'wan7', 'wan8',
      'tiao1', 'tiao1',
      'tong6', 'tong6', 'tong6',
    ); // 13 tiles = 16 - 3*1
    const h: PlayerHand = { concealedTiles: concealed, melds: [concealedKong] };
    expect(canKongFromDiscard(h, tile('tong6'))).toBe(true);
  });
});
