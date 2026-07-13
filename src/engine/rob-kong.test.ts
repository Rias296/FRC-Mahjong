import { describe, expect, it } from 'vitest';
import { findRobbers, promoteAddedKong, revertAddedKong } from './rob-kong';
import type { PlayerHand, PlayerMeld } from './actions';
import { resolveClaims, type Claim } from './actions';
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

// --- Test-local shorthand tile builder (duplicated per-file convention, see actions.test.ts / hand.test.ts) ---
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

function meld(kind: 'chow' | 'pung' | 'kong', concealed: boolean, ...specs: string[]): PlayerMeld {
  return { kind, concealed, tiles: hand(...specs) };
}

// --- Test-local fixtures ---

/** A 16-tile at-rest hand (no melds) that is tenpai, waiting on 'east' to complete 5 sets + pair. */
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

/** A 13-tile at-rest hand (fixedMeldCount 1, one existing exposed pung) waiting on 'east'. */
function waitingOnEastHandWithOneMeld(): PlayerHand {
  const existingPung = meld('pung', false, 'green', 'green', 'green');
  const concealed = hand(
    'wan1', 'wan2', 'wan3',
    'tong1', 'tong2', 'tong3',
    'tiao1', 'tiao2', 'tiao3',
    'red', 'red', 'red',
    'east',
  ); // 13 tiles = 16 - 3*1
  return { concealedTiles: concealed, melds: [existingPung] };
}

/** A 12-tile at-rest hand (fixedMeldCount 2, one exposed pung + one exposed kong) waiting on 'east'. */
function waitingOnEastHandWithKongMeld(): PlayerHand {
  const existingPung = meld('pung', false, 'green', 'green', 'green');
  const existingKong = meld('kong', false, 'white', 'white', 'white', 'white');
  const concealed = hand(
    'wan1', 'wan2', 'wan3',
    'tong1', 'tong2', 'tong3',
    'red', 'red', 'red',
    'east',
  ); // 10 tiles = 16 - 3*2
  return { concealedTiles: concealed, melds: [existingPung, existingKong] };
}

function eastTile(): Tile {
  return tile('east');
}

describe('findRobbers', () => {
  it('returns the single eligible opponent for an added kong under DEFAULT_RULES', () => {
    const kongTile = eastTile();
    const opponentHands: Partial<Record<Seat, PlayerHand>> = {
      1: waitingOnEastHand(),
      2: deadHand(),
      3: deadHand(),
    };
    expect(findRobbers(kongTile, 'added', 0 as Seat, opponentHands, DEFAULT_RULES)).toEqual([1]);
  });

  it('returns [] when no opponent completes on the kong tile', () => {
    const kongTile = eastTile();
    const opponentHands: Partial<Record<Seat, PlayerHand>> = {
      1: deadHand(),
      2: deadHand(),
      3: deadHand(),
    };
    expect(findRobbers(kongTile, 'added', 0 as Seat, opponentHands, DEFAULT_RULES)).toEqual([]);
  });

  it('returns multiple robbers sorted by proximity from the declarer', () => {
    const kongTile = eastTile();
    // declarer seat 0; opponents 1, 2, 3 all waiting on east.
    const opponentHands: Partial<Record<Seat, PlayerHand>> = {
      1: waitingOnEastHand(),
      2: waitingOnEastHand(),
      3: waitingOnEastHand(),
    };
    expect(findRobbers(kongTile, 'added', 0 as Seat, opponentHands, DEFAULT_RULES)).toEqual([1, 2, 3]);
  });

  it('proximity wraps around seat 3 to seat 0 (declarer seat 2: order [3, 0, 1])', () => {
    const kongTile = eastTile();
    const opponentHands: Partial<Record<Seat, PlayerHand>> = {
      0: waitingOnEastHand(),
      1: waitingOnEastHand(),
      3: waitingOnEastHand(),
    };
    expect(findRobbers(kongTile, 'added', 2 as Seat, opponentHands, DEFAULT_RULES)).toEqual([3, 0, 1]);
  });

  it('proximity ordering matches resolveClaims hu-claim ordering for the same seats and two different declarer seats', () => {
    const kongTile1 = eastTile();
    const opponentHands1: Partial<Record<Seat, PlayerHand>> = {
      0: waitingOnEastHand(),
      1: waitingOnEastHand(),
      3: waitingOnEastHand(),
    };
    const declarer1 = 2 as Seat;
    const robbers1 = findRobbers(kongTile1, 'added', declarer1, opponentHands1, DEFAULT_RULES);
    const huClaims1: Claim[] = [0, 1, 3].map((seat) => ({ type: 'hu', seat: seat as Seat }));
    const resolved1 = resolveClaims(huClaims1, declarer1).map((c) => c.seat);
    expect(robbers1).toEqual(resolved1);

    const kongTile2 = eastTile();
    const opponentHands2: Partial<Record<Seat, PlayerHand>> = {
      1: waitingOnEastHand(),
      2: waitingOnEastHand(),
      3: waitingOnEastHand(),
    };
    const declarer2 = 0 as Seat;
    const robbers2 = findRobbers(kongTile2, 'added', declarer2, opponentHands2, DEFAULT_RULES);
    const huClaims2: Claim[] = [1, 2, 3].map((seat) => ({ type: 'hu', seat: seat as Seat }));
    const resolved2 = resolveClaims(huClaims2, declarer2).map((c) => c.seat);
    expect(robbers2).toEqual(resolved2);
  });

  it('returns [] for a concealed kong when robConcealedKong is false (default)', () => {
    const kongTile = eastTile();
    const opponentHands: Partial<Record<Seat, PlayerHand>> = {
      1: waitingOnEastHand(),
      2: deadHand(),
      3: deadHand(),
    };
    expect(findRobbers(kongTile, 'concealed', 0 as Seat, opponentHands, DEFAULT_RULES)).toEqual([]);
  });

  it('returns eligible robbers for a concealed kong when robConcealedKong is true', () => {
    const kongTile = eastTile();
    const opponentHands: Partial<Record<Seat, PlayerHand>> = {
      1: waitingOnEastHand(),
      2: deadHand(),
      3: deadHand(),
    };
    const rules: RulesConfig = { ...DEFAULT_RULES, robKong: { enabled: true, robConcealedKong: true } };
    expect(findRobbers(kongTile, 'concealed', 0 as Seat, opponentHands, rules)).toEqual([1]);
  });

  it('returns [] unconditionally when robKong.enabled is false (added kong, winning opponent present)', () => {
    const kongTile = eastTile();
    const opponentHands: Partial<Record<Seat, PlayerHand>> = {
      1: waitingOnEastHand(),
      2: deadHand(),
      3: deadHand(),
    };
    const rules: RulesConfig = { ...DEFAULT_RULES, robKong: { enabled: false, robConcealedKong: false } };
    expect(findRobbers(kongTile, 'added', 0 as Seat, opponentHands, rules)).toEqual([]);
  });

  it('returns [] when robKong.enabled is false even with robConcealedKong true (concealed kong, winning opponent present)', () => {
    const kongTile = eastTile();
    const opponentHands: Partial<Record<Seat, PlayerHand>> = {
      1: waitingOnEastHand(),
      2: deadHand(),
      3: deadHand(),
    };
    const rules: RulesConfig = { ...DEFAULT_RULES, robKong: { enabled: false, robConcealedKong: true } };
    expect(findRobbers(kongTile, 'concealed', 0 as Seat, opponentHands, rules)).toEqual([]);
  });

  it('robConcealedKong flag does not affect added-kong robbability', () => {
    const kongTileFalse = eastTile();
    const opponentHandsFalse: Partial<Record<Seat, PlayerHand>> = {
      1: waitingOnEastHand(),
      2: deadHand(),
      3: deadHand(),
    };
    const rulesFalse: RulesConfig = { ...DEFAULT_RULES, robKong: { enabled: true, robConcealedKong: false } };
    expect(findRobbers(kongTileFalse, 'added', 0 as Seat, opponentHandsFalse, rulesFalse)).toEqual([1]);

    const kongTileTrue = eastTile();
    const opponentHandsTrue: Partial<Record<Seat, PlayerHand>> = {
      1: waitingOnEastHand(),
      2: deadHand(),
      3: deadHand(),
    };
    const rulesTrue: RulesConfig = { ...DEFAULT_RULES, robKong: { enabled: true, robConcealedKong: true } };
    expect(findRobbers(kongTileTrue, 'added', 0 as Seat, opponentHandsTrue, rulesTrue)).toEqual([1]);
  });

  it('evaluates an opponent with existing melds using fixedMeldCount = melds.length (including one with a kong meld already)', () => {
    const kongTile = eastTile();
    const opponentHands: Partial<Record<Seat, PlayerHand>> = {
      1: waitingOnEastHandWithOneMeld(),
      2: waitingOnEastHandWithKongMeld(),
      3: deadHand(),
    };
    expect(findRobbers(kongTile, 'added', 0 as Seat, opponentHands, DEFAULT_RULES)).toEqual([1, 2]);
  });

  it('throws when opponentHands includes the declarer seat', () => {
    const kongTile = eastTile();
    const opponentHands: Partial<Record<Seat, PlayerHand>> = {
      0: waitingOnEastHand(),
      1: deadHand(),
      2: deadHand(),
      3: deadHand(),
    };
    expect(() => findRobbers(kongTile, 'added', 0 as Seat, opponentHands, DEFAULT_RULES)).toThrow();
  });

  it('throws when an opponent seat is missing', () => {
    const kongTile = eastTile();
    const opponentHands: Partial<Record<Seat, PlayerHand>> = {
      1: deadHand(),
      2: deadHand(),
      // seat 3 missing
    };
    expect(() => findRobbers(kongTile, 'added', 0 as Seat, opponentHands, DEFAULT_RULES)).toThrow();
  });

  it('throws when kongTile is a flower', () => {
    const flowerTile = tile('flower1');
    const opponentHands: Partial<Record<Seat, PlayerHand>> = {
      1: deadHand(),
      2: deadHand(),
      3: deadHand(),
    };
    expect(() => findRobbers(flowerTile, 'added', 0 as Seat, opponentHands, DEFAULT_RULES)).toThrow();
  });
});

// --- promoteAddedKong / revertAddedKong fixtures ---

function pungHandWithFourthTileConcealed(): { hand: PlayerHand; pung: PlayerMeld; addedTile: Tile } {
  const pung = meld('pung', false, 'tong8', 'tong8', 'tong8');
  const addedTile = tile('tong8');
  const concealed = hand(
    'wan1', 'wan2', 'wan3', 'wan4', 'wan5', 'wan6', 'wan7', 'wan8', 'wan9',
    'tiao1', 'tiao1', 'tiao1',
    'east',
  ); // 13 tiles
  const fullConcealed = [...concealed, addedTile]; // 14 tiles = 17 - 3*1
  return { hand: { concealedTiles: fullConcealed, melds: [pung] }, pung, addedTile };
}

describe('promoteAddedKong', () => {
  it('moves the concealed tile into a 4-tile exposed kong at the pung\'s original meld index', () => {
    const { hand: h, pung, addedTile } = pungHandWithFourthTileConcealed();
    const result = promoteAddedKong(h, addedTile);

    expect(result.melds).toHaveLength(1);
    expect(result.melds[0].kind).toBe('kong');
    expect(result.melds[0].concealed).toBe(false);
    expect(result.melds[0].tiles.map((t) => t.id)).toEqual([...pung.tiles.map((t) => t.id), addedTile.id]);
    expect(result.concealedTiles.some((t) => t.id === addedTile.id)).toBe(false);
  });

  it('output has at-rest concealed length (16 - 3 * melds.length)', () => {
    const { hand: h, addedTile } = pungHandWithFourthTileConcealed();
    const result = promoteAddedKong(h, addedTile);
    expect(result.concealedTiles.length).toBe(16 - 3 * result.melds.length);
  });

  it('throws when the tile id is not in concealedTiles', () => {
    const { hand: h } = pungHandWithFourthTileConcealed();
    const foreignTile = tile('tong8');
    expect(() => promoteAddedKong(h, foreignTile)).toThrow();
  });

  it('throws when no exposed pung matches the tile kind (chow-only, concealed-kong-only, no-meld-at-all)', () => {
    const addedTile = tile('tong8');

    const chowOnly: PlayerHand = {
      concealedTiles: [
        ...hand(
          'wan1', 'wan2', 'wan3', 'wan4', 'wan5', 'wan6', 'wan7', 'wan8', 'wan9',
          'tiao1', 'tiao1', 'tiao1',
          'east',
        ),
        addedTile,
      ],
      melds: [meld('chow', false, 'tong6', 'tong7', 'tong8')],
    };
    expect(() => promoteAddedKong(chowOnly, addedTile)).toThrow();

    const concealedKongOnly: PlayerHand = {
      concealedTiles: [
        ...hand(
          'wan1', 'wan2', 'wan3', 'wan4', 'wan5', 'wan6', 'wan7', 'wan8', 'wan9',
          'tiao1', 'tiao1', 'tiao1',
          'east',
        ),
        addedTile,
      ],
      melds: [meld('kong', true, 'tong8', 'tong8', 'tong8', 'tong8')],
    };
    expect(() => promoteAddedKong(concealedKongOnly, addedTile)).toThrow();

    const noMeldAtAll: PlayerHand = {
      concealedTiles: [
        ...hand(
          'wan1', 'wan2', 'wan3', 'wan4', 'wan5', 'wan6', 'wan7', 'wan8', 'wan9',
          'tiao1', 'tiao1', 'tiao1', 'tiao2',
          'east',
        ),
        addedTile,
      ],
      melds: [],
    };
    expect(() => promoteAddedKong(noMeldAtAll, addedTile)).toThrow();
  });

  it('does not mutate the input hand', () => {
    const { hand: h, addedTile } = pungHandWithFourthTileConcealed();
    const concealedIdsBefore = h.concealedTiles.map((t) => t.id);
    const meldsBefore = h.melds.map((m) => ({ kind: m.kind, concealed: m.concealed, tileIds: m.tiles.map((t) => t.id) }));

    promoteAddedKong(h, addedTile);

    expect(h.concealedTiles.map((t) => t.id)).toEqual(concealedIdsBefore);
    expect(h.melds.map((m) => ({ kind: m.kind, concealed: m.concealed, tileIds: m.tiles.map((t) => t.id) }))).toEqual(
      meldsBefore,
    );
  });
});

function kongHandFromPromotion(): { hand: PlayerHand; originalPungTiles: Tile[]; addedTile: Tile } {
  const { hand: h, pung, addedTile } = pungHandWithFourthTileConcealed();
  const promoted = promoteAddedKong(h, addedTile);
  return { hand: promoted, originalPungTiles: pung.tiles.slice(), addedTile };
}

describe('revertAddedKong', () => {
  it('replaces the kong with a pung of the three original tiles at the same meld index and drops the added tile', () => {
    const { hand: h, originalPungTiles, addedTile } = kongHandFromPromotion();
    const result = revertAddedKong(h, addedTile);

    expect(result.melds).toHaveLength(1);
    expect(result.melds[0].kind).toBe('pung');
    expect(result.melds[0].concealed).toBe(false);
    expect(result.melds[0].tiles.map((t) => t.id)).toEqual(originalPungTiles.map((t) => t.id));
  });

  it('leaves concealedTiles untouched', () => {
    const { hand: h, addedTile } = kongHandFromPromotion();
    const result = revertAddedKong(h, addedTile);
    expect(result.concealedTiles.map((t) => t.id)).toEqual(h.concealedTiles.map((t) => t.id));
    expect(result.concealedTiles.some((t) => t.id === addedTile.id)).toBe(false);
  });

  it('throws when no exposed kong meld contains the tile id', () => {
    const { hand: h } = kongHandFromPromotion();
    const foreignTile = tile('tong8');
    expect(() => revertAddedKong(h, foreignTile)).toThrow();
  });

  it('throws when the only matching kong is concealed', () => {
    const addedTile = tile('tong9');
    // The concealed kong genuinely contains addedTile's id, but concealed
    // kongs are never robbable/revertable (concealed === false is required).
    const concealedKong: PlayerMeld = {
      kind: 'kong',
      concealed: true,
      tiles: [...hand('tong9', 'tong9', 'tong9'), addedTile],
    };
    const h: PlayerHand = {
      concealedTiles: hand(
        'wan1', 'wan2', 'wan3', 'wan4', 'wan5', 'wan6', 'wan7', 'wan8', 'wan9',
        'tiao1', 'tiao1', 'tiao1',
      ), // 12 tiles = 16 - 3*2 (matches fixedMeldCount=2's at-rest length here)
      melds: [concealedKong],
    };
    expect(() => revertAddedKong(h, addedTile)).toThrow();
  });

  it('does not mutate the input hand', () => {
    const { hand: h, addedTile } = kongHandFromPromotion();
    const concealedIdsBefore = h.concealedTiles.map((t) => t.id);
    const meldsBefore = h.melds.map((m) => ({ kind: m.kind, concealed: m.concealed, tileIds: m.tiles.map((t) => t.id) }));

    revertAddedKong(h, addedTile);

    expect(h.concealedTiles.map((t) => t.id)).toEqual(concealedIdsBefore);
    expect(h.melds.map((m) => ({ kind: m.kind, concealed: m.concealed, tileIds: m.tiles.map((t) => t.id) }))).toEqual(
      meldsBefore,
    );
  });
});

describe('promote/revert round-trip', () => {
  it('revertAddedKong(promoteAddedKong(h, t), t) deep-equals h with t removed from concealedTiles', () => {
    const { hand: h, addedTile } = pungHandWithFourthTileConcealed();
    const promoted = promoteAddedKong(h, addedTile);
    const reverted = revertAddedKong(promoted, addedTile);

    const expectedConcealed = h.concealedTiles.filter((t) => t.id !== addedTile.id);
    expect(reverted.concealedTiles).toEqual(expectedConcealed);

    expect(reverted.melds).toHaveLength(h.melds.length);
    for (let i = 0; i < h.melds.length; i++) {
      expect(reverted.melds[i].kind).toBe(h.melds[i].kind);
      expect(reverted.melds[i].concealed).toBe(h.melds[i].concealed);
      expect(reverted.melds[i].tiles.map((t) => t.id)).toEqual(h.melds[i].tiles.map((t) => t.id));
    }
  });
});
