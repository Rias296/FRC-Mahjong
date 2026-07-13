import { describe, expect, it } from 'vitest';
import { replaceOneFlower, resolveFlowerChain, resolveInitialDeal } from './flowers';
import {
  createTileSet,
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
import { shuffle } from './shuffle';
import { deal, type DealResult } from './deal';
import type { Wall } from './wall';
import type { Seat } from './seats';
import { DEFAULT_RULES, type RulesConfig } from './rules-config';

// --- Test-local shorthand tile builder (duplicated per-file convention, see rob-kong.test.ts) ---
// Suit tiles: 'wan1'..'wan9', 'tong1'..'tong9', 'tiao1'..'tiao9'.
// Honors: 'east' | 'south' | 'west' | 'north' | 'red' | 'green' | 'white'.
// Flowers: 'flower1'..'flower4', 'season1'..'season4'.
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

/** Builds a Wall from head-to-tail order (index 0 = head, last index = tail). */
function wallOf(...tiles: Tile[]): Wall {
  return tiles;
}

function ids(tiles: readonly Tile[]): string[] {
  return tiles.map((t) => t.id);
}

describe('replaceOneFlower', () => {
  it('draws one non-flower tile from the tail and returns it with no chained flowers', () => {
    const filler = tile('wan1');
    const tailTile = tile('wan2');
    const wall = wallOf(filler, tailTile);
    const rules: RulesConfig = { ...DEFAULT_RULES, deadWallReserve: 0 };

    const result = replaceOneFlower(wall, rules);

    expect(result.tile?.id).toBe(tailTile.id);
    expect(result.chainedFlowers).toEqual([]);
    expect(ids(result.wall)).toEqual([filler.id]);
  });

  it('chains internally when the tail tile is a flower (flower then non-flower)', () => {
    const filler = tile('wan1');
    const replacement = tile('wan2');
    const flowerTile = tile('flower1');
    const wall = wallOf(filler, replacement, flowerTile);
    const rules: RulesConfig = { ...DEFAULT_RULES, deadWallReserve: 0 };

    const result = replaceOneFlower(wall, rules);

    expect(result.tile?.id).toBe(replacement.id);
    expect(ids(result.chainedFlowers)).toEqual([flowerTile.id]);
    expect(ids(result.wall)).toEqual([filler.id]);
  });

  it('chains through three consecutive tail flowers before a non-flower', () => {
    const filler = tile('wan1');
    const replacement = tile('wan2');
    const flowerA = tile('flower1');
    const flowerB = tile('flower2');
    const flowerC = tile('flower3');
    // Tail draw order: flowerC, flowerB, flowerA, replacement.
    const wall = wallOf(filler, replacement, flowerA, flowerB, flowerC);
    const rules: RulesConfig = { ...DEFAULT_RULES, deadWallReserve: 0 };

    const result = replaceOneFlower(wall, rules);

    expect(result.tile?.id).toBe(replacement.id);
    expect(ids(result.chainedFlowers)).toEqual([flowerC.id, flowerB.id, flowerA.id]);
    expect(ids(result.wall)).toEqual([filler.id]);
  });

  it('returns tile null with wall unchanged when remaining equals deadWallReserve before the draw', () => {
    const tiles = [tile('wan1'), tile('wan2'), tile('wan3'), tile('wan4'), tile('wan5')];
    const wall = wallOf(...tiles);
    const rules: RulesConfig = { ...DEFAULT_RULES, deadWallReserve: 5 };

    const result = replaceOneFlower(wall, rules);

    expect(result.tile).toBeNull();
    expect(result.chainedFlowers).toEqual([]);
    expect(result.wall).toBe(wall);
  });

  it('draw succeeds when remaining equals deadWallReserve + 1 (last drawable tile boundary)', () => {
    const tiles = [tile('wan1'), tile('wan2'), tile('wan3'), tile('wan4'), tile('wan5'), tile('wan6')];
    const wall = wallOf(...tiles);
    const rules: RulesConfig = { ...DEFAULT_RULES, deadWallReserve: 5 };

    const result = replaceOneFlower(wall, rules);

    expect(result.tile?.id).toBe(tiles[5].id);
    expect(result.chainedFlowers).toEqual([]);
    expect(result.wall).toHaveLength(5);
  });

  it('returns tile null but reports flowers already exposed and tiles already consumed when the reserve blocks mid-chain', () => {
    const filler = tile('wan1');
    const flowerX = tile('flower1');
    const flowerY = tile('flower2');
    // Tail draw order: flowerY, flowerX; a 3rd draw is blocked by the reserve.
    const wall = wallOf(filler, flowerX, flowerY);
    const rules: RulesConfig = { ...DEFAULT_RULES, deadWallReserve: 1 };

    const result = replaceOneFlower(wall, rules);

    expect(result.tile).toBeNull();
    expect(ids(result.chainedFlowers)).toEqual([flowerY.id, flowerX.id]);
    expect(ids(result.wall)).toEqual([filler.id]);
  });

  it('does not mutate the input wall', () => {
    const filler = tile('wan1');
    const replacement = tile('wan2');
    const flowerTile = tile('flower1');
    const wall = wallOf(filler, replacement, flowerTile);
    const originalIds = ids(wall);
    const rules: RulesConfig = { ...DEFAULT_RULES, deadWallReserve: 0 };

    replaceOneFlower(wall, rules);

    expect(ids(wall)).toEqual(originalIds);
  });
});

describe('resolveFlowerChain', () => {
  it('returns a non-flower first tile immediately with no draws and the wall untouched', () => {
    const firstDrawn = tile('wan1');
    const wall = wallOf(tile('wan2'));

    const result = resolveFlowerChain(wall, firstDrawn, DEFAULT_RULES);

    expect(result.finalTile?.id).toBe(firstDrawn.id);
    expect(result.exposedFlowers).toEqual([]);
    expect(result.wall).toBe(wall);
  });

  it('resolves a single flower with one replacement; exposedFlowers is exactly the first tile', () => {
    const firstDrawn = tile('flower1');
    const filler = tile('wan1');
    const replacement = tile('wan2');
    const wall = wallOf(filler, replacement);
    const rules: RulesConfig = { ...DEFAULT_RULES, deadWallReserve: 0 };

    const result = resolveFlowerChain(wall, firstDrawn, rules);

    expect(result.finalTile?.id).toBe(replacement.id);
    expect(ids(result.exposedFlowers)).toEqual([firstDrawn.id]);
    expect(ids(result.wall)).toEqual([filler.id]);
  });

  it('resolves a chained draw (flower first tile, two more flowers off the tail) with exposedFlowers in exposure order and finalTile as the final non-flower draw', () => {
    const firstDrawn = tile('flower1');
    const filler = tile('wan1');
    const replacement = tile('wan2');
    const flowerB = tile('flower2');
    const flowerC = tile('flower3');
    const wall = wallOf(filler, replacement, flowerB, flowerC);
    const rules: RulesConfig = { ...DEFAULT_RULES, deadWallReserve: 0 };

    const result = resolveFlowerChain(wall, firstDrawn, rules);

    expect(result.finalTile?.id).toBe(replacement.id);
    expect(ids(result.exposedFlowers)).toEqual([firstDrawn.id, flowerC.id, flowerB.id]);
    expect(ids(result.wall)).toEqual([filler.id]);
  });

  it('returns finalTile null and exposedFlowers [firstTile] with wall unchanged when the flower has no legal replacement (remaining === deadWallReserve)', () => {
    const firstDrawn = tile('flower1');
    const tiles = [tile('wan1'), tile('wan2'), tile('wan3')];
    const wall = wallOf(...tiles);
    const rules: RulesConfig = { ...DEFAULT_RULES, deadWallReserve: 3 };

    const result = resolveFlowerChain(wall, firstDrawn, rules);

    expect(result.finalTile).toBeNull();
    expect(ids(result.exposedFlowers)).toEqual([firstDrawn.id]);
    expect(result.wall).toBe(wall);
  });

  it('returns finalTile null and includes mid-chain flowers in exposedFlowers when the reserve blocks partway through the chain', () => {
    const firstDrawn = tile('flower1');
    const filler = tile('wan1');
    const flowerX = tile('flower2');
    const flowerY = tile('flower3');
    const wall = wallOf(filler, flowerX, flowerY);
    const rules: RulesConfig = { ...DEFAULT_RULES, deadWallReserve: 1 };

    const result = resolveFlowerChain(wall, firstDrawn, rules);

    expect(result.finalTile).toBeNull();
    expect(ids(result.exposedFlowers)).toEqual([firstDrawn.id, flowerY.id, flowerX.id]);
    expect(ids(result.wall)).toEqual([filler.id]);
  });

  it('kong-replacement framing: calling replaceOneFlower directly (as GameState will after a kong) yields behavior identical to the flower-triggered chain on the same wall', () => {
    const filler = tile('wan1');
    const replacement = tile('wan2');
    const flowerTile = tile('flower1');
    const rules: RulesConfig = { ...DEFAULT_RULES, deadWallReserve: 0 };

    const wallForFlowerTrigger = wallOf(filler, replacement, flowerTile);
    const wallForKongTrigger = wallOf(filler, replacement, flowerTile);

    const flowerTriggeredResult = replaceOneFlower(wallForFlowerTrigger, rules);
    const kongTriggeredResult = replaceOneFlower(wallForKongTrigger, rules);

    // Same function, no special path: identical inputs produce identical outputs.
    expect(ids(kongTriggeredResult.chainedFlowers)).toEqual(ids(flowerTriggeredResult.chainedFlowers));
    expect(kongTriggeredResult.tile?.id).toBe(flowerTriggeredResult.tile?.id);
    expect(ids(kongTriggeredResult.wall)).toEqual(ids(flowerTriggeredResult.wall));

    // Matches test 2's expectations exactly on an identical wall.
    expect(kongTriggeredResult.tile?.id).toBe(replacement.id);
    expect(ids(kongTriggeredResult.chainedFlowers)).toEqual([flowerTile.id]);
  });
});

describe('resolveInitialDeal', () => {
  it('hands with zero flowers pass through untouched with the wall unchanged and exhausted false', () => {
    const makeHand = () => Array.from({ length: 16 }, (_, i) => tile('wan' + ((i % 9) + 1)));
    const hands: [Tile[], Tile[], Tile[], Tile[]] = [makeHand(), makeHand(), makeHand(), makeHand()];
    const wall = wallOf(tile('wan1'), tile('wan2'));
    const dealResult: DealResult = { hands, wall };

    const result = resolveInitialDeal(dealResult, 0, DEFAULT_RULES);

    for (let seat = 0; seat < 4; seat++) {
      expect(ids(result.hands[seat])).toEqual(ids(hands[seat]));
      expect(result.flowers[seat]).toEqual([]);
    }
    expect(result.wall).toBe(wall);
    expect(result.exhausted).toBe(false);
  });

  it('a single dealt flower is exposed to the correct seat and replaced; that hand returns to 16 non-flower tiles', () => {
    const nonFlowers = Array.from({ length: 15 }, (_, i) => tile('wan' + ((i % 9) + 1)));
    const flowerTile = tile('flower1');
    // Flower placed in the middle of the dealt order.
    const seat2Hand = [...nonFlowers.slice(0, 7), flowerTile, ...nonFlowers.slice(7)];
    const otherHand = () => Array.from({ length: 16 }, (_, i) => tile('tong' + ((i % 9) + 1)));
    const hands: [Tile[], Tile[], Tile[], Tile[]] = [otherHand(), otherHand(), seat2Hand, otherHand()];
    const replacement = tile('wan9');
    const wall = wallOf(replacement);
    const dealResult: DealResult = { hands, wall };
    const rules: RulesConfig = { ...DEFAULT_RULES, deadWallReserve: 0 };

    const result = resolveInitialDeal(dealResult, 0, rules);

    expect(result.exhausted).toBe(false);
    expect(result.hands[2]).toHaveLength(16);
    expect(result.hands[2].some(isFlowerTile)).toBe(false);
    expect(ids(result.hands[2])).toEqual([...ids(nonFlowers), replacement.id]);
    expect(ids(result.flowers[2])).toEqual([flowerTile.id]);
    expect(result.flowers[0]).toEqual([]);
    expect(result.flowers[1]).toEqual([]);
    expect(result.flowers[3]).toEqual([]);
  });

  it('multiple flowers in one dealt hand are each replaced', () => {
    const nonFlowers = Array.from({ length: 14 }, (_, i) => tile('wan' + ((i % 9) + 1)));
    const flowerA = tile('flower1');
    const flowerB = tile('flower2');
    const seatHand = [...nonFlowers.slice(0, 7), flowerA, ...nonFlowers.slice(7, 14), flowerB];
    const otherHand = () => Array.from({ length: 16 }, (_, i) => tile('tong' + ((i % 9) + 1)));
    const hands: [Tile[], Tile[], Tile[], Tile[]] = [seatHand, otherHand(), otherHand(), otherHand()];
    const replacement1 = tile('wan9'); // consumed first (tail), for flowerA
    const replacement2 = tile('wan8'); // consumed second, for flowerB
    const wall = wallOf(replacement2, replacement1); // tail = last = replacement1
    const dealResult: DealResult = { hands, wall };
    const rules: RulesConfig = { ...DEFAULT_RULES, deadWallReserve: 0 };

    const result = resolveInitialDeal(dealResult, 0, rules);

    expect(result.exhausted).toBe(false);
    expect(result.hands[0]).toHaveLength(16);
    expect(ids(result.hands[0])).toEqual([...ids(nonFlowers), replacement1.id, replacement2.id]);
    expect(ids(result.flowers[0])).toEqual([flowerA.id, flowerB.id]);
  });

  it('a replacement that is itself a flower chains during initial resolution and both flowers attribute to the same seat', () => {
    const nonFlowers = Array.from({ length: 15 }, (_, i) => tile('wan' + ((i % 9) + 1)));
    const flowerA = tile('flower1');
    const seatHand = [...nonFlowers, flowerA];
    const otherHand = () => Array.from({ length: 16 }, (_, i) => tile('tong' + ((i % 9) + 1)));
    const hands: [Tile[], Tile[], Tile[], Tile[]] = [seatHand, otherHand(), otherHand(), otherHand()];
    const finalReplacement = tile('wan9');
    const flowerB = tile('flower2'); // drawn as a replacement, itself a flower -> chains
    const wall = wallOf(finalReplacement, flowerB); // tail draw order: flowerB, then finalReplacement
    const dealResult: DealResult = { hands, wall };
    const rules: RulesConfig = { ...DEFAULT_RULES, deadWallReserve: 0 };

    const result = resolveInitialDeal(dealResult, 0, rules);

    expect(result.exhausted).toBe(false);
    expect(ids(result.hands[0])).toEqual([...ids(nonFlowers), finalReplacement.id]);
    expect(ids(result.flowers[0])).toEqual([flowerA.id, flowerB.id]);
  });

  it('resolves seats in turn order starting from a non-East dealer (dealer = 2: order 2,3,0,1), verified by which seat receives which known tail tile', () => {
    const makeHandWithFlower = (flowerTile: Tile) => {
      const nonFlowers = Array.from({ length: 15 }, (_, i) => tile('wan' + ((i % 9) + 1)));
      return [...nonFlowers, flowerTile];
    };
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

    const r1 = tile('tong1');
    const r0 = tile('tong2');
    const r3 = tile('tong3');
    const r2 = tile('tong4');
    // Tail draw order: r2 (1st, seat 2), r3 (2nd, seat 3), r0 (3rd, seat 0), r1 (4th, seat 1).
    const wall = wallOf(r1, r0, r3, r2);
    const dealResult: DealResult = { hands, wall };
    const rules: RulesConfig = { ...DEFAULT_RULES, deadWallReserve: 0 };

    const result = resolveInitialDeal(dealResult, 2, rules);

    expect(result.exhausted).toBe(false);
    expect(result.hands[2][result.hands[2].length - 1].id).toBe(r2.id);
    expect(result.hands[3][result.hands[3].length - 1].id).toBe(r3.id);
    expect(result.hands[0][result.hands[0].length - 1].id).toBe(r0.id);
    expect(result.hands[1][result.hands[1].length - 1].id).toBe(r1.id);
  });

  it('conservation: hands + flowers + final wall exactly partition the input DealResult tiles with no duplication or loss (seeded full deal)', () => {
    const wall: Wall = shuffle(createTileSet(), 7);
    const dealResult = deal(wall, 0);
    const result = resolveInitialDeal(dealResult, 0, DEFAULT_RULES);

    expect(result.exhausted).toBe(false);

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

  it('all four hands contain exactly 16 non-flower tiles after resolution across multiple seeds', () => {
    for (let seed = 1; seed <= 5; seed++) {
      const dealer = (seed % 4) as Seat;
      const wall: Wall = shuffle(createTileSet(), seed);
      const dealResult = deal(wall, dealer);
      const result = resolveInitialDeal(dealResult, dealer, DEFAULT_RULES);

      expect(result.exhausted).toBe(false);
      for (const hand of result.hands) {
        expect(hand).toHaveLength(16);
        expect(hand.some(isFlowerTile)).toBe(false);
      }
    }
  });

  it('degenerate high deadWallReserve: returns exhausted true, stops processing immediately, blocked seat hand left short, no throw', () => {
    const nonFlowers = Array.from({ length: 15 }, (_, i) => tile('wan' + ((i % 9) + 1)));
    const flowerTile = tile('flower1');
    const dealerHand = [...nonFlowers, flowerTile];
    const otherHand = () => Array.from({ length: 16 }, (_, i) => tile('tong' + ((i % 9) + 1)));
    const hands: [Tile[], Tile[], Tile[], Tile[]] = [dealerHand, otherHand(), otherHand(), otherHand()];
    const wall = wallOf(tile('wan9'), tile('wan8'));
    const dealResult: DealResult = { hands, wall };
    const rules: RulesConfig = { ...DEFAULT_RULES, deadWallReserve: 100 };

    expect(() => resolveInitialDeal(dealResult, 0, rules)).not.toThrow();
    const result = resolveInitialDeal(dealResult, 0, rules);

    expect(result.exhausted).toBe(true);
    expect(result.hands[0]).toHaveLength(15);
    expect(ids(result.flowers[0])).toEqual([flowerTile.id]);
  });

  it('does not mutate the input DealResult (hands arrays and wall)', () => {
    const nonFlowers = Array.from({ length: 15 }, (_, i) => tile('wan' + ((i % 9) + 1)));
    const flowerTile = tile('flower1');
    const dealerHand = [...nonFlowers, flowerTile];
    const otherHand = () => Array.from({ length: 16 }, (_, i) => tile('tong' + ((i % 9) + 1)));
    const hands: [Tile[], Tile[], Tile[], Tile[]] = [dealerHand, otherHand(), otherHand(), otherHand()];
    const wall = wallOf(tile('wan9'));
    const dealResult: DealResult = { hands, wall };
    const rules: RulesConfig = { ...DEFAULT_RULES, deadWallReserve: 0 };

    const originalHandIds = hands.map((h) => ids(h));
    const originalWallIds = ids(wall);

    resolveInitialDeal(dealResult, 0, rules);

    expect(hands.map((h) => ids(h))).toEqual(originalHandIds);
    expect(ids(wall)).toEqual(originalWallIds);
  });

  it('is deterministic for identical inputs', () => {
    const wall: Wall = shuffle(createTileSet(), 11);
    const dealResult = deal(wall, 1);

    const first = resolveInitialDeal(dealResult, 1, DEFAULT_RULES);
    const second = resolveInitialDeal(dealResult, 1, DEFAULT_RULES);

    expect(first.hands.map((h) => ids(h))).toEqual(second.hands.map((h) => ids(h)));
    expect(first.flowers.map((f) => ids(f))).toEqual(second.flowers.map((f) => ids(f)));
    expect(ids(first.wall)).toEqual(ids(second.wall));
    expect(first.exhausted).toBe(second.exhausted);
  });
});
