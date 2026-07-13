/**
 * Targeted adversarial tests for src/engine/flowers.ts, beyond the builder's
 * flowers.test.ts (23 tests), per the tester's mandatory flower-replacement
 * checklist (CLAUDE.md) and docs/RULES.md §5, §3.3 step 3, §10.
 *
 * This file is verification-only: it must never import anything that would
 * let it silently pass by re-implementing the logic under test. Where a test
 * demonstrates a suspected bug rather than confirming correct behavior, it is
 * labeled BUG in the test name and left failing (never softened) so it shows
 * up as a build/test failure until the builder fixes flowers.ts.
 */
import { describe, expect, it } from 'vitest';
import { replaceOneFlower, resolveFlowerChain, resolveInitialDeal } from './flowers';
import {
  isFlowerTile,
  kindKey,
  type DragonName,
  type FlowerNumber,
  type Rank,
  type SuitName,
  type Tile,
  type TileKind,
  type WindName,
} from './tiles';
import type { DealResult } from './deal';
import type { Wall } from './wall';
import { DEFAULT_RULES, type RulesConfig } from './rules-config';

// --- Test-local shorthand tile builder (same convention as flowers.test.ts) ---
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
  return { id: `${kindKey(kind)}-adv${idCounter}`, kind };
}

/** Builds a Wall from head-to-tail order (index 0 = head, last index = tail). */
function wallOf(...tiles: Tile[]): Wall {
  return tiles;
}

function ids(tiles: readonly Tile[]): string[] {
  return tiles.map((t) => t.id);
}

function nonFlowerRun(count: number, suit: string): Tile[] {
  return Array.from({ length: count }, (_, i) => tile(suit + ((i % 9) + 1)));
}

// ---------------------------------------------------------------------------
// 1. Exhaustion mid-processing: what happens to not-yet-reached seats?
// ---------------------------------------------------------------------------
describe('resolveInitialDeal — exhaustion mid-processing (unprocessed seats)', () => {
  it('seats not yet reached in turn order at exhaustion time keep their raw dealt hand, with empty flowers', () => {
    const seat0Hand = nonFlowerRun(16, 'wan');
    const seat1Hand = nonFlowerRun(16, 'tong');
    const seat2Hand = [...nonFlowerRun(15, 'tiao'), tile('flower1')];
    // Seat 3 (never reached — exhaustion happens while processing seat 2) has
    // a real, fully-dealt 16-tile hand including a flower of its own.
    const seat3FlowerA = tile('season1');
    const seat3FlowerB = tile('season2');
    const seat3Hand = [...nonFlowerRun(14, 'wan'), seat3FlowerA, seat3FlowerB];

    const hands: [Tile[], Tile[], Tile[], Tile[]] = [seat0Hand, seat1Hand, seat2Hand, seat3Hand];
    // 3 filler tiles, deadWallReserve = 3 -> canDrawTail is false from the very
    // first draw attempt (seat 2's single flower), so seats 2 and 3 both fail
    // to get a replacement / never get processed at all.
    const wall = wallOf(tile('wan1'), tile('wan2'), tile('wan3'));
    const dealResult: DealResult = { hands, wall };
    const rules: RulesConfig = { ...DEFAULT_RULES, deadWallReserve: 3 };

    const result = resolveInitialDeal(dealResult, 0, rules);

    expect(result.exhausted).toBe(true);
    // Seat 0 and 1 (already fully processed, zero flowers) pass through untouched.
    expect(ids(result.hands[0])).toEqual(ids(seat0Hand));
    expect(ids(result.hands[1])).toEqual(ids(seat1Hand));
    // Seat 2 (blocked mid-processing): keeps its non-flower tiles, flower recorded,
    // but the reserve blocks any replacement draw.
    expect(result.hands[2]).toHaveLength(15);
    expect(ids(result.flowers[2])).toEqual([seat2Hand[15].id]);
    // Seat 3 was never reached in turn order. Fixed behavior: its raw dealt
    // hand (including its own unresolved flowers) is conserved as-is, with
    // an empty flowers array (nothing was ever exposed/resolved for it).
    expect(ids(result.hands[3])).toEqual(ids(seat3Hand));
    expect(result.flowers[3]).toEqual([]);
  });

  it('conservation holds on exhaustion: seat 3\'s dealt tiles are preserved in hands, flowers, or wall', () => {
    const seat0Hand = nonFlowerRun(16, 'wan');
    const seat1Hand = nonFlowerRun(16, 'tong');
    const seat2Hand = [...nonFlowerRun(15, 'tiao'), tile('flower1')];
    const seat3FlowerA = tile('season1');
    const seat3FlowerB = tile('season2');
    const seat3Hand = [...nonFlowerRun(14, 'wan'), seat3FlowerA, seat3FlowerB];

    const hands: [Tile[], Tile[], Tile[], Tile[]] = [seat0Hand, seat1Hand, seat2Hand, seat3Hand];
    const wall = wallOf(tile('wan1'), tile('wan2'), tile('wan3'));
    const dealResult: DealResult = { hands, wall };
    const rules: RulesConfig = { ...DEFAULT_RULES, deadWallReserve: 3 };

    const result = resolveInitialDeal(dealResult, 0, rules);

    const outputIds = [
      ...result.hands.flatMap((h) => ids(h)),
      ...result.flowers.flatMap((f) => ids(f)),
      ...ids(result.wall),
    ];
    const inputIds = [...dealResult.hands.flatMap((h) => ids(h)), ...ids(dealResult.wall)];

    // Seat 3's entire 16-tile dealt hand (including seat3FlowerA / seat3FlowerB)
    // must be conserved somewhere in the return value: resolveInitialDeal's
    // contract is that result.hands/result.flowers/result.wall together are
    // the authoritative post-exhaustion state, so no tile may be silently
    // dropped just because that seat's turn was never reached.
    expect(new Set(outputIds)).toEqual(new Set(inputIds));
  });

  it('partial credit IS preserved for the actively-blocked seat itself (contrast with the bug above)', () => {
    // Seat 0 has two flowers: flowerA resolves cleanly to a non-flower tile;
    // flowerB's first replacement is itself a flower (chains), and the second
    // draw needed to finish that chain is blocked by the reserve.
    const nonFlowers = nonFlowerRun(14, 'wan');
    const flowerA = tile('flower1');
    const flowerB = tile('flower2');
    const seat0Hand = [...nonFlowers, flowerA, flowerB];
    const otherHand = () => nonFlowerRun(16, 'tong');
    const hands: [Tile[], Tile[], Tile[], Tile[]] = [seat0Hand, otherHand(), otherHand(), otherHand()];

    const replacementForA = tile('wan9'); // drawn first, non-flower, ends flowerA's chain
    const chainedFlower = tile('season1'); // drawn second (for flowerB), itself a flower
    // Tail draw order: replacementForA (1st), chainedFlower (2nd); a 3rd draw
    // (needed to finish flowerB's chain) is blocked by deadWallReserve = 0
    // once the wall is empty.
    const wall = wallOf(chainedFlower, replacementForA);
    const dealResult: DealResult = { hands, wall };
    const rules: RulesConfig = { ...DEFAULT_RULES, deadWallReserve: 0 };

    const result = resolveInitialDeal(dealResult, 0, rules);

    expect(result.exhausted).toBe(true);
    expect(ids(result.hands[0])).toEqual([...ids(nonFlowers), replacementForA.id]);
    expect(result.hands[0]).toHaveLength(15);
    expect(ids(result.flowers[0])).toEqual([flowerA.id, flowerB.id, chainedFlower.id]);
    expect(result.wall).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. Reserve boundary, stress further: deadWallReserve = 0, and
//    deadWallReserve >= entire wall size.
// ---------------------------------------------------------------------------
describe('replaceOneFlower — reserve boundary stress', () => {
  it('deadWallReserve = 0 allows drawing the wall all the way down to fully empty', () => {
    const only = tile('wan5');
    const wall = wallOf(only);
    const rules: RulesConfig = { ...DEFAULT_RULES, deadWallReserve: 0 };

    const result = replaceOneFlower(wall, rules);

    expect(result.tile?.id).toBe(only.id);
    expect(result.chainedFlowers).toEqual([]);
    expect(result.wall).toEqual([]);
    expect(result.wall).toHaveLength(0);
  });

  it('deadWallReserve = 0 with an already-empty wall blocks immediately, no throw', () => {
    const wall = wallOf();
    const rules: RulesConfig = { ...DEFAULT_RULES, deadWallReserve: 0 };

    expect(() => replaceOneFlower(wall, rules)).not.toThrow();
    const result = replaceOneFlower(wall, rules);

    expect(result.tile).toBeNull();
    expect(result.chainedFlowers).toEqual([]);
    expect(result.wall).toBe(wall);
  });

  it('deadWallReserve exactly equal to the wall size blocks immediately (boundary), wall untouched by reference', () => {
    const tiles = [tile('wan1'), tile('wan2')];
    const wall = wallOf(...tiles);
    const rules: RulesConfig = { ...DEFAULT_RULES, deadWallReserve: tiles.length };

    const result = replaceOneFlower(wall, rules);

    expect(result.tile).toBeNull();
    expect(result.wall).toBe(wall);
  });

  it('deadWallReserve vastly greater than the entire wall size guarantees immediate exhaustion, no throw, no partial draw', () => {
    const tiles = [tile('wan1'), tile('wan2'), tile('wan3')];
    const wall = wallOf(...tiles);
    const rules: RulesConfig = { ...DEFAULT_RULES, deadWallReserve: 1_000_000 };

    expect(() => replaceOneFlower(wall, rules)).not.toThrow();
    const result = replaceOneFlower(wall, rules);

    expect(result.tile).toBeNull();
    expect(result.chainedFlowers).toEqual([]);
    expect(result.wall).toBe(wall);
  });
});

// ---------------------------------------------------------------------------
// 3 & 4. Wall tail vs. head interaction + all 8 flower kinds in one chain.
// ---------------------------------------------------------------------------
describe('replaceOneFlower / resolveFlowerChain — head is never touched, even through a full 8-flower chain', () => {
  it('replaceOneFlower: a chain through all 8 distinct flower/season kinds never consumes the head tiles', () => {
    const headA = tile('wan1'); // distinguishable head sentinel
    const headB = tile('wan2'); // distinguishable head sentinel
    const finalTile = tile('tiao9');
    const f1 = tile('flower1');
    const f2 = tile('flower2');
    const f3 = tile('flower3');
    const f4 = tile('flower4');
    const s1 = tile('season1');
    const s2 = tile('season2');
    const s3 = tile('season3');
    const s4 = tile('season4');
    // Draw order (tail pops from the end first): f1, f2, f3, f4, s1, s2, s3, s4, finalTile.
    const wall = wallOf(headA, headB, finalTile, s4, s3, s2, s1, f4, f3, f2, f1);
    const rules: RulesConfig = { ...DEFAULT_RULES, deadWallReserve: 0 };

    const result = replaceOneFlower(wall, rules);

    expect(result.tile?.id).toBe(finalTile.id);
    expect(ids(result.chainedFlowers)).toEqual([f1.id, f2.id, f3.id, f4.id, s1.id, s2.id, s3.id, s4.id]);
    // Head sentinels remain, untouched, in original relative order.
    expect(ids(result.wall)).toEqual([headA.id, headB.id]);
  });

  it('resolveFlowerChain: firstDrawnTile is a flower that chains through the remaining 7 flower kinds before a non-flower; head untouched', () => {
    const headA = tile('wan1');
    const headB = tile('wan2');
    const finalTile = tile('tiao9');
    const firstDrawn = tile('flower1'); // already "drawn" outside the wall
    const f2 = tile('flower2');
    const f3 = tile('flower3');
    const f4 = tile('flower4');
    const s1 = tile('season1');
    const s2 = tile('season2');
    const s3 = tile('season3');
    const s4 = tile('season4');
    // Draw order (tail pops from the end first): f2, f3, f4, s1, s2, s3, s4, finalTile.
    const wall = wallOf(headA, headB, finalTile, s4, s3, s2, s1, f4, f3, f2);
    const rules: RulesConfig = { ...DEFAULT_RULES, deadWallReserve: 0 };

    const result = resolveFlowerChain(wall, firstDrawn, rules);

    expect(result.finalTile?.id).toBe(finalTile.id);
    expect(ids(result.exposedFlowers)).toEqual([
      firstDrawn.id,
      f2.id,
      f3.id,
      f4.id,
      s1.id,
      s2.id,
      s3.id,
      s4.id,
    ]);
    expect(ids(result.wall)).toEqual([headA.id, headB.id]);
  });

  it('a flower that is the literal last physical tile remaining in the wall triggers exhaustion with the wall fully drained (not merely below reserve)', () => {
    // The flower is the ONLY tile left. It is legally drawable (remaining=1 >
    // deadWallReserve=0), gets exposed, but the chain's next draw attempt
    // finds an empty wall and blocks — the wall ends up fully drained, not
    // just "below reserve with tiles still sitting in it".
    const lastFlower = tile('flower4');
    const wall = wallOf(lastFlower);
    const rules: RulesConfig = { ...DEFAULT_RULES, deadWallReserve: 0 };

    const result = replaceOneFlower(wall, rules);

    expect(result.tile).toBeNull();
    expect(ids(result.chainedFlowers)).toEqual([lastFlower.id]);
    expect(result.wall).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 5. resolveInitialDeal — mixed multi-seat scenario with chains in multiple
//    seats simultaneously (A: 2 flowers, one chains; B: 0; C: 1; D: 3).
// ---------------------------------------------------------------------------
describe('resolveInitialDeal — mixed multi-seat scenario (A:2 w/ chain, B:0, C:1, D:3)', () => {
  it('every seat is attributed its own flowers/replacements correctly and the whole DealResult is conserved', () => {
    // Seat 0 (A): flowerA1 resolves in one draw; flowerA2's first replacement
    // is itself a flower (chains once more) before landing on a non-flower.
    const nfA = nonFlowerRun(14, 'wan');
    const flowerA1 = tile('flower1');
    const flowerA2 = tile('flower2');
    const seat0Hand = [...nfA, flowerA1, flowerA2];

    // Seat 1 (B): no flowers at all.
    const seat1Hand = nonFlowerRun(16, 'tong');

    // Seat 2 (C): exactly one flower, one clean replacement.
    const nfC = nonFlowerRun(15, 'tiao');
    const flowerC = tile('season1');
    const seat2Hand = [...nfC, flowerC];

    // Seat 3 (D): three flowers, each with a clean (non-chaining) replacement.
    const nfD = nonFlowerRun(13, 'wan');
    const flowerD1 = tile('season2');
    const flowerD2 = tile('season3');
    const flowerD3 = tile('season4');
    const seat3Hand = [...nfD, flowerD1, flowerD2, flowerD3];

    const hands: [Tile[], Tile[], Tile[], Tile[]] = [seat0Hand, seat1Hand, seat2Hand, seat3Hand];

    const headSentinel = tile('wan9');
    const rA1 = tile('tong1'); // draw 1: seat0 flowerA1's replacement
    const chainFlower = tile('flower3'); // draw 2: seat0 flowerA2's first (chaining) replacement
    const rA2 = tile('tong2'); // draw 3: seat0 flowerA2's final replacement
    const rC = tile('tong3'); // draw 4: seat2 flowerC's replacement
    const rD1 = tile('tong4'); // draw 5
    const rD2 = tile('tong5'); // draw 6
    const rD3 = tile('tong6'); // draw 7
    // Tail draw order (pops from the end first): rA1, chainFlower, rA2, rC, rD1, rD2, rD3.
    const wall = wallOf(headSentinel, rD3, rD2, rD1, rC, rA2, chainFlower, rA1);
    const dealResult: DealResult = { hands, wall };
    const rules: RulesConfig = { ...DEFAULT_RULES, deadWallReserve: 0 };

    const result = resolveInitialDeal(dealResult, 0, rules);

    expect(result.exhausted).toBe(false);

    // Seat 0 (A)
    expect(ids(result.hands[0])).toEqual([...ids(nfA), rA1.id, rA2.id]);
    expect(result.hands[0]).toHaveLength(16);
    expect(ids(result.flowers[0])).toEqual([flowerA1.id, flowerA2.id, chainFlower.id]);

    // Seat 1 (B)
    expect(ids(result.hands[1])).toEqual(ids(seat1Hand));
    expect(result.flowers[1]).toEqual([]);

    // Seat 2 (C)
    expect(ids(result.hands[2])).toEqual([...ids(nfC), rC.id]);
    expect(ids(result.flowers[2])).toEqual([flowerC.id]);

    // Seat 3 (D)
    expect(ids(result.hands[3])).toEqual([...ids(nfD), rD1.id, rD2.id, rD3.id]);
    expect(ids(result.flowers[3])).toEqual([flowerD1.id, flowerD2.id, flowerD3.id]);

    // Final wall: only the head sentinel remains.
    expect(ids(result.wall)).toEqual([headSentinel.id]);

    // Full conservation across the entire DealResult.
    const outputIds = [
      ...result.hands.flatMap((h) => ids(h)),
      ...result.flowers.flatMap((f) => ids(f)),
      ...ids(result.wall),
    ];
    const inputIds = [...dealResult.hands.flatMap((h) => ids(h)), ...ids(dealResult.wall)];
    expect(outputIds).toHaveLength(inputIds.length);
    expect(new Set(outputIds).size).toBe(outputIds.length);
    expect(new Set(outputIds)).toEqual(new Set(inputIds));
  });
});

// ---------------------------------------------------------------------------
// 6. Turn-order correctness for dealer = 0, 1, 3 (builder's plan only covered
//    dealer = 2).
// ---------------------------------------------------------------------------
describe('resolveInitialDeal — turn order for every dealer seat', () => {
  it('dealer = 0: processing order 0,1,2,3', () => {
    const makeHandWithFlower = (flowerTile: Tile) => [...nonFlowerRun(15, 'wan'), flowerTile];
    const flower0 = tile('flower1');
    const flower1 = tile('flower2');
    const flower2 = tile('flower3');
    const flower3 = tile('flower4');
    const hands: [Tile[], Tile[], Tile[], Tile[]] = [
      makeHandWithFlower(flower0),
      makeHandWithFlower(flower1),
      makeHandWithFlower(flower2),
      makeHandWithFlower(flower3),
    ];

    const r0 = tile('tong4');
    const r1 = tile('tong3');
    const r2 = tile('tong2');
    const r3 = tile('tong1');
    // Turn order for dealer=0: 0,1,2,3. Tail draw order: r0, r1, r2, r3.
    const wall = wallOf(r3, r2, r1, r0);
    const dealResult: DealResult = { hands, wall };
    const rules: RulesConfig = { ...DEFAULT_RULES, deadWallReserve: 0 };

    const result = resolveInitialDeal(dealResult, 0, rules);

    expect(result.exhausted).toBe(false);
    expect(result.hands[0][result.hands[0].length - 1].id).toBe(r0.id);
    expect(result.hands[1][result.hands[1].length - 1].id).toBe(r1.id);
    expect(result.hands[2][result.hands[2].length - 1].id).toBe(r2.id);
    expect(result.hands[3][result.hands[3].length - 1].id).toBe(r3.id);
  });

  it('dealer = 1: processing order 1,2,3,0', () => {
    const makeHandWithFlower = (flowerTile: Tile) => [...nonFlowerRun(15, 'wan'), flowerTile];
    const flower0 = tile('flower1');
    const flower1 = tile('flower2');
    const flower2 = tile('flower3');
    const flower3 = tile('flower4');
    const hands: [Tile[], Tile[], Tile[], Tile[]] = [
      makeHandWithFlower(flower0),
      makeHandWithFlower(flower1),
      makeHandWithFlower(flower2),
      makeHandWithFlower(flower3),
    ];

    const r1 = tile('tong4');
    const r2 = tile('tong3');
    const r3 = tile('tong2');
    const r0 = tile('tong1');
    // Turn order for dealer=1: 1,2,3,0. Tail draw order: r1, r2, r3, r0.
    const wall = wallOf(r0, r3, r2, r1);
    const dealResult: DealResult = { hands, wall };
    const rules: RulesConfig = { ...DEFAULT_RULES, deadWallReserve: 0 };

    const result = resolveInitialDeal(dealResult, 1, rules);

    expect(result.exhausted).toBe(false);
    expect(result.hands[1][result.hands[1].length - 1].id).toBe(r1.id);
    expect(result.hands[2][result.hands[2].length - 1].id).toBe(r2.id);
    expect(result.hands[3][result.hands[3].length - 1].id).toBe(r3.id);
    expect(result.hands[0][result.hands[0].length - 1].id).toBe(r0.id);
  });

  it('dealer = 3: processing order 3,0,1,2', () => {
    const makeHandWithFlower = (flowerTile: Tile) => [...nonFlowerRun(15, 'wan'), flowerTile];
    const flower0 = tile('flower1');
    const flower1 = tile('flower2');
    const flower2 = tile('flower3');
    const flower3 = tile('flower4');
    const hands: [Tile[], Tile[], Tile[], Tile[]] = [
      makeHandWithFlower(flower0),
      makeHandWithFlower(flower1),
      makeHandWithFlower(flower2),
      makeHandWithFlower(flower3),
    ];

    const r3 = tile('tong4');
    const r0 = tile('tong3');
    const r1 = tile('tong2');
    const r2 = tile('tong1');
    // Turn order for dealer=3: 3,0,1,2. Tail draw order: r3, r0, r1, r2.
    const wall = wallOf(r2, r1, r0, r3);
    const dealResult: DealResult = { hands, wall };
    const rules: RulesConfig = { ...DEFAULT_RULES, deadWallReserve: 0 };

    const result = resolveInitialDeal(dealResult, 3, rules);

    expect(result.exhausted).toBe(false);
    expect(result.hands[3][result.hands[3].length - 1].id).toBe(r3.id);
    expect(result.hands[0][result.hands[0].length - 1].id).toBe(r0.id);
    expect(result.hands[1][result.hands[1].length - 1].id).toBe(r1.id);
    expect(result.hands[2][result.hands[2].length - 1].id).toBe(r2.id);
  });
});

// ---------------------------------------------------------------------------
// 7. Wall reference identity where the plan implies "wall untouched".
// ---------------------------------------------------------------------------
describe('wall reference identity ("untouched" means same reference, not just equal content)', () => {
  it('resolveInitialDeal: zero flowers anywhere, even with a degenerate huge reserve, returns the exact same wall reference (no draw ever attempted)', () => {
    const hands: [Tile[], Tile[], Tile[], Tile[]] = [
      nonFlowerRun(16, 'wan'),
      nonFlowerRun(16, 'tong'),
      nonFlowerRun(16, 'tiao'),
      nonFlowerRun(16, 'wan'),
    ];
    const wall = wallOf(tile('wan1'));
    const dealResult: DealResult = { hands, wall };
    // Reserve larger than the wall: if any draw were (incorrectly) attempted,
    // it would report exhausted. Zero flowers means canDrawTail must never
    // even be called.
    const rules: RulesConfig = { ...DEFAULT_RULES, deadWallReserve: 999 };

    const result = resolveInitialDeal(dealResult, 2, rules);

    expect(result.exhausted).toBe(false);
    expect(result.wall).toBe(wall);
  });

  it('replaceOneFlower: reserve blocks the very first draw attempt — wall returned is the same reference as the input, not merely equal content', () => {
    const tiles = [tile('wan1'), tile('wan2'), tile('wan3')];
    const wall = wallOf(...tiles);
    const rules: RulesConfig = { ...DEFAULT_RULES, deadWallReserve: 3 };

    const result = replaceOneFlower(wall, rules);

    expect(result.wall).toBe(wall);
    // Reference equality also implies content equality, but assert both so a
    // future refactor to "equal but new array" is caught explicitly.
    expect(result.wall === wall).toBe(true);
  });

  it('resolveFlowerChain: non-flower first tile is a pure no-op — same wall reference returned', () => {
    const firstDrawn = tile('wan1');
    const wall = wallOf(tile('wan2'), tile('wan3'));

    const result = resolveFlowerChain(wall, firstDrawn, DEFAULT_RULES);

    expect(result.wall).toBe(wall);
  });
});

// ---------------------------------------------------------------------------
// Sanity: isFlowerTile helper agreement (guards against a mismatched
// flower-detection function silently changing behavior above).
// ---------------------------------------------------------------------------
describe('sanity', () => {
  it('every tile spec used for flower kinds in this file is actually classified as a flower by isFlowerTile', () => {
    const specs = ['flower1', 'flower2', 'flower3', 'flower4', 'season1', 'season2', 'season3', 'season4'];
    for (const spec of specs) {
      expect(isFlowerTile(tile(spec))).toBe(true);
    }
  });
});
