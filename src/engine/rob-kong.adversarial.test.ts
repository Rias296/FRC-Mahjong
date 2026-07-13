/**
 * Targeted adversarial tests for src/engine/rob-kong.ts, beyond the
 * builder's rob-kong.test.ts (25 tests), per the tester's mandatory
 * robbing-the-kong checklist (CLAUDE.md) and docs/RULES.md §7. Every
 * expected value below was derived from the RULES.md §7.2/§6.1 proximity
 * definition and cross-checked against the actual implementation output
 * before being locked in — none are guessed.
 *
 * This file is verification-only: it must never import anything that would
 * let it silently pass by re-implementing the logic under test.
 */
import { describe, expect, it } from 'vitest';
import { findRobbers, promoteAddedKong, revertAddedKong } from './rob-kong';
import type { PlayerHand, PlayerMeld } from './actions';
import { proximity, resolveClaims, type Claim } from './actions';
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
import { DEFAULT_RULES, type RulesConfig } from './rules-config';

// --- Test-local shorthand tile builder (same convention as rob-kong.test.ts) ---
const WINDS: readonly WindName[] = ['east', 'south', 'west', 'north'];
const DRAGONS: readonly DragonName[] = ['red', 'green', 'white'];

function kindFromSpec(spec: string): TileKind {
  const suitMatch = /^(wan|tong|tiao)([1-9])$/.exec(spec);
  if (suitMatch) {
    return { category: 'suit', suit: suitMatch[1] as SuitName, rank: Number(suitMatch[2]) as Rank };
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
  throw new Error(`Unknown tile spec: ${spec}`);
}

let idCounter = 0;
function tile(spec: string): Tile {
  const kind = kindFromSpec(spec);
  idCounter += 1;
  return { id: `${kindKey(kind)}-adv${idCounter}`, kind };
}
function hand(...specs: string[]): Tile[] {
  return specs.map(tile);
}
function meld(kind: 'chow' | 'pung' | 'kong', concealed: boolean, ...specs: string[]): PlayerMeld {
  return { kind, concealed, tiles: hand(...specs) };
}

/** A 16-tile at-rest hand (no melds) that is tenpai, waiting on 'east'. */
function waitingOnEastHand(): PlayerHand {
  const concealed = hand(
    'wan1', 'wan2', 'wan3',
    'tong1', 'tong2', 'tong3',
    'tiao1', 'tiao2', 'tiao3',
    'red', 'red', 'red',
    'south', 'south', 'south',
    'east',
  );
  return { concealedTiles: concealed, melds: [] };
}

/** A 16-tile at-rest hand (no melds) that is not tenpai on any reasonable candidate. */
function deadHand(): PlayerHand {
  const concealed = hand(
    'wan1', 'wan3', 'wan5', 'wan7', 'wan9',
    'tong1', 'tong3', 'tong5', 'tong7', 'tong9',
    'tiao1', 'tiao3', 'tiao5', 'tiao7', 'tiao9',
    'east',
  );
  return { concealedTiles: concealed, melds: [] };
}

function eastTile(): Tile {
  return tile('east');
}

// =====================================================================
// 1. All 4 declarer seats for proximity wraparound
// =====================================================================
describe('findRobbers: proximity wraparound for every declarer seat (not just seat 2)', () => {
  it('declarer seat 1, all three opponents eligible: order [2, 3, 0]', () => {
    const kongTile = eastTile();
    const opponentHands: Partial<Record<Seat, PlayerHand>> = {
      0: waitingOnEastHand(),
      2: waitingOnEastHand(),
      3: waitingOnEastHand(),
    };
    const declarer = 1 as Seat;
    const result = findRobbers(kongTile, 'added', declarer, opponentHands, DEFAULT_RULES);
    expect(result).toEqual([2, 3, 0]);

    // Cross-check against the independent resolveClaims proximity ordering.
    const huClaims: Claim[] = [0, 2, 3].map((seat) => ({ type: 'hu', seat: seat as Seat }));
    expect(resolveClaims(huClaims, declarer).map((c) => c.seat)).toEqual(result);
  });

  it('declarer seat 3, all three opponents eligible: order [0, 1, 2]', () => {
    const kongTile = eastTile();
    const opponentHands: Partial<Record<Seat, PlayerHand>> = {
      0: waitingOnEastHand(),
      1: waitingOnEastHand(),
      2: waitingOnEastHand(),
    };
    const declarer = 3 as Seat;
    const result = findRobbers(kongTile, 'added', declarer, opponentHands, DEFAULT_RULES);
    expect(result).toEqual([0, 1, 2]);

    const huClaims: Claim[] = [0, 1, 2].map((seat) => ({ type: 'hu', seat: seat as Seat }));
    expect(resolveClaims(huClaims, declarer).map((c) => c.seat)).toEqual(result);
  });

  it('declarer seat 1, partial eligibility (seat 2 dead): order [3, 0]', () => {
    const kongTile = eastTile();
    const opponentHands: Partial<Record<Seat, PlayerHand>> = {
      0: waitingOnEastHand(),
      2: deadHand(),
      3: waitingOnEastHand(),
    };
    const declarer = 1 as Seat;
    // proximity(3,1) = 2, proximity(0,1) = 3 -> 3 before 0.
    expect(proximity(3, declarer)).toBe(2);
    expect(proximity(0, declarer)).toBe(3);
    expect(findRobbers(kongTile, 'added', declarer, opponentHands, DEFAULT_RULES)).toEqual([3, 0]);
  });

  it('declarer seat 3, partial eligibility (seat 0 dead): order [1, 2]', () => {
    const kongTile = eastTile();
    const opponentHands: Partial<Record<Seat, PlayerHand>> = {
      0: deadHand(),
      1: waitingOnEastHand(),
      2: waitingOnEastHand(),
    };
    const declarer = 3 as Seat;
    expect(proximity(1, declarer)).toBe(2);
    expect(proximity(2, declarer)).toBe(3);
    expect(findRobbers(kongTile, 'added', declarer, opponentHands, DEFAULT_RULES)).toEqual([1, 2]);
  });
});

// =====================================================================
// 2 & 3. Gate ordering: robKong.enabled / robConcealedKong must short-circuit
//    BEFORE flower validation and BEFORE missing-opponent-seat validation.
// =====================================================================
describe('findRobbers: config gates short-circuit before input validation', () => {
  it('robKong.enabled=false returns [] without throwing even with a flower kongTile AND missing opponent seats', () => {
    const flowerTile = tile('flower1');
    const opponentHands: Partial<Record<Seat, PlayerHand>> = {
      1: waitingOnEastHand(),
      // seats 2 and 3 deliberately missing
    };
    const rules: RulesConfig = { ...DEFAULT_RULES, robKong: { enabled: false, robConcealedKong: false } };
    expect(() => findRobbers(flowerTile, 'added', 0 as Seat, opponentHands, rules)).not.toThrow();
    expect(findRobbers(flowerTile, 'added', 0 as Seat, opponentHands, rules)).toEqual([]);
  });

  it('robKong.enabled=false + concealed kongType returns [] without throwing even with a flower kongTile AND missing opponent seats', () => {
    const flowerTile = tile('flower2');
    const opponentHands: Partial<Record<Seat, PlayerHand>> = {
      // all seats missing
    };
    const rules: RulesConfig = { ...DEFAULT_RULES, robKong: { enabled: false, robConcealedKong: true } };
    expect(() => findRobbers(flowerTile, 'concealed', 0 as Seat, opponentHands, rules)).not.toThrow();
    expect(findRobbers(flowerTile, 'concealed', 0 as Seat, opponentHands, rules)).toEqual([]);
  });

  it('robConcealedKong=false (with robKong.enabled=true) returns [] for a concealed kong without throwing even with a flower kongTile AND missing opponent seats', () => {
    const flowerTile = tile('flower3');
    const opponentHands: Partial<Record<Seat, PlayerHand>> = {
      1: waitingOnEastHand(),
      // seats 2, 3 missing
    };
    const rules: RulesConfig = { ...DEFAULT_RULES, robKong: { enabled: true, robConcealedKong: false } };
    expect(() => findRobbers(flowerTile, 'concealed', 0 as Seat, opponentHands, rules)).not.toThrow();
    expect(findRobbers(flowerTile, 'concealed', 0 as Seat, opponentHands, rules)).toEqual([]);
  });

  it('sanity check: with the same flower kongTile, once the gates are open (enabled + robConcealedKong true), the flower validation DOES throw', () => {
    const flowerTile = tile('flower4');
    const opponentHands: Partial<Record<Seat, PlayerHand>> = {
      1: waitingOnEastHand(),
      2: deadHand(),
      3: deadHand(),
    };
    const rules: RulesConfig = { ...DEFAULT_RULES, robKong: { enabled: true, robConcealedKong: true } };
    expect(() => findRobbers(flowerTile, 'concealed', 0 as Seat, opponentHands, rules)).toThrow();
  });

  it('sanity check: with the same missing-seat setup, once robKong.enabled is true and kongType is added (no concealed gate applies), the missing-seat validation DOES throw', () => {
    const kongTile = eastTile();
    const opponentHands: Partial<Record<Seat, PlayerHand>> = {
      1: waitingOnEastHand(),
      // seats 2, 3 missing
    };
    expect(() => findRobbers(kongTile, 'added', 0 as Seat, opponentHands, DEFAULT_RULES)).toThrow();
  });
});

// =====================================================================
// 4. Exactly one opponent hand at the winning shape via a genuinely
//    non-obvious decomposition (ambiguous pung-vs-chow block), not just
//    the trivial "3 sequential single-suit runs" fixture used elsewhere.
// =====================================================================
describe('findRobbers: non-trivial decomposition (ambiguous pung/chow block)', () => {
  /**
   * 16 concealed tiles:
   *  - tong 2,2,2,3,3,3,4,4,4 (9 tiles) — decomposes as EITHER three pungs
   *    (222)(333)(444) OR three chows (234)(234)(234); both are valid, so
   *    this stresses the findSetsRec backtracking search (pung tried first,
   *    then chow) through the full findRobbers -> canWin pipeline instead of
   *    the simple single-path fixtures used elsewhere in this suite.
   *  - wan 5,5,5 (pung, 3 tiles)
   *  - tiao 6,7 (2 tiles) + kongTile tiao8 completes the 5th set as a chow
   *  - south, south (pair, 2 tiles)
   * Total: 9 + 3 + 2 + 2 = 16 concealed + 1 candidate = 17 = 5*3 + 2.
   */
  function ambiguousWaitingHand(): PlayerHand {
    const concealed = hand(
      'tong2', 'tong2', 'tong2',
      'tong3', 'tong3', 'tong3',
      'tong4', 'tong4', 'tong4',
      'wan5', 'wan5', 'wan5',
      'tiao6', 'tiao7',
      'south', 'south',
    );
    return { concealedTiles: concealed, melds: [] };
  }

  /**
   * Negative control: swap one 'tong4' for a 'tong9' so the ambiguous block
   * can no longer complete as 3 sets under EITHER interpretation. If this
   * fixture were (incorrectly) found eligible, it would prove the positive
   * test above is vacuous / not actually exercising canWin's decomposition.
   */
  function brokenAmbiguousHand(): PlayerHand {
    const concealed = hand(
      'tong2', 'tong2', 'tong2',
      'tong3', 'tong3', 'tong3',
      'tong4', 'tong4', 'tong9',
      'wan5', 'wan5', 'wan5',
      'tiao6', 'tiao7',
      'south', 'south',
    );
    return { concealedTiles: concealed, melds: [] };
  }

  it('is found as a robber (positive control)', () => {
    const kongTile = tile('tiao8');
    const opponentHands: Partial<Record<Seat, PlayerHand>> = {
      1: ambiguousWaitingHand(),
      2: deadHand(),
      3: deadHand(),
    };
    expect(findRobbers(kongTile, 'added', 0 as Seat, opponentHands, DEFAULT_RULES)).toEqual([1]);
  });

  it('is NOT found as a robber once the ambiguous block is broken (negative control)', () => {
    const kongTile = tile('tiao8');
    const opponentHands: Partial<Record<Seat, PlayerHand>> = {
      1: brokenAmbiguousHand(),
      2: deadHand(),
      3: deadHand(),
    };
    expect(findRobbers(kongTile, 'added', 0 as Seat, opponentHands, DEFAULT_RULES)).toEqual([]);
  });
});

// =====================================================================
// 5. promoteAddedKong / revertAddedKong touch only the target meld; all
//    other melds (mixed chow/pung/concealed-kong) are untouched, including
//    array position.
// =====================================================================
describe('promoteAddedKong / revertAddedKong: untouched melds are byte-for-byte identical at the same array position', () => {
  interface MeldSnapshot {
    readonly kind: string;
    readonly concealed: boolean;
    readonly tileIds: readonly string[];
  }

  function deepMeldSnapshot(melds: readonly PlayerMeld[]): MeldSnapshot[] {
    return melds.map((m) => ({ kind: m.kind, concealed: m.concealed, tileIds: m.tiles.map((t) => t.id) }));
  }

  function fourMeldHand(): { hand: PlayerHand; addedTile: Tile } {
    const addedTile = tile('tong8');
    const melds: PlayerMeld[] = [
      meld('chow', false, 'wan1', 'wan2', 'wan3'),
      meld('pung', false, 'tong8', 'tong8', 'tong8'), // target for promotion (index 1)
      meld('pung', false, 'red', 'red', 'red'),
      meld('kong', true, 'white', 'white', 'white', 'white'),
    ];
    const concealedTiles = [addedTile, tile('east')];
    return { hand: { concealedTiles, melds }, addedTile };
  }

  it('promoteAddedKong only mutates meld index 1; melds at index 0, 2, 3 are unchanged in content AND position', () => {
    const { hand: h, addedTile } = fourMeldHand();
    const before = deepMeldSnapshot(h.melds);
    const promoted = promoteAddedKong(h, addedTile);

    expect(promoted.melds).toHaveLength(4);
    expect(deepMeldSnapshot([promoted.melds[0]])).toEqual([before[0]]);
    expect(promoted.melds[1].kind).toBe('kong');
    expect(promoted.melds[1].concealed).toBe(false);
    expect(promoted.melds[1].tiles.map((t) => t.id)).toEqual([
      ...h.melds[1].tiles.map((t) => t.id),
      addedTile.id,
    ]);
    expect(deepMeldSnapshot([promoted.melds[2]])).toEqual([before[2]]);
    expect(deepMeldSnapshot([promoted.melds[3]])).toEqual([before[3]]);
    // The concealed kong at index 3 must still be reported as concealed.
    expect(promoted.melds[3].concealed).toBe(true);
  });

  it('revertAddedKong (applied after promotion) only mutates meld index 1 back; indices 0, 2, 3 remain unchanged', () => {
    const { hand: h, addedTile } = fourMeldHand();
    const promoted = promoteAddedKong(h, addedTile);
    const beforeRevert = deepMeldSnapshot(promoted.melds);
    const reverted = revertAddedKong(promoted, addedTile);

    expect(reverted.melds).toHaveLength(4);
    expect(deepMeldSnapshot([reverted.melds[0]])).toEqual([beforeRevert[0]]);
    expect(reverted.melds[1].kind).toBe('pung');
    expect(reverted.melds[1].concealed).toBe(false);
    expect(reverted.melds[1].tiles.map((t) => t.id)).toEqual(h.melds[1].tiles.map((t) => t.id));
    expect(deepMeldSnapshot([reverted.melds[2]])).toEqual([beforeRevert[2]]);
    expect(deepMeldSnapshot([reverted.melds[3]])).toEqual([beforeRevert[3]]);
  });
});

// =====================================================================
// 6. revertAddedKong: the "other 3 tiles in original relative order" claim,
//    tested with the added tile in non-final positions (constructed
//    directly, bypassing promoteAddedKong which always appends last).
// =====================================================================
describe('revertAddedKong: preserves relative order of the remaining 3 tiles regardless of the added tile\'s position', () => {
  it('added tile in the middle (index 1 of 4): [B, added, C, D] -> [B, C, D]', () => {
    const tileB = tile('tong8');
    const tileAdded = tile('tong8');
    const tileC = tile('tong8');
    const tileD = tile('tong8');
    const kongMeld: PlayerMeld = { kind: 'kong', concealed: false, tiles: [tileB, tileAdded, tileC, tileD] };
    const h: PlayerHand = { concealedTiles: [], melds: [kongMeld] };

    const result = revertAddedKong(h, tileAdded);
    expect(result.melds[0].tiles.map((t) => t.id)).toEqual([tileB.id, tileC.id, tileD.id]);
  });

  it('added tile first (index 0 of 4): [added, B, C, D] -> [B, C, D]', () => {
    const tileAdded = tile('tong8');
    const tileB = tile('tong8');
    const tileC = tile('tong8');
    const tileD = tile('tong8');
    const kongMeld: PlayerMeld = { kind: 'kong', concealed: false, tiles: [tileAdded, tileB, tileC, tileD] };
    const h: PlayerHand = { concealedTiles: [], melds: [kongMeld] };

    const result = revertAddedKong(h, tileAdded);
    expect(result.melds[0].tiles.map((t) => t.id)).toEqual([tileB.id, tileC.id, tileD.id]);
  });

  it('added tile third (index 2 of 4): [B, C, added, D] -> [B, C, D]', () => {
    const tileB = tile('tong8');
    const tileC = tile('tong8');
    const tileAdded = tile('tong8');
    const tileD = tile('tong8');
    const kongMeld: PlayerMeld = { kind: 'kong', concealed: false, tiles: [tileB, tileC, tileAdded, tileD] };
    const h: PlayerHand = { concealedTiles: [], melds: [kongMeld] };

    const result = revertAddedKong(h, tileAdded);
    expect(result.melds[0].tiles.map((t) => t.id)).toEqual([tileB.id, tileC.id, tileD.id]);
  });
});

// =====================================================================
// 7. Trust-boundary documentation: findRobbers has no visibility into the
//    declarer's own hand/meld state at all (it only receives kongTile,
//    kongType, declarerSeat, and the OPPONENTS' hands) — so it cannot and
//    does not cross-validate that kongTile actually corresponds to a real
//    kongType meld the declarer holds. This mirrors actions.ts's
//    resolveClaims, which trusts pre-validated claims. Documented here as
//    an explicit, intentional trust boundary, not exercised as a bug.
// =====================================================================
describe('findRobbers: trust boundary (declarer meld/kongTile correspondence is not and cannot be validated here)', () => {
  it('accepts any plausible (non-flower) kongTile/kongType combination without cross-checking a declarer hand, because none is passed in', () => {
    const kongTile = tile('red'); // no declarer hand is provided anywhere in the call
    const opponentHands: Partial<Record<Seat, PlayerHand>> = {
      1: deadHand(),
      2: deadHand(),
      3: deadHand(),
    };
    // Should evaluate purely structurally against opponentHands and not throw
    // due to any (nonexistent) declarer-side consistency check.
    expect(() => findRobbers(kongTile, 'added', 0 as Seat, opponentHands, DEFAULT_RULES)).not.toThrow();
    expect(() => findRobbers(kongTile, 'concealed', 0 as Seat, opponentHands, {
      ...DEFAULT_RULES,
      robKong: { enabled: true, robConcealedKong: true },
    })).not.toThrow();
  });
});
