/**
 * Targeted adversarial tests for src/engine/hand.ts, beyond the builder's
 * hand.test.ts, per the mandatory win-detection risk areas (docs/RULES.md
 * §6.4, §6.2). Every expected value below was cross-checked against the
 * actual implementation output before being locked in (see PR discussion) —
 * none are guessed. See also hand.fuzz.test.ts for randomized/reference-
 * oracle cross-validation covering the same risk areas at scale.
 */
import { describe, expect, it } from 'vitest';
import { canWin, waitingTiles } from './hand';
import {
  kindKey,
  type DragonName,
  type Rank,
  type SuitName,
  type Tile,
  type TileKind,
  type WindName,
} from './tiles';

const WINDS: readonly WindName[] = ['east', 'south', 'west', 'north'];
const DRAGONS: readonly DragonName[] = ['red', 'green', 'white'];

function kindFromSpec(spec: string): TileKind {
  const suitMatch = /^(wan|tong|tiao)([1-9])$/.exec(spec);
  if (suitMatch) {
    return { category: 'suit', suit: suitMatch[1] as SuitName, rank: Number(suitMatch[2]) as Rank };
  }
  if ((WINDS as readonly string[]).includes(spec)) return { category: 'wind', wind: spec as WindName };
  if ((DRAGONS as readonly string[]).includes(spec)) return { category: 'dragon', dragon: spec as DragonName };
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
function kindOf(spec: string): TileKind {
  return kindFromSpec(spec);
}

describe('5 sets + 1 pair exactly — ambiguous double-pair (shanpon) structure', () => {
  // 4 complete sets (12 tiles) + a 4-tile remnant containing TWO different
  // pairs (tiao7,tiao7,tiao8,tiao8) — a "5 sets + 2 candidate pairs" shape.
  // Only the tile that completes one pair into a pung (leaving the other as
  // the eyes) may win; nothing else may.
  const concealed = hand(
    'wan1', 'wan2', 'wan3',
    'wan4', 'wan4', 'wan4',
    'tong1', 'tong2', 'tong3',
    'tong4', 'tong5', 'tong6',
    'tiao7', 'tiao7', 'tiao8', 'tiao8',
  );

  it('both shanpon completions win (tiao7 -> pung7+pair8; tiao8 -> pair7+pung8)', () => {
    expect(canWin(concealed, 0, tile('tiao7'))).toBe(true);
    expect(canWin(concealed, 0, tile('tiao8'))).toBe(true);
  });

  it('adjacent-but-wrong candidates do not win (tiao6, tiao9, and an unrelated tile)', () => {
    expect(canWin(concealed, 0, tile('tiao6'))).toBe(false);
    expect(canWin(concealed, 0, tile('tiao9'))).toBe(false);
    expect(canWin(concealed, 0, tile('wan5'))).toBe(false);
  });

  it('waitingTiles returns exactly the two shanpon kinds, in canonical order', () => {
    expect(waitingTiles(concealed, 0)).toEqual([kindOf('tiao7'), kindOf('tiao8')]);
  });
});

describe('16-tile "almost" shape that is one tile short in two structurally different ways', () => {
  // 4 complete sets (12 tiles) + remnant tong7,tong8,tong9,tong9.
  // - candidate tong6 completes via chow(6,7,8) + pair(9,9): an edge-extension read.
  // - candidate tong9 completes via chow(7,8,9) + pair(9,9) [reusing the
  //   pre-existing pair] i.e. pung(9,9,9) is NOT how it resolves; the
  //   decomposition search must actually find the chow-plus-leftover-pair
  //   reading, not merely assume a triplet.
  // These are two genuinely different completions of the same remnant, and
  // every other plausible-looking neighbor must fail.
  const concealed = hand(
    'wan1', 'wan2', 'wan3',
    'wan4', 'wan4', 'wan4',
    'tiao1', 'tiao1', 'tiao1',
    'tiao2', 'tiao3', 'tiao4',
    'tong7', 'tong8', 'tong9', 'tong9',
  );

  it('completes on tong6 (edge chow 6-7-8 + pair 9-9)', () => {
    expect(canWin(concealed, 0, tile('tong6'))).toBe(true);
  });

  it('completes on tong9 (chow 7-8-9 + pair 9-9 from the remaining two 9s)', () => {
    expect(canWin(concealed, 0, tile('tong9'))).toBe(true);
  });

  it('does not complete on plausible-looking neighbors (tong5, tong7, tong8) or an unrelated tile', () => {
    expect(canWin(concealed, 0, tile('tong5'))).toBe(false);
    expect(canWin(concealed, 0, tile('tong7'))).toBe(false);
    expect(canWin(concealed, 0, tile('tong8'))).toBe(false);
    expect(canWin(concealed, 0, tile('wan5'))).toBe(false);
    expect(canWin(concealed, 0, tile('east'))).toBe(false);
  });

  it('waitingTiles returns exactly [tong6, tong9]', () => {
    expect(waitingTiles(concealed, 0)).toEqual([kindOf('tong6'), kindOf('tong9')]);
  });
});

describe('multi-interpretation: canWin must not get stuck exploring only the first-tried pair candidate', () => {
  // Same fixture as above. Internally, findDecomposition's outer pair-search
  // loop (canonical HAND_TILE_KINDS order: wan before tong) will first try
  // wan4 (count 3, a viable pair candidate on the combined 17 tiles) and
  // tiao1 (count 3) as the pair BEFORE ever reaching tong9 — both of those
  // attempts must fail and be fully backtracked out of (counts restored)
  // before the correct tong9-pair decomposition is found. If the search
  // returned early/incorrectly on the first failed pair attempt, or leaked
  // mutated counts across attempts, canWin would wrongly return false here.
  const concealed = hand(
    'wan1', 'wan2', 'wan3',
    'wan4', 'wan4', 'wan4',
    'tiao1', 'tiao1', 'tiao1',
    'tiao2', 'tiao3', 'tiao4',
    'tong7', 'tong8', 'tong9', 'tong9',
  );

  it('finds the tong9-pair decomposition after backtracking past the wan4 and tiao1 pair attempts', () => {
    expect(canWin(concealed, 0, tile('tong9'))).toBe(true);
  });

  it('is order-insensitive under this backtracking-heavy shape (shuffled concealed hand gives the same result)', () => {
    const shuffled = [...concealed].reverse();
    expect(canWin(shuffled, 0, tile('tong9'))).toBe(true);
  });
});

describe('waitingTiles: 3-of-4 copies already held is still a live wait (only 4-of-4 is a dead wait)', () => {
  // fixedMeldCount 3: concealed 7 tiles = wan5,wan5,wan5 (3 copies already
  // held) + wan4 + wan6 + red,red. The 4th wan5 completes via
  // pung(5,5,5) + chow(4,5,6) [using the 4th copy] + pair(red,red) — a
  // genuine structural completion, not an off-by-one artifact.
  const concealed = hand('wan5', 'wan5', 'wan5', 'wan4', 'wan6', 'red', 'red');

  it('canWin is true for the 4th copy of a kind already held 3x', () => {
    expect(canWin(concealed, 3, tile('wan5'))).toBe(true);
  });

  it('waitingTiles includes wan5 (not excluded as a dead wait at 3 copies held)', () => {
    const result = waitingTiles(concealed, 3);
    expect(result.some((k) => kindKey(k) === kindKey(kindOf('wan5')))).toBe(true);
  });

  it('exact wait set is [wan5, red] (red also completes via pung(red,red,red)+chow(4,5,6)+pair(wan5,wan5))', () => {
    expect(waitingTiles(concealed, 3)).toEqual([kindOf('wan5'), kindOf('red')]);
  });
});

describe('waitingTiles: a hand with a genuinely dead wait (4 copies already held) is excluded', () => {
  it('excludes the kind whose 4 copies are already in the concealed hand even though the counts-math would admit a 5th', () => {
    // fixedMeldCount 0, concealed 16: wan1x4 (all 4 copies) + wan2,wan3 +
    // three complete tong/tiao runs. wan1 "looks" like it could pung+chow
    // for a 5th copy, but only 4 copies of any kind physically exist.
    const concealed = hand(
      'wan1', 'wan1', 'wan1', 'wan1', 'wan2', 'wan3',
      'tong1', 'tong2', 'tong3',
      'tong4', 'tong5', 'tong6',
      'tiao1', 'tiao1', 'tiao1',
      'red',
    );
    const result = waitingTiles(concealed, 0);
    expect(result.some((k) => kindKey(k) === kindKey(kindOf('wan1')))).toBe(false);
  });
});

describe('waitingTiles: a hand that superficially resembles tenpai but has no legal completion', () => {
  // fixedMeldCount 4 (concealed 4 tiles): wan1, wan2, wan4, wan5 — spans a
  // narrow 5-rank window (looks like it could be "one tile from a run plus
  // pair" at a glance) but the double gap means no single candidate tile
  // can ever complete it into 1 set + 1 pair.
  const concealed = hand('wan1', 'wan2', 'wan4', 'wan5');

  it('no candidate in the plausible neighborhood completes the hand', () => {
    for (const spec of ['wan1', 'wan2', 'wan3', 'wan4', 'wan5', 'wan6', 'wan7']) {
      expect(canWin(concealed, 4, tile(spec)), `candidate ${spec} should not win`).toBe(false);
    }
  });

  it('waitingTiles returns an empty array', () => {
    expect(waitingTiles(concealed, 4)).toEqual([]);
  });
});

describe('boundary/rank math: bottom edge chow and cross-suit-block index adjacency', () => {
  it('accepts the bottom edge chow 1-2-3', () => {
    const concealed = hand(
      'tong1', 'tong2', 'tong3', 'tong4', 'tong5', 'tong6', 'tong7', 'tong8', 'tong9',
      'tiao1', 'tiao1', 'tiao1',
      'red', 'red',
      'wan2', 'wan3',
    );
    expect(canWin(concealed, 0, tile('wan1'))).toBe(true);
  });

  it('never treats tong9 + tiao1 + tiao2 as a chow (contiguous count-array indices 17,18,19 across a suit-block boundary)', () => {
    // fixedMeldCount 4: concealed 4 tiles = tong9, tiao1, tiao2, tiao2.
    // If canStartChow incorrectly used raw index adjacency (i, i+1, i+2)
    // instead of the suit-aware "i % 9 <= 6" rule, tong9-tiao1-tiao2 would
    // be wrongly accepted as a chow here, leaving the other two tiao2s as a
    // valid pair and producing a false positive on candidate tiao2.
    const concealed = hand('tong9', 'tiao1', 'tiao2', 'tiao2');
    expect(canWin(concealed, 4, tile('tiao2'))).toBe(false);
    expect(waitingTiles(concealed, 4)).toEqual([]);
  });

  it('rejects tong8 + tong9 + tiao1 as a chow too (index 16,17,18 — one step earlier than the previous boundary case)', () => {
    // tiao1 as a 3rd copy (pung attempt) must fail: it would leave tong8,
    // tong9 unmatched, which is not a valid pair. The only real completion
    // of this remnant is the legitimate same-suit chow tong7-8-9 (leaving
    // tiao1,tiao1 as the pair) — unrelated to the cross-suit boundary this
    // test targets, but confirms waitingTiles is exactly that and nothing
    // spuriously produced by treating tong9+tiao1 as adjacent.
    const concealed = hand('tong8', 'tong9', 'tiao1', 'tiao1');
    expect(canWin(concealed, 4, tile('tiao1'))).toBe(false);
    expect(waitingTiles(concealed, 4)).toEqual([kindOf('tong7')]);
  });

  it('rejects wan9 + tong1 + tong2 as a chow (index 8,9,10 — wan/tong boundary)', () => {
    const concealed = hand('wan9', 'tong1', 'tong2', 'tong2');
    expect(canWin(concealed, 4, tile('tong2'))).toBe(false);
    expect(waitingTiles(concealed, 4)).toEqual([]);
  });
});

describe('fixedMeldCount interaction: correct (not just true/false) waits at fixedMeldCount 3', () => {
  it('two-sided (ryanmen) wait on a 7-concealed-tile hand resolves to exactly [wan3, wan6]', () => {
    // fixedMeldCount 3: concealed 7 tiles = tong1x3 (pung) + wan4,wan5
    // (ryanmen) + red,red (pair). setsNeeded = 2.
    const concealed = hand('tong1', 'tong1', 'tong1', 'wan4', 'wan5', 'red', 'red');
    expect(canWin(concealed, 3, tile('wan3'))).toBe(true);
    expect(canWin(concealed, 3, tile('wan6'))).toBe(true);
    expect(canWin(concealed, 3, tile('wan4'))).toBe(false);
    expect(canWin(concealed, 3, tile('wan5'))).toBe(false);
    expect(canWin(concealed, 3, tile('red'))).toBe(false);
    expect(waitingTiles(concealed, 3)).toEqual([kindOf('wan3'), kindOf('wan6')]);
  });
});

describe('16-tile hand + winning 17th tile: near-miss shapes that must not falsely win', () => {
  it('a hand one tile off in two different plausible directions both fail (neither the "too low" nor "too high" neighbor completes)', () => {
    // 4 complete sets + a lone wan5: only wan5 itself (pair) can complete
    // this; wan4 and wan6 (which "look" like they could extend a run) must
    // not, since there is no partial run here at all, only a lone tile.
    const concealed = hand(
      'wan1', 'wan2', 'wan3',
      'tong1', 'tong1', 'tong1',
      'tiao1', 'tiao2', 'tiao3',
      'tiao4', 'tiao5', 'tiao6',
      'east', 'east', 'east',
      'wan5',
    );
    expect(canWin(concealed, 0, tile('wan5'))).toBe(true);
    expect(canWin(concealed, 0, tile('wan4'))).toBe(false);
    expect(canWin(concealed, 0, tile('wan6'))).toBe(false);
    expect(waitingTiles(concealed, 0)).toEqual([kindOf('wan5')]);
  });
});
