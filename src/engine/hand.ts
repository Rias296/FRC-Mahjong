/**
 * Hand analysis: set decomposition, win detection, and waiting-tile (ting)
 * computation for the Taiwan Mahjong engine. See docs/RULES.md §6.4.
 *
 * Pure data types + pure functions only. Imports only from ./tiles.
 *
 * Hand-size math (RULES.md §3.3): "at rest" a player's logical hand is always
 * 16 tiles' worth of set material (a kong counts as one 3-tile-equivalent
 * set), so with `fixedMeldCount` exposed sets, `concealedTiles.length` must
 * equal `16 - 3 * fixedMeldCount`. A winning hand is 5 sets + 1 pair (17
 * logical tiles, RULES.md §6.4): the concealed tiles plus the winning
 * (candidate) tile must equal `3 * (5 - fixedMeldCount) + 2`, which — given
 * the at-rest invariant above — simplifies back to
 * `concealedTiles.length === 16 - 3 * fixedMeldCount`.
 */

import { HAND_TILE_KINDS, isFlowerTile, kindKey, type Tile, type TileKind } from './tiles';

export type SetKind = 'chow' | 'pung' | 'kong';

export interface Meld {
  readonly kind: SetKind;
  readonly tiles: readonly Tile[];
}

export interface HandDecomposition {
  readonly sets: readonly Meld[]; // length === setsNeeded; kind is only ever 'chow' | 'pung'
  readonly pair: readonly [Tile, Tile]; // two tiles of identical kindKey
}

// Index into a 34-length count vector matching HAND_TILE_KINDS order:
// wan 0-8, tong 9-17, tiao 18-26, winds 27-30 (E/S/W/N), dragons 31-33 (red/green/white).
const KIND_INDEX: ReadonlyMap<string, number> = new Map(
  HAND_TILE_KINDS.map((kind, index) => [kindKey(kind), index]),
);

function indexOfKind(kind: TileKind): number {
  const index = KIND_INDEX.get(kindKey(kind));
  if (index === undefined) {
    throw new Error(
      `hand.ts: tile kind "${kindKey(kind)}" is not a valid hand tile (flowers cannot form sets)`,
    );
  }
  return index;
}

function countsFromTiles(tiles: readonly Tile[]): number[] {
  const counts = new Array<number>(HAND_TILE_KINDS.length).fill(0);
  for (const tile of tiles) {
    counts[indexOfKind(tile.kind)]++;
  }
  return counts;
}

function groupByKindKey(tiles: readonly Tile[]): Map<string, Tile[]> {
  const groups = new Map<string, Tile[]>();
  for (const tile of tiles) {
    const key = kindKey(tile.kind);
    const group = groups.get(key);
    if (group) {
      group.push(tile);
    } else {
      groups.set(key, [tile]);
    }
  }
  return groups;
}

interface IndexSet {
  readonly kind: 'chow' | 'pung';
  readonly indices: readonly [number, number, number];
}

/** True iff index i can start a chow: same 9-wide suit block, no wraparound. */
function canStartChow(i: number): boolean {
  return i <= 26 && i % 9 <= 6;
}

/**
 * Backtracking existence search over a mutable count vector: repeatedly takes
 * the lowest-index kind with count > 0 and tries pung then chow. Complete
 * because any set containing the globally-lowest-index tile must have that
 * tile as its minimum-rank member (pung: only member; chow: first member).
 * Mutates `counts` during recursion but restores it before returning.
 */
function findSetsRec(counts: number[], setsNeeded: number, acc: readonly IndexSet[]): IndexSet[] | null {
  if (setsNeeded === 0) {
    return acc.slice();
  }

  const i = counts.findIndex((c) => c > 0);
  if (i === -1) {
    return null;
  }

  if (counts[i] >= 3) {
    counts[i] -= 3;
    const result = findSetsRec(counts, setsNeeded - 1, [...acc, { kind: 'pung', indices: [i, i, i] }]);
    counts[i] += 3;
    if (result) return result;
  }

  if (canStartChow(i) && counts[i + 1] > 0 && counts[i + 2] > 0) {
    counts[i]--;
    counts[i + 1]--;
    counts[i + 2]--;
    const result = findSetsRec(counts, setsNeeded - 1, [
      ...acc,
      { kind: 'chow', indices: [i, i + 1, i + 2] },
    ]);
    counts[i]++;
    counts[i + 1]++;
    counts[i + 2]++;
    if (result) return result;
  }

  return null;
}

function takeTiles(groups: Map<string, Tile[]>, index: number, count: number): Tile[] {
  const key = kindKey(HAND_TILE_KINDS[index]);
  const group = groups.get(key);
  if (!group || group.length < count) {
    throw new Error(`hand.ts: internal witness reconstruction error for kind "${key}"`);
  }
  const taken: Tile[] = [];
  for (let k = 0; k < count; k++) {
    taken.push(group.shift() as Tile);
  }
  return taken;
}

function reconstruct(
  groups: Map<string, Tile[]>,
  pairIndex: number,
  sets: readonly IndexSet[],
): HandDecomposition {
  const pairTiles = takeTiles(groups, pairIndex, 2);
  const pair: readonly [Tile, Tile] = [pairTiles[0], pairTiles[1]];

  const meldSets: Meld[] = sets.map((s) => {
    if (s.kind === 'pung') {
      return { kind: 'pung', tiles: takeTiles(groups, s.indices[0], 3) };
    }
    return {
      kind: 'chow',
      tiles: [
        ...takeTiles(groups, s.indices[0], 1),
        ...takeTiles(groups, s.indices[1], 1),
        ...takeTiles(groups, s.indices[2], 1),
      ],
    };
  });

  return { sets: meldSets, pair };
}

/**
 * Decomposes `tiles` into `setsNeeded` chow/pung sets plus one pair (existence
 * only, not full enumeration). Never emits a kong: a concealed 4-of-a-kind
 * that was never declared decomposes as a pung plus one spare copy, which
 * must fit elsewhere in the decomposition or the attempt fails.
 *
 * Throws if `tiles.length !== 3 * setsNeeded + 2`. Returns null when no valid
 * decomposition exists for a structurally-correct tile count. Does not
 * mutate `tiles`.
 */
export function findDecomposition(tiles: readonly Tile[], setsNeeded: number): HandDecomposition | null {
  const expectedLength = 3 * setsNeeded + 2;
  if (tiles.length !== expectedLength) {
    throw new Error(
      `findDecomposition: expected ${expectedLength} tiles for setsNeeded=${setsNeeded}, got ${tiles.length}`,
    );
  }

  const inputCopy = tiles.slice();
  const groups = groupByKindKey(inputCopy);
  const counts = countsFromTiles(inputCopy);

  for (let pairIndex = 0; pairIndex < HAND_TILE_KINDS.length; pairIndex++) {
    if (counts[pairIndex] < 2) continue;

    counts[pairIndex] -= 2;
    const sets = findSetsRec(counts, setsNeeded, []);
    counts[pairIndex] += 2;

    if (sets) {
      // Only mutated (via shift() in reconstruct) once a decomposition is
      // found, so reusing `groups` across failed pair attempts is safe.
      return reconstruct(groups, pairIndex, sets);
    }
  }

  return null;
}

function validateFixedMeldCount(fixedMeldCount: number): void {
  if (!Number.isInteger(fixedMeldCount) || fixedMeldCount < 0 || fixedMeldCount > 5) {
    throw new Error(`fixedMeldCount must be an integer in 0..5, got ${fixedMeldCount}`);
  }
}

function assertNoFlowers(tiles: readonly Tile[], context: string): void {
  if (tiles.some(isFlowerTile)) {
    throw new Error(`${context}: flower tiles cannot be part of a hand (upstream engine bug)`);
  }
}

function assertConcealedLength(concealedTiles: readonly Tile[], fixedMeldCount: number, context: string): void {
  const expectedLength = 16 - 3 * fixedMeldCount;
  if (concealedTiles.length !== expectedLength) {
    throw new Error(
      `${context}: expected ${expectedLength} concealed tiles for fixedMeldCount=${fixedMeldCount}, got ${concealedTiles.length}`,
    );
  }
}

/**
 * True iff `concealedTiles` plus `candidateTile`, together with
 * `fixedMeldCount` already-exposed sets, form a complete 5-sets-+-1-pair hand
 * (RULES.md §6.4). Trusts its inputs — the server is responsible for the
 * real-world legality of what `candidateTile` even could be.
 */
export function canWin(concealedTiles: readonly Tile[], fixedMeldCount: number, candidateTile: Tile): boolean {
  validateFixedMeldCount(fixedMeldCount);
  assertNoFlowers(concealedTiles, 'canWin');
  assertNoFlowers([candidateTile], 'canWin');
  assertConcealedLength(concealedTiles, fixedMeldCount, 'canWin');

  const setsNeeded = 5 - fixedMeldCount;
  const combined = [...concealedTiles, candidateTile];
  return findDecomposition(combined, setsNeeded) !== null;
}

/**
 * All hand-tile kinds that would complete `concealedTiles` (with
 * `fixedMeldCount` exposed sets) into a winning hand, in HAND_TILE_KINDS
 * canonical order. Excludes any kind whose 4 copies are already all present
 * in `concealedTiles` (a dead wait — no such tile remains to draw/claim),
 * even if the counts-math would otherwise admit a 5th copy.
 */
export function waitingTiles(concealedTiles: readonly Tile[], fixedMeldCount: number): TileKind[] {
  validateFixedMeldCount(fixedMeldCount);
  assertNoFlowers(concealedTiles, 'waitingTiles');
  assertConcealedLength(concealedTiles, fixedMeldCount, 'waitingTiles');

  const setsNeeded = 5 - fixedMeldCount;
  const concealedCopy = concealedTiles.slice();
  const concealedCounts = countsFromTiles(concealedCopy);

  const result: TileKind[] = [];
  for (let i = 0; i < HAND_TILE_KINDS.length; i++) {
    if (concealedCounts[i] >= 4) continue; // dead wait: all 4 copies already held

    const kind = HAND_TILE_KINDS[i];
    const candidate: Tile = { id: `probe-${kindKey(kind)}`, kind };
    const combined = [...concealedCopy, candidate];
    if (findDecomposition(combined, setsNeeded) !== null) {
      result.push(kind);
    }
  }

  return result;
}
