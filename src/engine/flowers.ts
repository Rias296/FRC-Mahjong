/**
 * Flower exposure and replacement-draw chaining for the Taiwan Mahjong engine.
 * See docs/RULES.md §5 (flowers), §3.3 step 3 (initial-deal flower
 * replacement), and §10 (wall exhaustion / the flower-exhaustion signal).
 *
 * Pure data types + pure functions only. Imports only from ./tiles, ./wall,
 * ./seats, ./deal (type DealResult), ./rules-config.
 *
 * `replaceOneFlower` is the single replacement-draw primitive for BOTH
 * flower-triggered (§5) and kong-triggered (§6.2/§6.3) replacement draws —
 * future GameState calls it directly after a kong stands (post-rob-window,
 * §7.2 step 4) rather than reimplementing tail-draw-with-reserve logic.
 */

import { isFlowerTile, type Tile } from './tiles';
import { drawFromTail, remaining, type Wall } from './wall';
import { nextSeat, SEATS, type Seat } from './seats';
import type { DealResult } from './deal';
import type { RulesConfig } from './rules-config';

/**
 * True iff a tail draw is legal right now: `remaining(wall) > rules.deadWallReserve`
 * (RULES.md §10). Never reimplements deque logic — always goes through `remaining`.
 */
function canDrawTail(wall: Wall, rules: RulesConfig): boolean {
  return remaining(wall) > rules.deadWallReserve;
}

/**
 * The single obligated replacement-draw primitive (RULES.md §5): draws one
 * tile from the tail, chaining internally through any further flowers until
 * a non-flower tile is drawn or the reserve blocks the next draw.
 *
 * - If the reserve blocks the very first draw attempt, returns
 *   `{ tile: null, chainedFlowers: [], wall }` with `wall` unchanged
 *   (reference/content) from the input — no draw occurred.
 * - If the reserve blocks a later draw mid-chain, returns
 *   `{ tile: null, chainedFlowers: <flowers exposed so far>, wall: <wall after those draws> }`
 *   (RULES.md §5's no-legal-replacement case, feeding the §10 exhaustion signal).
 * - Otherwise returns the first non-flower tile drawn, along with every
 *   flower chained through (in exposure order) to reach it.
 *
 * Never mutates the input `wall`. Never returns a bare `null` — always this
 * object shape, with `tile: Tile | null` signaling exhaustion.
 */
export function replaceOneFlower(
  wall: Wall,
  rules: RulesConfig,
): { tile: Tile | null; chainedFlowers: Tile[]; wall: Wall } {
  let currentWall: Wall = wall;
  const chainedFlowers: Tile[] = [];

  for (;;) {
    if (!canDrawTail(currentWall, rules)) {
      return { tile: null, chainedFlowers, wall: currentWall };
    }

    const drawn = drawFromTail(currentWall);
    currentWall = drawn.wall;

    if (!isFlowerTile(drawn.tile)) {
      return { tile: drawn.tile, chainedFlowers, wall: currentWall };
    }

    chainedFlowers.push(drawn.tile);
  }
}

/**
 * Mid-game single-draw flower-chain wrapper (RULES.md §4 step 2). If
 * `firstDrawnTile` is not a flower, this is a no-op: zero tail draws, `wall`
 * returned untouched. If it is a flower, resolves the full replacement chain
 * via `replaceOneFlower`.
 *
 * `finalTile: null` signals wall exhaustion mid-chain (RULES.md §10): the
 * hand ends immediately with no discard. This function only reports the
 * signal — it does not act on it.
 *
 * Does not validate that `firstDrawnTile` actually came from `wall`; that is
 * the caller's contract, not this function's job.
 */
export function resolveFlowerChain(
  wall: Wall,
  firstDrawnTile: Tile,
  rules: RulesConfig,
): { finalTile: Tile | null; exposedFlowers: Tile[]; wall: Wall } {
  if (!isFlowerTile(firstDrawnTile)) {
    return { finalTile: firstDrawnTile, exposedFlowers: [], wall };
  }

  const result = replaceOneFlower(wall, rules);
  return {
    finalTile: result.tile,
    exposedFlowers: [firstDrawnTile, ...result.chainedFlowers],
    wall: result.wall,
  };
}

/**
 * Initial-deal flower replacement (RULES.md §3.3 step 3): starting with
 * `dealer` and proceeding in turn order (via `nextSeat`), each seat fully
 * resolves its dealt flowers — including any chained replacement flowers —
 * before the next seat starts.
 *
 * On full success (`exhausted: false`), every seat's hand array holds
 * exactly 16 non-flower tiles: the originally-dealt non-flower tiles in
 * dealt order, followed by replacement tiles in draw order. Every exposed
 * flower (dealt, or drawn as a replacement that was itself a flower) lands
 * in that seat's flowers output array, in exposure order.
 *
 * If a replacement draw hits the reserve (RULES.md §10), processing stops
 * immediately — no further flowers in that seat, and no later seats, are
 * processed — and the partial state accumulated so far is returned with
 * `exhausted: true`. This is a legal (if unusual) outcome of a degenerate
 * `RulesConfig`, not an engine invariant violation, so it is signaled, never
 * thrown.
 *
 * **Conservation on `exhausted: true`:** every one of the 144 tiles handed to
 * this function is accounted for in exactly one place in the return value:
 * a fully-resolved seat's `hands` + `flowers`, the actively-blocked seat's
 * partial `hands` + `flowers`, an unprocessed seat's raw dealt hand, or the
 * final `wall`. Seats whose turn was never reached (later in turn order than
 * the seat that triggered exhaustion) never had any replacement draws
 * attempted for them, so they cannot be "resolved" — instead their raw,
 * unresolved 16-tile dealt hand (`dealResult.hands[seat]`, exactly as dealt,
 * which may still include flower tiles) is copied verbatim into
 * `hands[seat]`, and `flowers[seat]` is left `[]` (no flowers were exposed
 * for them). Callers that need to detect this precisely must check for
 * flower tiles inside `hands[seat]` themselves; most callers should simply
 * treat any `exhausted: true` result as "this initial deal did not complete,
 * discard/redo."
 *
 * Does not mutate `dealResult` or its `hands`/`wall`. Deterministic for
 * identical inputs.
 */
export function resolveInitialDeal(
  dealResult: DealResult,
  dealer: Seat,
  rules: RulesConfig,
): {
  hands: readonly [Tile[], Tile[], Tile[], Tile[]];
  flowers: readonly [Tile[], Tile[], Tile[], Tile[]];
  wall: Wall;
  exhausted: boolean;
} {
  const hands: [Tile[], Tile[], Tile[], Tile[]] = [[], [], [], []];
  const flowers: [Tile[], Tile[], Tile[], Tile[]] = [[], [], [], []];
  let currentWall: Wall = dealResult.wall;
  const reached: [boolean, boolean, boolean, boolean] = [false, false, false, false];

  let seat: Seat = dealer;
  for (let turn = 0; turn < 4; turn++) {
    const s = seat;
    reached[s] = true;
    const dealtHand = dealResult.hands[s];
    const kept = dealtHand.filter((t) => !isFlowerTile(t));
    const dealtFlowers = dealtHand.filter(isFlowerTile);

    hands[s] = kept.slice();
    flowers[s] = [];

    for (const flower of dealtFlowers) {
      flowers[s].push(flower);

      const result = replaceOneFlower(currentWall, rules);
      flowers[s].push(...result.chainedFlowers);
      currentWall = result.wall;

      if (result.tile === null) {
        // Conservation: seats whose turn was never reached still hold their
        // full, raw, unresolved dealt hand (RULES.md §3.3 step 3) — copy it
        // verbatim so no tile silently vanishes from the return value.
        for (const unreachedSeat of SEATS) {
          if (!reached[unreachedSeat]) {
            hands[unreachedSeat] = dealResult.hands[unreachedSeat].slice();
          }
        }
        return { hands, flowers, wall: currentWall, exhausted: true };
      }

      hands[s].push(result.tile);
    }

    seat = nextSeat(seat);
  }

  return { hands, flowers, wall: currentWall, exhausted: false };
}
