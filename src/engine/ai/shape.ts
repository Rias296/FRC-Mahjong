/**
 * Pure shape heuristics for the v1 heuristic AI bot (see ./choose-action.ts).
 *
 * Imports only from ../tiles and ../hand — deliberately NOT from
 * src/lib/table/tile-display (a UI-layer concern; the engine, including this
 * AI module, must stay presentation-independent).
 *
 * Everything here is a FAST HEURISTIC, not a true shanten calculator. Legal
 * win/tenpai determinations must always go through ../hand's `canWin` /
 * `waitingTiles` — the functions in this file only ever rank/score
 * already-legal hand states for decision-making, never gate legality.
 */

import { HAND_TILE_KINDS, kindKey, type Tile } from '../tiles';
import { waitingTiles } from '../hand';

// Index into a 34-length count vector matching HAND_TILE_KINDS order (see
// ../hand.ts's identical convention): wan 0-8, tong 9-17, tiao 18-26,
// winds 27-30 (E/S/W/N), dragons 31-33 (red/green/white). Duplicated here
// rather than imported because ../hand.ts does not export its version
// (matches this codebase's existing per-file test-helper duplication
// convention; this is production code doing the analogous thing for a
// small, self-contained lookup).
const KIND_INDEX: ReadonlyMap<string, number> = new Map(
  HAND_TILE_KINDS.map((kind, index) => [kindKey(kind), index]),
);

function kindIndex(tile: Tile): number {
  const index = KIND_INDEX.get(kindKey(tile.kind));
  if (index === undefined) {
    throw new Error(`shape.ts: tile kind "${kindKey(tile.kind)}" is not a valid hand tile (flowers excluded)`);
  }
  return index;
}

/** True iff index i can start a chow: same 9-wide suit block, no wraparound. Mirrors ../hand.ts. */
function canStartRun(i: number): boolean {
  return i <= 26 && i % 9 <= 6;
}

/** True iff index i has a same-suit neighbor at i+1 (no wraparound past the suit's rank-9 boundary). */
function hasSuitNeighbor(i: number): boolean {
  return i <= 26 && i % 9 <= 7;
}

function countsFromTiles(tiles: readonly Tile[]): number[] {
  const counts = new Array<number>(HAND_TILE_KINDS.length).fill(0);
  for (const t of tiles) {
    counts[kindIndex(t)]++;
  }
  return counts;
}

/**
 * Connectivity score for `tile` against `otherTiles` (the rest of the hand —
 * callers must exclude `tile` itself from `otherTiles`):
 *   3 x (same-kind copies among otherTiles)
 * + 2 x (suit neighbors at rank +/-1)
 * + 1 x (suit neighbors at rank +/-2)
 * Honor tiles (winds/dragons) only ever score on exact-copy duplicates —
 * there is no rank-neighbor concept for them.
 */
export function tileConnectivity(tile: Tile, otherTiles: readonly Tile[]): number {
  const key = kindKey(tile.kind);
  const isSuit = tile.kind.category === 'suit';

  let sameKindCopies = 0;
  let neighbor1 = 0;
  let neighbor2 = 0;

  for (const other of otherTiles) {
    if (kindKey(other.kind) === key) {
      sameKindCopies++;
      continue;
    }
    if (isSuit && tile.kind.category === 'suit' && other.kind.category === 'suit' && other.kind.suit === tile.kind.suit) {
      const diff = Math.abs(other.kind.rank - tile.kind.rank);
      if (diff === 1) neighbor1++;
      else if (diff === 2) neighbor2++;
    }
  }

  return 3 * sameKindCopies + 2 * neighbor1 + 1 * neighbor2;
}

/**
 * True iff at least one discard from `concealedTiles` (a MUST-ACT hand —
 * `concealedTiles.length === 17 - 3 * meldCount`, i.e. one extra tile beyond
 * the at-rest count, per ../actions.ts's HandShape convention) leaves the
 * resulting 16-3*meldCount at-rest hand waiting on something (non-empty
 * `waitingTiles`).
 */
export function hasTenpaiDiscard(concealedTiles: readonly Tile[], meldCount: number): boolean {
  for (let i = 0; i < concealedTiles.length; i++) {
    const afterDiscard = [...concealedTiles.slice(0, i), ...concealedTiles.slice(i + 1)];
    if (waitingTiles(afterDiscard, meldCount).length > 0) {
      return true;
    }
  }
  return false;
}

/**
 * A fast, deterministic GREEDY shape heuristic — NOT a true shanten
 * calculator (it does not backtrack, so a hand with multiple overlapping
 * decompositions may be scored sub-optimally; it exists purely as a cheap
 * discard-priority / claim-value signal for the v1 AI, never for legality —
 * legality always goes through ../hand's `canWin`/`waitingTiles`).
 *
 * Greedy scan, in this fixed priority order, over the canonical
 * HAND_TILE_KINDS count grouping:
 *   100 per complete set (triplet, scanned first; then run)
 *    20 per pair
 *    10 per adjacent proto-run (two tiles one rank apart, same suit)
 *     5 per two-gap proto-run (two tiles two ranks apart, same suit)
 *     0 for isolated tiles (no bonus)
 * Operates on any tile array (not required to be a full/valid hand length —
 * callers use this on partial post-claim/post-discard slices too).
 */
export function shapeScore(concealedTiles: readonly Tile[]): number {
  const counts = countsFromTiles(concealedTiles);
  let score = 0;

  // Complete sets: triplets (any kind), then runs (suits only).
  for (let i = 0; i < HAND_TILE_KINDS.length; i++) {
    while (counts[i] >= 3) {
      counts[i] -= 3;
      score += 100;
    }
  }
  for (let i = 0; i < HAND_TILE_KINDS.length; i++) {
    if (!canStartRun(i)) continue;
    while (counts[i] > 0 && counts[i + 1] > 0 && counts[i + 2] > 0) {
      counts[i]--;
      counts[i + 1]--;
      counts[i + 2]--;
      score += 100;
    }
  }

  // Pairs.
  for (let i = 0; i < HAND_TILE_KINDS.length; i++) {
    while (counts[i] >= 2) {
      counts[i] -= 2;
      score += 20;
    }
  }

  // Adjacent proto-runs (rank +/-1, same suit).
  for (let i = 0; i < HAND_TILE_KINDS.length; i++) {
    if (!hasSuitNeighbor(i)) continue;
    while (counts[i] > 0 && counts[i + 1] > 0) {
      counts[i]--;
      counts[i + 1]--;
      score += 10;
    }
  }

  // Two-gap proto-runs (rank +/-2, same suit).
  for (let i = 0; i < HAND_TILE_KINDS.length; i++) {
    if (!canStartRun(i)) continue;
    while (counts[i] > 0 && counts[i + 2] > 0) {
      counts[i]--;
      counts[i + 2]--;
      score += 5;
    }
  }

  // Remaining counts are isolated tiles: 0 contribution, no-op.
  return score;
}

/**
 * The tile in `concealedTiles` with the lowest connectivity score
 * (`tileConnectivity` against the rest of the hand). Deterministic tie-break:
 * among tied-lowest-score tiles, prefer the HIGHER HAND_TILE_KINDS index
 * (i.e. the kind sorted later in canonical wan/tong/tiao/wind/dragon order);
 * if still tied (multiple copies of the same kind), prefer the
 * lexicographically SMALLEST tile id.
 */
export function leastConnectedDiscard(concealedTiles: readonly Tile[]): Tile {
  if (concealedTiles.length === 0) {
    throw new Error('leastConnectedDiscard: concealedTiles must be non-empty');
  }

  let best: Tile = concealedTiles[0];
  let bestScore = Infinity;
  let bestKindIndex = -1;

  for (let i = 0; i < concealedTiles.length; i++) {
    const candidate = concealedTiles[i];
    const others = [...concealedTiles.slice(0, i), ...concealedTiles.slice(i + 1)];
    const score = tileConnectivity(candidate, others);
    const idx = kindIndex(candidate);

    const better =
      score < bestScore ||
      (score === bestScore && idx > bestKindIndex) ||
      (score === bestScore && idx === bestKindIndex && candidate.id < best.id);

    if (better) {
      best = candidate;
      bestScore = score;
      bestKindIndex = idx;
    }
  }

  return best;
}
