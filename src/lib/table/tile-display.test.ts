import { describe, expect, it } from 'vitest';
import { meldFaceDown, seatPositionFor, sortTilesForDisplay, tileGlyph, type AccentKey } from './tile-display';
import { HAND_TILE_KINDS, type TileKind } from '../../engine/tiles';
import { SEATS, type Seat } from '../../engine/seats';
import type { ClientMeld, ClientTile } from '../protocol';

const FLOWER_SEASON_KINDS: readonly TileKind[] = [
  { category: 'flower', series: 'flower', number: 1 },
  { category: 'flower', series: 'flower', number: 2 },
  { category: 'flower', series: 'flower', number: 3 },
  { category: 'flower', series: 'flower', number: 4 },
  { category: 'flower', series: 'season', number: 1 },
  { category: 'flower', series: 'season', number: 2 },
  { category: 'flower', series: 'season', number: 3 },
  { category: 'flower', series: 'season', number: 4 },
];

const ALL_KINDS: readonly TileKind[] = [...HAND_TILE_KINDS, ...FLOWER_SEASON_KINDS];

describe('tileGlyph', () => {
  it('produces a distinct (rank, glyph) pair for all 34 hand kinds + 8 flower/season kinds', () => {
    const pairs = ALL_KINDS.map((kind) => {
      const g = tileGlyph(kind);
      return `${g.rank ?? ''}|${g.glyph}`;
    });
    const unique = new Set(pairs);
    expect(unique.size).toBe(ALL_KINDS.length);
  });

  it('assigns the expected accent per category/suit', () => {
    const expectAccent = (kind: TileKind, accent: AccentKey): void => {
      expect(tileGlyph(kind).accent).toBe(accent);
    };

    expectAccent({ category: 'suit', suit: 'wan', rank: 5 }, 'wan');
    expectAccent({ category: 'suit', suit: 'tong', rank: 5 }, 'tong');
    expectAccent({ category: 'suit', suit: 'tiao', rank: 5 }, 'tiao');
    expectAccent({ category: 'wind', wind: 'east' }, 'wind');
    expectAccent({ category: 'wind', wind: 'south' }, 'wind');
    expectAccent({ category: 'wind', wind: 'west' }, 'wind');
    expectAccent({ category: 'wind', wind: 'north' }, 'wind');
    expectAccent({ category: 'dragon', dragon: 'red' }, 'dragon-red');
    expectAccent({ category: 'dragon', dragon: 'green' }, 'dragon-green');
    expectAccent({ category: 'dragon', dragon: 'white' }, 'dragon-white');
    expectAccent({ category: 'flower', series: 'flower', number: 1 }, 'flower');
    expectAccent({ category: 'flower', series: 'season', number: 1 }, 'flower');
  });

  it('produces the expected glyph characters', () => {
    expect(tileGlyph({ category: 'suit', suit: 'wan', rank: 1 }).glyph).toBe('萬');
    expect(tileGlyph({ category: 'suit', suit: 'tong', rank: 1 }).glyph).toBe('筒');
    expect(tileGlyph({ category: 'suit', suit: 'tiao', rank: 1 }).glyph).toBe('條');
    expect(tileGlyph({ category: 'wind', wind: 'east' }).glyph).toBe('東');
    expect(tileGlyph({ category: 'wind', wind: 'south' }).glyph).toBe('南');
    expect(tileGlyph({ category: 'wind', wind: 'west' }).glyph).toBe('西');
    expect(tileGlyph({ category: 'wind', wind: 'north' }).glyph).toBe('北');
    expect(tileGlyph({ category: 'dragon', dragon: 'red' }).glyph).toBe('中');
    expect(tileGlyph({ category: 'dragon', dragon: 'green' }).glyph).toBe('發');
    expect(tileGlyph({ category: 'dragon', dragon: 'white' }).glyph).toBe('白');
    expect(tileGlyph({ category: 'flower', series: 'flower', number: 1 }).glyph).toBe('梅');
    expect(tileGlyph({ category: 'flower', series: 'flower', number: 2 }).glyph).toBe('蘭');
    expect(tileGlyph({ category: 'flower', series: 'flower', number: 3 }).glyph).toBe('菊');
    expect(tileGlyph({ category: 'flower', series: 'flower', number: 4 }).glyph).toBe('竹');
    expect(tileGlyph({ category: 'flower', series: 'season', number: 1 }).glyph).toBe('春');
    expect(tileGlyph({ category: 'flower', series: 'season', number: 2 }).glyph).toBe('夏');
    expect(tileGlyph({ category: 'flower', series: 'season', number: 3 }).glyph).toBe('秋');
    expect(tileGlyph({ category: 'flower', series: 'season', number: 4 }).glyph).toBe('冬');
  });
});

describe('sortTilesForDisplay', () => {
  function ct(id: string, kind: TileKind): ClientTile {
    return { id, kind };
  }

  it('orders tiles in canonical HAND_TILE_KINDS order, with flowers/seasons after honors', () => {
    const input: ClientTile[] = [
      ct('season1', { category: 'flower', series: 'season', number: 1 }),
      ct('dragon-red', { category: 'dragon', dragon: 'red' }),
      ct('wan1', { category: 'suit', suit: 'wan', rank: 1 }),
      ct('flower2', { category: 'flower', series: 'flower', number: 2 }),
      ct('wind-east', { category: 'wind', wind: 'east' }),
      ct('tong9', { category: 'suit', suit: 'tong', rank: 9 }),
    ];
    const sorted = sortTilesForDisplay(input);
    expect(sorted.map((t) => t.id)).toEqual(['wan1', 'tong9', 'wind-east', 'dragon-red', 'flower2', 'season1']);
  });

  it('is stable across identical-kind tiles (preserves input relative order for ties)', () => {
    const kind: TileKind = { category: 'suit', suit: 'wan', rank: 3 };
    const input: ClientTile[] = [ct('wan3-a', kind), ct('wan3-b', kind), ct('wan3-c', kind)];
    const sorted = sortTilesForDisplay(input);
    expect(sorted.map((t) => t.id)).toEqual(['wan3-a', 'wan3-b', 'wan3-c']);
  });

  it('does not mutate its input array', () => {
    const input: ClientTile[] = [
      ct('tong9', { category: 'suit', suit: 'tong', rank: 9 }),
      ct('wan1', { category: 'suit', suit: 'wan', rank: 1 }),
    ];
    const inputCopy = [...input];
    sortTilesForDisplay(input);
    expect(input).toEqual(inputCopy);
  });

  // --- Tester round: real shuffled-then-sorted round trip (not a hand-picked example) ---

  /** Deterministic LCG so failures are reproducible without a real RNG dependency. */
  function seededShuffle<T>(items: readonly T[], seed: number): T[] {
    let state = seed;
    const next = (): number => {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      return state / 0x7fffffff;
    };
    const arr = [...items];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(next() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  it('preserves relative input order for same-kind tiles under a real shuffled full-set round trip (5 seeds)', () => {
    // Build a realistic 4-copies-per-hand-kind pool (like a real wall) so
    // every kind has multiple tiles competing for tie-break order, plus all
    // 8 flower/season singles.
    const pool: ClientTile[] = [];
    let counter = 0;
    for (const kind of HAND_TILE_KINDS) {
      for (let copy = 0; copy < 4; copy++) {
        counter += 1;
        pool.push(ct(`${JSON.stringify(kind)}-copy${copy}-seq${counter}`, kind));
      }
    }
    for (const kind of FLOWER_SEASON_KINDS) {
      counter += 1;
      pool.push(ct(`${JSON.stringify(kind)}-flower-seq${counter}`, kind));
    }

    for (const seed of [1, 7, 42, 12345, 999983]) {
      const shuffled = seededShuffle(pool, seed);
      const sorted = sortTilesForDisplay(shuffled);

      // Sanity: sorting is a permutation, not a filter/loss.
      expect(sorted.map((t) => t.id).sort()).toEqual(pool.map((t) => t.id).sort());

      // Group the SORTED output by kind, so we can check stability within
      // each kind's bucket against the shuffled INPUT's relative order
      // (stability is a property of "input order in -> output order for
      // ties", not of some other reference ordering).
      const kindKeyOf = (t: ClientTile): string => JSON.stringify(t.kind);

      const byKind = new Map<string, ClientTile[]>();
      for (const t of sorted) {
        const key = kindKeyOf(t);
        const bucket = byKind.get(key) ?? [];
        bucket.push(t);
        byKind.set(key, bucket);
      }

      for (const [, bucket] of byKind) {
        if (bucket.length < 2) continue;
        // Within this kind's bucket, ids must appear in the same relative
        // order they had in the SHUFFLED INPUT (that's what "stable" means).
        const shuffledOrderIndex = new Map(shuffled.map((t, i) => [t.id, i]));
        const indices = bucket.map((t) => shuffledOrderIndex.get(t.id)!);
        const sortedIndices = [...indices].sort((a, b) => a - b);
        expect(indices).toEqual(sortedIndices);
      }

      // Guard against the test accidentally being vacuous (i.e. actually
      // exercising ties): every hand kind has 4 copies, so there must be at
      // least one multi-tile bucket.
      expect([...byKind.values()].some((bucket) => bucket.length > 1)).toBe(true);
    }
  });
});

describe('seatPositionFor', () => {
  it('puts the viewer at bottom and nextSeat at right for all four possible viewer seats', () => {
    for (const viewerSeat of SEATS) {
      expect(seatPositionFor(viewerSeat, viewerSeat)).toBe('bottom');
      const right = ((viewerSeat + 1) % 4) as Seat;
      const top = ((viewerSeat + 2) % 4) as Seat;
      const left = ((viewerSeat + 3) % 4) as Seat;
      expect(seatPositionFor(right, viewerSeat)).toBe('right');
      expect(seatPositionFor(top, viewerSeat)).toBe('top');
      expect(seatPositionFor(left, viewerSeat)).toBe('left');
    }
  });
});

describe('meldFaceDown', () => {
  function meld(kind: ClientMeld['kind'], concealed: boolean): ClientMeld {
    return { kind, concealed, tiles: [] };
  }

  it('is false for own concealed kong', () => {
    expect(meldFaceDown(meld('kong', true), true)).toBe(false);
  });

  it('is false for opponent exposed kong', () => {
    expect(meldFaceDown(meld('kong', false), false)).toBe(false);
  });

  it('is false for opponent pung', () => {
    expect(meldFaceDown(meld('pung', false), false)).toBe(false);
  });

  it('is false for opponent chow', () => {
    expect(meldFaceDown(meld('chow', false), false)).toBe(false);
  });

  it('is true only for an opponent concealed kong', () => {
    expect(meldFaceDown(meld('kong', true), false)).toBe(true);
  });

  // --- Tester round: exhaustive over the reachable subset of kind x concealed x owner ---
  //
  // The full cross product is kind(chow|pung|kong) x concealed(true|false) x
  // owner(viewer|opponent) = 12 combinations. Per the engine's own invariant
  // (src/engine/actions.ts's assertValidPlayerHand: "only kong melds may be
  // concealed", enforced by a throw on any hand carrying a concealed
  // chow/pung; mirrored in the PlayerMeld type comment "concealed: True only
  // for kongs (暗槓); chow/pung melds are always exposed (false)") a
  // concealed chow or concealed pung can never occur in real server state.
  // That rules out 4 of the 12 (chow/pung x concealed=true x owner=true/false),
  // leaving 8 reachable combinations. This block covers all 8, including the
  // 3 not covered by the tests above (own exposed kong, own pung, own chow).
  it('is false for every REACHABLE combination except opponent concealed kong (8 reachable combos)', () => {
    const reachableCases: Array<{ kind: ClientMeld['kind']; concealed: boolean; ownerIsViewer: boolean; expected: boolean }> = [
      { kind: 'kong', concealed: true, ownerIsViewer: true, expected: false }, // own concealed kong
      { kind: 'kong', concealed: true, ownerIsViewer: false, expected: true }, // opponent concealed kong (the ONLY true case)
      { kind: 'kong', concealed: false, ownerIsViewer: true, expected: false }, // own exposed kong
      { kind: 'kong', concealed: false, ownerIsViewer: false, expected: false }, // opponent exposed kong
      { kind: 'pung', concealed: false, ownerIsViewer: true, expected: false }, // own pung (pungs are never concealed)
      { kind: 'pung', concealed: false, ownerIsViewer: false, expected: false }, // opponent pung
      { kind: 'chow', concealed: false, ownerIsViewer: true, expected: false }, // own chow (chows are never concealed)
      { kind: 'chow', concealed: false, ownerIsViewer: false, expected: false }, // opponent chow
    ];

    for (const { kind, concealed, ownerIsViewer, expected } of reachableCases) {
      expect(meldFaceDown(meld(kind, concealed), ownerIsViewer)).toBe(expected);
    }
  });

  // --- Coverage-gap disclosure (documented, not asserted as a "bug") ---
  //
  // The 4 UNREACHABLE combinations (concealed chow/pung) are structurally
  // impossible per the engine invariant above, so the server can never emit
  // them over the wire — but the TS type of ClientMeld does not itself
  // forbid `{ kind: 'chow', concealed: true }` (concealed is just `boolean`
  // on the wire type), so meldFaceDown as a pure function still has a
  // defined answer for them. This test documents (not "SHIP"-blocks) that
  // answer: the formula's `meld.kind === 'kong'` guard means an (illegal)
  // "concealed chow/pung" would NOT be treated as face-down. This is
  // currently inert (the state can never arise), but it is worth the
  // builder/reviewer knowing this is the fallback behavior should the
  // upstream invariant ever be violated by a future bug elsewhere.
  it('documents (does not validate as correct) the fallback for the structurally-unreachable "concealed chow/pung" shape', () => {
    expect(meldFaceDown(meld('chow', true), false)).toBe(false);
    expect(meldFaceDown(meld('pung', true), false)).toBe(false);
  });
});
