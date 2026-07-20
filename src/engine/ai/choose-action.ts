/**
 * v1 heuristic AI bot: the single decision entry point `chooseAiAction`.
 *
 * Pure function of (state, seat): no randomness, no Date.now(), no side
 * effects. Two calls with identical inputs always return identical output —
 * this determinism is load-bearing for a future server round's concurrency
 * safety.
 *
 * This is an explicit, intentionally-simple v1 heuristic — NOT a shanten-
 * optimal or search-based AI. See ./shape.ts for the shape/connectivity
 * primitives this module ranks discards and claims with.
 *
 * Deviations from the original brief (see this module's exported functions'
 * doc comments for the reasoning behind each):
 *  - Kong-safety's "after simulating the kong" check uses `waitingTiles`
 *    directly on the post-kong hand, not `hasTenpaiDiscard`. All three kong
 *    forms (concealed/added/from-discard) leave the hand in AT-REST shape
 *    (16 - 3*newMeldCount concealed tiles) immediately after the kong and
 *    before any replacement draw — never MUST-ACT shape — so there is no
 *    discard to simulate at that point; `hasTenpaiDiscard` would throw
 *    (`waitingTiles`'s own length assertion) if called there. The "before
 *    the kong" checks correctly use `hasTenpaiDiscard` (own-turn kongs, a
 *    MUST-ACT pre-hand) or a direct `waitingTiles` call (kong-from-discard,
 *    an AT-REST pre-hand, mirroring the pung/chow "currently waiting" check)
 *    as appropriate for each phase's real hand shape.
 *  - When multiple kinds are eligible for a concealed/added kong, only the
 *    first (HAND_TILE_KINDS-canonical-order for concealed;
 *    `canAddedKong`'s own returned order for added) is evaluated for
 *    kong-safety. This keeps the v1 heuristic to a single deterministic
 *    check per own-turn decision rather than a multi-candidate search.
 */

import { kindKey, type Tile, type TileKind } from '../tiles';
import { canWin, waitingTiles } from '../hand';
import {
  canAddedKong,
  canChow,
  canConcealedKong,
  canKongFromDiscard,
  canPung,
  type ChowOption,
  type PlayerHand,
} from '../actions';
import { nextSeat, type Seat } from '../seats';
import { remaining } from '../wall';
import { computeHandTai, meetsMinimumTai } from '../scoring';
import { type GameAction, type GameState } from '../game-state';
import { hasTenpaiDiscard, leastConnectedDiscard, shapeScore } from './shape';

export interface AiDecision {
  readonly action: GameAction;
  /** Short server-log-only text, NOT user-facing — exempt from i18n rules. */
  readonly reasoning: string;
}

// --- Local, non-mutating claim-simulation helpers ---------------------------
// Deliberately NOT built via applyAction: that would commit to wall/
// replacement-draw state we must not touch while merely deciding.

interface SimulatedHand {
  readonly concealedTiles: readonly Tile[];
  readonly meldCount: number;
}

function removeFirstMatches(tiles: readonly Tile[], kind: TileKind, count: number): Tile[] {
  const key = kindKey(kind);
  const toRemove = new Set(
    tiles.filter((t) => kindKey(t.kind) === key).slice(0, count).map((t) => t.id),
  );
  return tiles.filter((t) => !toRemove.has(t.id));
}

function removeById(tiles: readonly Tile[], ids: ReadonlySet<string>): Tile[] {
  return tiles.filter((t) => !ids.has(t.id));
}

function simulateConcealedKong(hand: PlayerHand, kind: TileKind): SimulatedHand {
  return { concealedTiles: removeFirstMatches(hand.concealedTiles, kind, 4), meldCount: hand.melds.length + 1 };
}

function simulateAddedKong(hand: PlayerHand, tileToAdd: Tile): SimulatedHand {
  return {
    concealedTiles: removeById(hand.concealedTiles, new Set([tileToAdd.id])),
    meldCount: hand.melds.length,
  };
}

function simulateKongFromDiscard(hand: PlayerHand, discardedTile: Tile): SimulatedHand {
  return {
    concealedTiles: removeFirstMatches(hand.concealedTiles, discardedTile.kind, 3),
    meldCount: hand.melds.length + 1,
  };
}

function simulatePung(hand: PlayerHand, discardedTile: Tile): SimulatedHand {
  return {
    concealedTiles: removeFirstMatches(hand.concealedTiles, discardedTile.kind, 2),
    meldCount: hand.melds.length + 1,
  };
}

function simulateChow(hand: PlayerHand, option: ChowOption): SimulatedHand {
  const usedIds = new Set(option.concealedTilesUsed.map((t) => t.id));
  return { concealedTiles: removeById(hand.concealedTiles, usedIds), meldCount: hand.melds.length + 1 };
}

// --- Kong-safety -------------------------------------------------------------

/**
 * Own-turn kong safety (concealed/added): the pre-kong hand is MUST-ACT
 * shape (17 - 3*meldCount — the player already drew this turn), so
 * `hasTenpaiDiscard` is the correct "is there currently something worth
 * protecting" check. See this module's top doc comment for why the
 * post-kong check uses `waitingTiles` directly instead.
 */
function isOwnTurnKongSafe(hand: PlayerHand, simulated: SimulatedHand): boolean {
  if (!hasTenpaiDiscard(hand.concealedTiles, hand.melds.length)) {
    return true; // nothing to protect — take the free replacement draw
  }
  return waitingTiles(simulated.concealedTiles, simulated.meldCount).length > 0;
}

/**
 * Claim-window kong-from-discard safety: the pre-claim hand is AT-REST shape
 * (16 - 3*meldCount — this seat has not drawn this turn), so "currently
 * waiting" is a direct `waitingTiles` call, mirroring the pung/chow
 * "currently waiting" check in `claimImproves` below.
 */
function isClaimKongSafe(hand: PlayerHand, discardedTile: Tile): boolean {
  const currentlyWaiting = waitingTiles(hand.concealedTiles, hand.melds.length).length > 0;
  if (!currentlyWaiting) {
    return true;
  }
  const simulated = simulateKongFromDiscard(hand, discardedTile);
  return waitingTiles(simulated.concealedTiles, simulated.meldCount).length > 0;
}

// --- "Improves" (pung/chow) ---------------------------------------------------

/** The best (highest) shapeScore achievable by discarding exactly one tile from `concealedTiles`. */
function bestPostDiscardShapeScore(concealedTiles: readonly Tile[]): number {
  let best = -Infinity;
  for (let i = 0; i < concealedTiles.length; i++) {
    const remainder = [...concealedTiles.slice(0, i), ...concealedTiles.slice(i + 1)];
    const score = shapeScore(remainder);
    if (score > best) best = score;
  }
  return best;
}

/**
 * Pung/chow claim-value heuristic (see brief): if the pre-claim (AT-REST)
 * hand is currently waiting, only claim if a tenpai discard still exists
 * after the claim (the post-claim hand is MUST-ACT shape, so
 * `hasTenpaiDiscard` applies directly). If NOT currently waiting, claim iff
 * the post-claim meld-count-plus-shape score strictly beats the pre-claim
 * one.
 */
function claimImproves(hand: PlayerHand, simulated: SimulatedHand): boolean {
  const preMeldCount = hand.melds.length;
  const currentlyWaiting = waitingTiles(hand.concealedTiles, preMeldCount).length > 0;

  if (currentlyWaiting) {
    return hasTenpaiDiscard(simulated.concealedTiles, simulated.meldCount);
  }

  const preScore = 100 * preMeldCount + shapeScore(hand.concealedTiles);
  const postScore = 100 * simulated.meldCount + bestPostDiscardShapeScore(simulated.concealedTiles);
  return postScore > preScore;
}

// --- Phase handlers ------------------------------------------------------------

function chooseDrawAction(state: GameState, seat: Seat): AiDecision | null {
  if (seat !== state.currentTurnSeat) return null;
  return { action: { type: 'draw', seat }, reasoning: 'Own turn: draw is forced, nothing to decide.' };
}

function chooseOwnTurnAction(state: GameState, seat: Seat): AiDecision | null {
  if (state.phase.type !== 'awaiting-discard') return null;
  if (seat !== state.currentTurnSeat) return null;
  const phase = state.phase;

  const player = state.players[seat];
  const hand = player.hand;
  const rules = state.rules;

  // 1. Self-draw hu.
  if (phase.drawnTile !== null) {
    const drawnTile = phase.drawnTile;
    const concealedWithoutDrawn = hand.concealedTiles.filter((t) => t.id !== drawnTile.id);
    if (canWin(concealedWithoutDrawn, hand.melds.length, drawnTile)) {
      const handTai = computeHandTai({ winType: 'self-draw' }, rules);
      if (meetsMinimumTai(handTai, rules)) {
        return {
          action: { type: 'declare-hu', seat },
          reasoning: `Self-draw hu on ${drawnTile.id}: handTai ${handTai} meets minTaiToWin ${rules.minTaiToWin}.`,
        };
      }
    }
  }

  const hasReplacementRoom = remaining(state.wall) > rules.deadWallReserve;

  // 2. Concealed kong, if kong-safe.
  if (hasReplacementRoom) {
    const concealedKongKinds = canConcealedKong(hand);
    if (concealedKongKinds.length > 0) {
      const kind = concealedKongKinds[0];
      const simulated = simulateConcealedKong(hand, kind);
      if (isOwnTurnKongSafe(hand, simulated)) {
        return {
          action: { type: 'declare-concealed-kong', seat, kind },
          reasoning: `Concealed kong on ${kindKey(kind)}: kong-safe (preserves tenpai, or nothing to protect).`,
        };
      }
    }

    // 3. Added kong, if kong-safe.
    const addedKongKinds = canAddedKong(hand);
    if (addedKongKinds.length > 0) {
      const kind = addedKongKinds[0];
      const tileToAdd = hand.concealedTiles.find((t) => kindKey(t.kind) === kindKey(kind));
      if (tileToAdd !== undefined) {
        const simulated = simulateAddedKong(hand, tileToAdd);
        if (isOwnTurnKongSafe(hand, simulated)) {
          return {
            action: { type: 'declare-added-kong', seat, tileId: tileToAdd.id },
            reasoning: `Added kong on ${kindKey(kind)}: kong-safe (preserves tenpai, or nothing to protect).`,
          };
        }
      }
    }
  }

  // 4. Discard the least-connected tile.
  const discardTile = leastConnectedDiscard(hand.concealedTiles);
  return {
    action: { type: 'discard', seat, tileId: discardTile.id },
    reasoning: `Discard ${discardTile.id}: lowest shape connectivity among this hand's concealed tiles.`,
  };
}

function chooseClaimAction(state: GameState, seat: Seat): AiDecision | null {
  if (state.phase.type !== 'awaiting-claims') return null;
  const phase = state.phase;

  if (seat === phase.discarderSeat) return null;
  if (phase.responses[seat] !== undefined) return null;

  const discardedTile = phase.discardedTile;
  const player = state.players[seat];
  const hand = player.hand;
  const rules = state.rules;

  // 1. Hu.
  if (!player.barred && canWin(hand.concealedTiles, hand.melds.length, discardedTile)) {
    const handTai = computeHandTai({ winType: 'discard' }, rules);
    if (meetsMinimumTai(handTai, rules)) {
      return {
        action: { type: 'claim', seat, claim: { type: 'hu' } },
        reasoning: `Claim hu on ${discardedTile.id}: handTai ${handTai} meets minTaiToWin ${rules.minTaiToWin}.`,
      };
    }
  }

  const hasReplacementRoom = remaining(state.wall) > rules.deadWallReserve;

  // 2. Kong.
  if (hasReplacementRoom && canKongFromDiscard(hand, discardedTile) && isClaimKongSafe(hand, discardedTile)) {
    return {
      action: { type: 'claim', seat, claim: { type: 'kong' } },
      reasoning: `Claim kong on ${discardedTile.id}: kong-safe (preserves tenpai, or nothing to protect).`,
    };
  }

  // 3. Pung.
  if (canPung(hand, discardedTile)) {
    const simulated = simulatePung(hand, discardedTile);
    if (claimImproves(hand, simulated)) {
      return {
        action: { type: 'claim', seat, claim: { type: 'pung' } },
        reasoning: `Claim pung on ${discardedTile.id}: improves hand shape.`,
      };
    }
  }

  // 4. Chow — only the seat immediately after the discarder may ever have options.
  if (seat === nextSeat(phase.discarderSeat)) {
    const options = canChow(hand, discardedTile, seat, phase.discarderSeat);
    for (const option of options) {
      const simulated = simulateChow(hand, option);
      if (claimImproves(hand, simulated)) {
        const [a, b] = option.concealedTilesUsed;
        return {
          action: { type: 'claim', seat, claim: { type: 'chow', tileIds: [a.id, b.id] } },
          reasoning: `Claim chow on ${discardedTile.id} using ${a.id}/${b.id}: improves hand shape.`,
        };
      }
    }
  }

  // 5. Decline. The server's existing zero-option/timeout auto-pass
  // mechanisms are responsible for actually resolving this seat's response —
  // this function only ever reports "no decision", it never issues an
  // explicit pass.
  return null;
}

function chooseRobKongAction(state: GameState, seat: Seat): AiDecision | null {
  if (state.phase.type !== 'awaiting-rob-kong') return null;
  const phase = state.phase;

  if (!phase.eligibleRobbers.includes(seat)) return null;
  if (phase.responses[seat] !== undefined) return null;

  // eligibleRobbers already excludes ineligible seats (barred, below
  // minTaiToWin) — being on this list unconditionally means a real win.
  return {
    action: { type: 'declare-rob', seat },
    reasoning: `Rob the kong on ${phase.kongTile.id}: seat is an eligible robber, always a winning claim.`,
  };
}

/**
 * The v1 heuristic AI's single decision entry point. Returns `null` whenever
 * `seat` has no open decision: wrong turn, already responded, `hand-over`,
 * or (for `awaiting-draw`) simply not this seat's turn.
 *
 * `awaiting-draw` is handled even though the original brief's priority-order
 * sections only cover `awaiting-discard`/`awaiting-claims`/
 * `awaiting-rob-kong`: a full-hand simulation loop driven purely via
 * `chooseAiAction` + `applyAction` (see full-hand.fuzz.test.ts) has no other
 * way to advance past `awaiting-draw`, and drawing there is a forced,
 * zero-choice action anyway — reporting it here is consistent with "no open
 * decision" only ever meaning "this seat has nothing to legally do".
 */
export function chooseAiAction(state: GameState, seat: Seat): AiDecision | null {
  switch (state.phase.type) {
    case 'hand-over':
      return null;
    case 'awaiting-draw':
      return chooseDrawAction(state, seat);
    case 'awaiting-discard':
      return chooseOwnTurnAction(state, seat);
    case 'awaiting-claims':
      return chooseClaimAction(state, seat);
    case 'awaiting-rob-kong':
      return chooseRobKongAction(state, seat);
  }
}
