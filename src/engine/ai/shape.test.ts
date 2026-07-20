import { describe, expect, it } from 'vitest';
import { hasTenpaiDiscard, leastConnectedDiscard, shapeScore, tileConnectivity } from './shape';
import {
  kindKey,
  type DragonName,
  type FlowerNumber,
  type Rank,
  type SuitName,
  type Tile,
  type TileKind,
  type WindName,
} from '../tiles';

// --- Test-local shorthand tile builder (duplicated per-file convention, see hand.test.ts / game-state.test.ts) ---
// Suit tiles: 'wan1'..'wan9', 'tong1'..'tong9', 'tiao1'..'tiao9'.
// Honors: 'east' | 'south' | 'west' | 'north' | 'red' | 'green' | 'white'.
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
  return { id: `${kindKey(kind)}-test${idCounter}`, kind };
}

function hand(...specs: string[]): Tile[] {
  return specs.map(tile);
}

// ================================================================================
// tileConnectivity
// ================================================================================

describe('tileConnectivity', () => {
  it('an isolated honor tile scores lower than a tile with a same-kind duplicate', () => {
    const isolatedHonor = tile('north');
    const isolatedScore = tileConnectivity(isolatedHonor, hand('wan1', 'tong5', 'south'));

    const dupA = tile('east');
    const dupB = tile('east');
    const dupScore = tileConnectivity(dupA, [dupB, ...hand('wan1', 'tong5')]);

    expect(isolatedScore).toBe(0);
    expect(dupScore).toBe(3);
    expect(dupScore).toBeGreaterThan(isolatedScore);
  });

  it('a tile with a rank+/-1 neighbor scores higher than one with only a rank+/-2 neighbor', () => {
    const wan5 = tile('wan5');
    const withRank1Neighbor = tileConnectivity(wan5, hand('wan6'));
    const withRank2Neighbor = tileConnectivity(wan5, hand('wan7'));

    expect(withRank1Neighbor).toBe(2);
    expect(withRank2Neighbor).toBe(1);
    expect(withRank1Neighbor).toBeGreaterThan(withRank2Neighbor);
  });

  it('honor tiles never score a neighbor bonus, only exact-copy duplicates', () => {
    const east = tile('east');
    // No suit "neighbor" concept applies to honors; only same-kind copies count.
    const score = tileConnectivity(east, hand('south', 'west', 'north', 'red', 'green', 'white'));
    expect(score).toBe(0);
  });

  it('sums all three components together for a well-connected suit tile', () => {
    const wan5 = tile('wan5');
    // 1 same-kind dup (+3), 1 rank+/-1 neighbor (+2), 1 rank+/-2 neighbor (+1) = 6.
    const score = tileConnectivity(wan5, hand('wan5', 'wan6', 'wan7'));
    expect(score).toBe(6);
  });
});

// ================================================================================
// leastConnectedDiscard
// ================================================================================

describe('leastConnectedDiscard', () => {
  it('picks the tile with the lowest connectivity score', () => {
    // 'north' is fully isolated (score 0); everything else is at least a pair (score 3).
    const north = tile('north');
    const concealed = [north, ...hand('east', 'east', 'south', 'south', 'west', 'west')];
    expect(leastConnectedDiscard(concealed).id).toBe(north.id);
  });

  it('deterministic tie-break: among tied-lowest scores, prefers the HIGHER HAND_TILE_KINDS index', () => {
    // Two isolated honors tie at score 0: 'north' (wind, lower canonical index)
    // and 'white' (dragon, higher canonical index). The higher-index kind
    // ('white') must be the one selected as the discard.
    const north = tile('north');
    const white = tile('white');
    const filler = hand('east', 'east', 'south', 'south'); // pairs, score 3 each — not tied for lowest
    const concealed = [north, white, ...filler];

    const result = leastConnectedDiscard(concealed);
    expect(result.id).toBe(white.id);
  });

  it('deterministic tie-break: same kind (same score, same kind index) resolves by lexicographically smallest id', () => {
    // Two copies of 'wan5', isolated from everything else (no neighbors),
    // tie at score 3 each (they see each other as a same-kind duplicate).
    // Every other tile in the hand is a complete triplet (score 6 each), so
    // the wan5 pair is unambiguously the tied-lowest pair. We construct
    // explicit ids so the "lexicographically smallest wins" rule is
    // unambiguous regardless of idCounter ordering.
    const wan5Kind = kindFromSpec('wan5');
    const dupHigh: Tile = { id: 'zzz-high', kind: wan5Kind };
    const dupLow: Tile = { id: 'aaa-low', kind: wan5Kind };
    const triplets = hand('tong2', 'tong2', 'tong2', 'tiao7', 'tiao7', 'tiao7');
    const concealed = [dupHigh, dupLow, ...triplets];

    const first = leastConnectedDiscard(concealed);
    const second = leastConnectedDiscard(concealed);
    expect(first.id).toBe('aaa-low');
    expect(second.id).toBe('aaa-low'); // deterministic across repeated calls
  });

  it('a fully-connected 17-tile hand (no truly "bad" discard) still yields ONE deterministic answer', () => {
    const concealed = hand(
      'wan1', 'wan1', 'wan1',
      'tong2', 'tong2', 'tong2',
      'tiao3', 'tiao3', 'tiao3',
      'wan4', 'wan4', 'wan4',
      'tong5', 'tong5',
      'tiao6', 'tiao7',
      'wan8',
    );
    expect(concealed).toHaveLength(17);

    const first = leastConnectedDiscard(concealed);
    const second = leastConnectedDiscard(concealed);
    expect(concealed.some((t) => t.id === first.id)).toBe(true);
    expect(first.id).toBe(second.id);
  });
});

// ================================================================================
// hasTenpaiDiscard
// ================================================================================

describe('hasTenpaiDiscard', () => {
  it('true fixture: a must-act 17-tile hand where discarding the extra tile leaves it tenpai', () => {
    const tenpaiSixteen = hand(
      'wan1', 'wan2', 'wan3',
      'tong1', 'tong2', 'tong3',
      'tiao1', 'tiao2', 'tiao3',
      'red', 'red', 'red',
      'south', 'south', 'south',
      'north', // waiting on 'north' to complete 5 sets + 1 pair
    );
    const extra = tile('west');
    const mustAct = [...tenpaiSixteen, extra];
    expect(mustAct).toHaveLength(17);
    expect(hasTenpaiDiscard(mustAct, 0)).toBe(true);
  });

  it('false fixture: a maximally-sparse 17-tile hand has no discard that leaves it tenpai', () => {
    // Every kind distinct, suit ranks gapped by exactly 2 (no adjacency, no
    // duplicates anywhere) — structurally can never form a pair+run/pung
    // combination regardless of which tile is discarded or which candidate
    // is probed.
    const sparse = hand(
      'wan1', 'wan3', 'wan5', 'wan7', 'wan9',
      'tong1', 'tong3', 'tong5', 'tong7', 'tong9',
      'tiao1', 'tiao3', 'tiao5', 'tiao7', 'tiao9',
      'east', 'south',
    );
    expect(sparse).toHaveLength(17);
    expect(hasTenpaiDiscard(sparse, 0)).toBe(false);
  });
});

// ================================================================================
// shapeScore monotonicity
// ================================================================================

describe('shapeScore', () => {
  it('documents itself as a fast heuristic, not a shanten calculator (behavioral proxy: monotonic tiers)', () => {
    const completeSetHand = hand('wan1', 'wan1', 'wan1', 'tong2', 'tong6', 'east');
    const pairOnlyHand = hand('wan1', 'wan1', 'tong2', 'tong6', 'east', 'south');
    const adjacentProtoRunHand = hand('wan1', 'wan2', 'tong6', 'east', 'south', 'west');
    const isolatedHand = hand('wan1', 'tong6', 'tiao9', 'east', 'south', 'west');

    const completeSetScore = shapeScore(completeSetHand);
    const pairScore = shapeScore(pairOnlyHand);
    const protoRunScore = shapeScore(adjacentProtoRunHand);
    const isolatedScore = shapeScore(isolatedHand);

    expect(completeSetScore).toBe(100);
    expect(pairScore).toBe(20);
    expect(protoRunScore).toBe(10);
    expect(isolatedScore).toBe(0);

    expect(completeSetScore).toBeGreaterThan(pairScore);
    expect(pairScore).toBeGreaterThan(protoRunScore);
    expect(protoRunScore).toBeGreaterThan(isolatedScore);
  });

  it('scores a two-gap proto-run lower than an adjacent proto-run but higher than isolated', () => {
    const twoGapHand = hand('wan1', 'wan3', 'tong6', 'east');
    const adjacentHand = hand('wan1', 'wan2', 'tong6', 'east');
    const isolatedHand = hand('wan1', 'tong6', 'tiao9', 'east');

    expect(shapeScore(twoGapHand)).toBe(5);
    expect(shapeScore(adjacentHand)).toBe(10);
    expect(shapeScore(isolatedHand)).toBe(0);
  });

  it('scores a complete run (three consecutive ranks, same suit) as 100', () => {
    const runHand = hand('wan4', 'wan5', 'wan6', 'east');
    expect(shapeScore(runHand)).toBe(100);
  });
});
