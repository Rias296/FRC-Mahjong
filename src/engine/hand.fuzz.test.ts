/**
 * Adversarial fuzz / cross-validation tests for src/engine/hand.ts.
 *
 * These tests do NOT trust hand.ts's own algorithm shape (lowest-index-first
 * backtracking). Instead they implement a *deliberately differently-shaped*
 * reference decomposition oracle (tries every candidate index at each step,
 * not just the lowest; resolves chow-adjacency via each tile's own `.suit`/
 * `.rank` fields rather than index arithmetic) and cross-check hand.ts's
 * `canWin` / `waitingTiles` against it over many random and constructed
 * hands. This is the strongest defense against "backtracking gets stuck in
 * one interpretation" bugs and against off-by-one errors in the index-based
 * chow-boundary math, without duplicating hand.ts's own bug (if any).
 *
 * Deterministic: uses a seeded PRNG, never Math.random().
 */
import { describe, expect, it } from 'vitest';
import { canWin, waitingTiles } from './hand';
import { HAND_TILE_KINDS, kindKey, type Tile, type TileKind } from './tiles';

// --- Seeded PRNG (mulberry32) — deterministic across runs/machines. ---
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randInt(rng: () => number, maxExclusive: number): number {
  return Math.floor(rng() * maxExclusive);
}

// --- Independent reference oracle ---
// Chow adjacency resolved via each kind's own suit+rank fields (a genuinely
// different code path from hand.ts's `i <= 26 && i % 9 <= 6` index check).
const N = HAND_TILE_KINDS.length;

function refChowPartners(index: number): [number, number] | null {
  const kind = HAND_TILE_KINDS[index];
  if (kind.category !== 'suit') return null;
  if (kind.rank > 7) return null;
  const nextIndex = HAND_TILE_KINDS.findIndex(
    (k) => k.category === 'suit' && k.suit === kind.suit && k.rank === kind.rank + 1,
  );
  const next2Index = HAND_TILE_KINDS.findIndex(
    (k) => k.category === 'suit' && k.suit === kind.suit && k.rank === kind.rank + 2,
  );
  if (nextIndex === -1 || next2Index === -1) return null;
  return [nextIndex, next2Index];
}

// Precompute once (pure function of HAND_TILE_KINDS, independent of hand.ts).
const CHOW_PARTNERS: ReadonlyArray<[number, number] | null> = HAND_TILE_KINDS.map((_, i) =>
  refChowPartners(i),
);

/**
 * Reference "can decompose into exactly setsNeeded chow/pung sets" check.
 * Deliberately tries EVERY nonzero index at each step (not just the lowest),
 * memoized on (counts, setsNeeded) to keep runtime bounded.
 */
function refCanDecompose(counts: number[], setsNeeded: number, memo: Map<string, boolean>): boolean {
  if (setsNeeded === 0) {
    return counts.every((c) => c === 0);
  }
  const key = `${counts.join(',')}#${setsNeeded}`;
  const cached = memo.get(key);
  if (cached !== undefined) return cached;

  let ok = false;
  for (let i = 0; i < N && !ok; i++) {
    if (counts[i] <= 0) continue;

    if (counts[i] >= 3) {
      counts[i] -= 3;
      if (refCanDecompose(counts, setsNeeded - 1, memo)) ok = true;
      counts[i] += 3;
    }

    if (!ok) {
      const partners = CHOW_PARTNERS[i];
      if (partners && counts[partners[0]] > 0 && counts[partners[1]] > 0) {
        counts[i]--;
        counts[partners[0]]--;
        counts[partners[1]]--;
        if (refCanDecompose(counts, setsNeeded - 1, memo)) ok = true;
        counts[i]++;
        counts[partners[0]]++;
        counts[partners[1]]++;
      }
    }
  }

  memo.set(key, ok);
  return ok;
}

/** Reference "pair + setsNeeded sets" existence check over a 34-length count vector. */
function refCanWinCounts(counts: number[], setsNeeded: number): boolean {
  const memo = new Map<string, boolean>();
  for (let pairIndex = 0; pairIndex < N; pairIndex++) {
    if (counts[pairIndex] < 2) continue;
    counts[pairIndex] -= 2;
    const ok = refCanDecompose(counts, setsNeeded, memo);
    counts[pairIndex] += 2;
    if (ok) return true;
  }
  return false;
}

function countsFrom(tiles: readonly Tile[]): number[] {
  const counts = new Array<number>(N).fill(0);
  for (const t of tiles) {
    const idx = HAND_TILE_KINDS.findIndex((k) => kindKey(k) === kindKey(t.kind));
    if (idx === -1) throw new Error(`unexpected non-hand tile kind ${kindKey(t.kind)}`);
    counts[idx]++;
  }
  return counts;
}

let idCounter = 0;
function makeTile(kind: TileKind): Tile {
  idCounter += 1;
  return { id: `${kindKey(kind)}-fuzz${idCounter}`, kind };
}

/** Builds a random count vector of exactly `total` tiles, each kind capped at 4 copies. */
function randomCounts(rng: () => number, total: number): number[] {
  const counts = new Array<number>(N).fill(0);
  let remaining = total;
  let guard = 0;
  while (remaining > 0) {
    guard += 1;
    if (guard > total * 200) throw new Error('randomCounts: could not place all tiles (unexpected)');
    const idx = randInt(rng, N);
    if (counts[idx] < 4) {
      counts[idx]++;
      remaining--;
    }
  }
  return counts;
}

function countsToTiles(counts: number[]): Tile[] {
  const tiles: Tile[] = [];
  for (let i = 0; i < N; i++) {
    for (let c = 0; c < counts[i]; c++) {
      tiles.push(makeTile(HAND_TILE_KINDS[i]));
    }
  }
  return tiles;
}

/** Fisher-Yates shuffle with the seeded RNG (avoids id-order bias). */
function shuffle<T>(arr: T[], rng: () => number): T[] {
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = randInt(rng, i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

describe('hand.ts vs independent reference oracle (fuzz)', () => {
  it('pure-random 17-tile hands: canWin(concealed16, 0, candidate) matches the reference for 400 random draws', () => {
    const rng = mulberry32(0xc0ffee);
    for (let iter = 0; iter < 400; iter++) {
      const counts = randomCounts(rng, 17);
      const tiles = shuffle(countsToTiles(counts), rng);
      const candidate = tiles[0];
      const concealed = tiles.slice(1);

      const expected = refCanWinCounts(counts.slice(), 5);
      const actual = canWin(concealed, 0, candidate);
      expect(actual, `mismatch on counts=${JSON.stringify(counts)} candidate=${kindKey(candidate.kind)}`).toBe(
        expected,
      );
    }
  });

  it('constructed random winning hands (5 random sets + random pair): canWin is always true and matches reference', () => {
    const rng = mulberry32(0x5eed01);
    let successes = 0;
    for (let iter = 0; iter < 200; iter++) {
      const counts = new Array<number>(N).fill(0);
      let built = true;

      // Random pair.
      const pairIdx = randInt(rng, N);
      counts[pairIdx] += 2;
      if (counts[pairIdx] > 4) built = false;

      for (let s = 0; s < 5 && built; s++) {
        const wantChow = randInt(rng, 2) === 0;
        if (wantChow) {
          // Find a random suit-eligible chow start.
          const eligible = HAND_TILE_KINDS.map((_, i) => i).filter((i) => CHOW_PARTNERS[i] !== null);
          const start = eligible[randInt(rng, eligible.length)];
          const [p1, p2] = CHOW_PARTNERS[start] as [number, number];
          counts[start]++;
          counts[p1]++;
          counts[p2]++;
          if (counts[start] > 4 || counts[p1] > 4 || counts[p2] > 4) built = false;
        } else {
          const kindIdx = randInt(rng, N);
          counts[kindIdx] += 3;
          if (counts[kindIdx] > 4) built = false;
        }
      }

      if (!built) continue; // skip invalid draws (exceeded 4 copies); still exercised by other iterations
      successes++;

      const tiles = shuffle(countsToTiles(counts), rng);
      expect(tiles.length).toBe(17);
      const candidate = tiles[0];
      const concealed = tiles.slice(1);

      expect(canWin(concealed, 0, candidate)).toBe(true);
      expect(refCanWinCounts(counts.slice(), 5)).toBe(true);

      // Near-miss: swap the candidate for a kind that is NOT a real wait, and
      // confirm both hand.ts and the reference agree it does NOT complete.
      const realWaits = new Set(waitingTiles(concealed, 0).map((k) => kindKey(k)));
      const nonWaitIndex = HAND_TILE_KINDS.map((_, i) => i).find((i) => {
        if (realWaits.has(kindKey(HAND_TILE_KINDS[i]))) return false;
        return counts[i] < 4; // must be a physically drawable candidate
      });
      if (nonWaitIndex !== undefined) {
        const badCandidate = makeTile(HAND_TILE_KINDS[nonWaitIndex]);
        expect(canWin(concealed, 0, badCandidate)).toBe(false);
        // Recompute counts fully from concealed + badCandidate (concealed
        // already excludes the original candidate's contribution).
        const concealedCounts = countsFrom(concealed);
        concealedCounts[nonWaitIndex]++;
        expect(refCanWinCounts(concealedCounts, 5)).toBe(false);
      }
    }
    expect(successes).toBeGreaterThan(100); // sanity: construction should mostly succeed
  });

  it('waitingTiles matches the reference oracle across 40 random concealed 16-tile hands (all 34 kinds probed each)', () => {
    const rng = mulberry32(0xba5eba11);
    for (let iter = 0; iter < 40; iter++) {
      const counts = randomCounts(rng, 16);
      const concealed = countsToTiles(counts);

      const engineResult = new Set(waitingTiles(concealed, 0).map((k) => kindKey(k)));

      for (let i = 0; i < N; i++) {
        const probeCounts = counts.slice();
        const kind = HAND_TILE_KINDS[i];
        const expectedDeadWait = counts[i] >= 4;
        probeCounts[i]++;
        const refResult = probeCounts[i] <= 4 && refCanWinCounts(probeCounts, 5);
        // hand.ts explicitly excludes dead waits (4 copies already held) even
        // though the reference oracle would also naturally return false for
        // count>4 (capped), so both must agree kind-by-kind.
        const engineHas = engineResult.has(kindKey(kind));
        expect(
          engineHas,
          `kind=${kindKey(kind)} counts=${JSON.stringify(counts)} expectedDeadWait=${expectedDeadWait} refResult=${refResult}`,
        ).toBe(refResult);
      }
    }
  });

  it('performance: a "busy" ladder hand with many overlapping chow candidates resolves quickly and consistently', () => {
    // wan 1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8 — dense overlapping-chow shape.
    const counts = new Array<number>(N).fill(0);
    for (let rank = 1; rank <= 8; rank++) {
      counts[rank - 1] = 2; // wan block occupies indices 0..8
    }
    const concealed = countsToTiles(counts);
    expect(concealed.length).toBe(16);

    const start = Date.now();
    const result = waitingTiles(concealed, 0);
    const elapsedMs = Date.now() - start;
    expect(elapsedMs).toBeLessThan(2000);

    // Round-trip consistency: every returned kind must independently canWin,
    // and a sample of non-returned kinds must not.
    for (const kind of result) {
      const candidate = makeTile(kind);
      expect(canWin(concealed, 0, candidate)).toBe(true);
    }
    const returnedKeys = new Set(result.map(kindKey));
    let checkedNonWaits = 0;
    for (const kind of HAND_TILE_KINDS) {
      if (returnedKeys.has(kindKey(kind))) continue;
      if (checkedNonWaits >= 10) break;
      checkedNonWaits++;
      const candidate = makeTile(kind);
      expect(canWin(concealed, 0, candidate)).toBe(false);
    }
    expect(result.length).toBeGreaterThan(0);
  });
});
