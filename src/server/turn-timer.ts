/**
 * Server-authoritative UX turn-timer enforcement (`RulesConfig
 * .turnTimerSeconds`). This is deliberately a THIN layer on top of
 * `replay.ts`'s existing primitives — it never re-implements engine legality
 * or the optimistic-concurrency write discipline, it only decides WHEN a
 * window has expired and WHAT auto-action to submit on the current turn
 * seat's/unresponded seat's behalf when it has.
 *
 * `applyTurnTimeouts` is modeled directly on `replay.ts`'s `applyAutoPass`:
 * a bounded loop that re-derives fresh state (via `getCurrentHandState`)
 * before every single append attempt — even the first — and loops back to a
 * fresh read on a `'seq-conflict'` rather than blindly retrying a stale
 * payload. This is what makes two concurrent enforcement attempts on the
 * same expired window (e.g. two different clients' SSE poll ticks racing)
 * produce exactly ONE auto-action row rather than a duplicate — the exact
 * bug class `applyAutoPass`'s own doc comment documents fixing.
 */

import type { Client } from '@libsql/client';
import { applyAction, isRuleError, type GameState, type Phase } from '../engine/game-state';
import { normalizeRules, type RulesConfig } from '../engine/rules-config';
import { SEATS } from '../engine/seats';
import { sortTilesForDisplay } from '../lib/table/tile-display';
import { appendActionAtSeq, getLatestActionCreatedAt, type LoggedGameAction } from './actions-log';
import { applyAutoPass, getCurrentHandState } from './replay';

const MAX_TIMEOUT_ITERATIONS = 10;

// --- computeTurnDeadline -----------------------------------------------------

/**
 * Pure: the epoch-ms instant the currently-open decision window (per
 * `windowOpenedAt`, see `replay.ts`'s `foldActionRows`/`getCurrentHandState`)
 * expires, or null if no deadline applies:
 * - `phaseType === 'hand-over'` — no decision window is open.
 * - `status !== 'in-progress'` — the game hasn't started, or has already
 *   ended; there is nothing to enforce.
 * - `rules.turnTimerSeconds <= 0` — the timer is disabled for this game
 *   (also the correct behavior for any legacy persisted config that
 *   predates this field, once `normalizeRules` back-fills the positive
 *   default — an explicit override is required to actually disable it).
 */
export function computeTurnDeadline(
  rules: RulesConfig,
  windowOpenedAt: number,
  phaseType: Phase['type'],
  status: 'waiting-for-players' | 'in-progress' | 'finished',
): number | null {
  if (phaseType === 'hand-over') return null;
  if (status !== 'in-progress') return null;
  if (rules.turnTimerSeconds <= 0) return null;
  return windowOpenedAt + rules.turnTimerSeconds * 1000;
}

// --- pickTimeoutAction --------------------------------------------------------

/**
 * Pure: the single auto-action to submit on behalf of whichever seat's
 * decision window has expired, covering every phase type that can have an
 * open window. Returns null for `hand-over`, or for `awaiting-claims`/
 * `awaiting-rob-kong` once every eligible seat has already responded (the
 * window is just waiting to resolve, nothing left to auto-act on).
 *
 * This is an explicit, intentionally-simple v1 heuristic — NOT an
 * efficiency AI:
 * - `awaiting-draw` → draw for the current turn seat.
 * - `awaiting-discard` → discard the RIGHTMOST tile in canonical display
 *   order (`sortTilesForDisplay`, the same order the UI renders a hand in)
 *   among the concealed tiles EXCLUDING the just-drawn tile (if any). If
 *   that excluded set is empty (the drawn tile is the seat's only concealed
 *   tile — e.g. immediately after a kong shrinks the hand to just the
 *   replacement draw), discard the drawn tile itself.
 * - `awaiting-claims` → pass for the first (lowest seat number, matching
 *   `SEATS`'s iteration order — the same order `applyAutoPass` uses) still-
 *   unresponded non-discarder seat.
 * - `awaiting-rob-kong` → pass for the first still-unresponded seat among
 *   `phase.eligibleRobbers`.
 *
 * Every returned action carries `timedOut: true` — a pure audit tag, never
 * read by the engine (see `LoggedGameAction`'s doc comment in
 * `actions-log.ts`) — so a timeout-tagged discard/pass replays to IDENTICAL
 * `GameState` as the same action submitted manually.
 */
export function pickTimeoutAction(state: GameState): LoggedGameAction | null {
  const phase = state.phase;

  switch (phase.type) {
    case 'awaiting-draw':
      return { type: 'draw', seat: state.currentTurnSeat, timedOut: true };

    case 'awaiting-discard': {
      const seat = state.currentTurnSeat;
      const hand = state.players[seat].hand;
      const drawnTile = phase.drawnTile;
      const candidates =
        drawnTile === null ? hand.concealedTiles : hand.concealedTiles.filter((t) => t.id !== drawnTile.id);

      if (candidates.length > 0) {
        const sorted = sortTilesForDisplay(candidates);
        return { type: 'discard', seat, tileId: sorted[sorted.length - 1].id, timedOut: true };
      }
      if (drawnTile !== null) {
        // Only the just-drawn tile remains concealed — discard it.
        return { type: 'discard', seat, tileId: drawnTile.id, timedOut: true };
      }
      // Unreachable in a valid game: a hand always holds at least one
      // concealed tile while awaiting a discard. Never silently fabricate a
      // discard for a corrupt hand — this indicates an engine-invariant
      // violation, the same category `replay.ts`'s fold errors guard.
      throw new Error(
        `pickTimeoutAction: seat ${seat} has zero concealed tiles while awaiting-discard with no drawn tile`,
      );
    }

    case 'awaiting-claims': {
      const seat = SEATS.find((s) => s !== phase.discarderSeat && phase.responses[s] === undefined);
      return seat === undefined ? null : { type: 'pass', seat, timedOut: true };
    }

    case 'awaiting-rob-kong': {
      const seat = phase.eligibleRobbers.find((s) => phase.responses[s] === undefined);
      return seat === undefined ? null : { type: 'pass', seat, timedOut: true };
    }

    case 'hand-over':
      return null;
  }
}

// --- applyTurnTimeouts ---------------------------------------------------------

/**
 * The enforcer: if the game's currently-open decision window has expired,
 * appends the appropriate auto-action(s) (see `pickTimeoutAction`) on the
 * responsible seat's/seats' behalf. A no-op in every other case (disabled
 * timer, game not in-progress, no active hand, window not yet expired).
 *
 * Two-stage design:
 *
 * 1. A CHEAP GATE first: a single lightweight `games` row read (status +
 *    rules_config) plus a single lightweight latest-action-row read
 *    (`getLatestActionCreatedAt`) — no full hand replay. If
 *    `now < latestActionCreatedAt + turnTimerSeconds*1000`, the window is
 *    DEFINITELY not expired yet (this bound is intentionally conservative:
 *    `latestActionCreatedAt` can be strictly newer than the true
 *    `windowOpenedAt` when mid-window, non-signature-changing responses
 *    have landed since the window actually opened — e.g. one of several
 *    claimants passing while others are still deciding — so this gate may
 *    skip enforcement for up to `turnTimerSeconds` longer than the true
 *    deadline in that case. That's an accepted, documented tradeoff for
 *    avoiding a full replay on every SSE poll tick of every in-progress
 *    game, not a bug), so we return immediately without ever folding the
 *    hand through the engine.
 *
 * 2. Only once the cheap gate suggests expiry is POSSIBLE does this loop
 *    (bounded at `MAX_TIMEOUT_ITERATIONS`): fresh `getCurrentHandState`
 *    (which also yields the true `windowOpenedAt` and `rules` — see
 *    `replay.ts`), recompute the real deadline via `computeTurnDeadline`,
 *    and return if it turns out NOT actually expired (the cheap gate is
 *    only ever a conservative lower bound — always recheck with the real
 *    `windowOpenedAt` before ever appending). Otherwise pick and append the
 *    auto-action for the current window at `lastSeq + 1`. On a
 *    `'seq-conflict'` (another concurrent `applyTurnTimeouts` call — or a
 *    genuine concurrent `submitAction` — claimed that seq first), loop back
 *    to a fresh read rather than retrying the same payload — never durably
 *    double-append. If a claim/rob-kong window has multiple still-
 *    unresponded seats sharing the same expired deadline, this correctly
 *    keeps passing every remaining one within the SAME call: each
 *    successful append loops back to a fresh replay, `windowOpenedAt` is
 *    unchanged (a mid-window pass doesn't change the window signature —
 *    see `foldActionRows`), so the still-expired deadline holds and
 *    `pickTimeoutAction` simply picks the next unresponded seat.
 *
 * If the freshly-derived state no longer accepts the picked auto-action
 * (a `RuleError` — this can legitimately happen if state changed since the
 * gate read, e.g. a real player action landed and resolved the window in
 * between), this stops cleanly and logs rather than throwing: a timer-
 * enforcement failure must never crash/500 the calling route. The same
 * applies if the bounded loop is exhausted without converging.
 *
 * Every successful append also runs `applyAutoPass` (a cheap no-op unless
 * the append just opened a new `awaiting-claims` window), matching
 * `submitAction`'s own immediate follow-through — otherwise an auto-discard
 * with zero legal claimants would sit unresolved for a full extra
 * `turnTimerSeconds` before the next enforcement sweep even looks at it.
 */
export async function applyTurnTimeouts(db: Client, gameId: string): Promise<void> {
  const gameRow = await db.execute({
    sql: 'SELECT status, rules_config FROM games WHERE id = ?',
    args: [gameId],
  });
  if (gameRow.rows.length === 0) return;

  const status = String(gameRow.rows[0].status) as 'waiting-for-players' | 'in-progress' | 'finished';
  if (status !== 'in-progress') return;

  const rules = normalizeRules(JSON.parse(String(gameRow.rows[0].rules_config)) as Partial<RulesConfig>);
  if (rules.turnTimerSeconds <= 0) return;

  const latestActionCreatedAt = await getLatestActionCreatedAt(db, gameId);
  if (latestActionCreatedAt === null) return; // no hand has started yet

  if (Date.now() < latestActionCreatedAt + rules.turnTimerSeconds * 1000) {
    // Conservative cheap-gate bound: definitely not expired yet — see this
    // function's doc comment for why this is safe to skip without a replay.
    return;
  }

  for (let attempt = 0; attempt < MAX_TIMEOUT_ITERATIONS; attempt++) {
    const fresh = await getCurrentHandState(db, gameId);
    if (fresh === null) return;
    const { state, handNumber, lastSeq, windowOpenedAt, rules: freshRules } = fresh;

    // `status` here is the same value the cheap gate already confirmed is
    // 'in-progress'; a mid-loop transition to 'finished' can only happen via
    // a hand-over that ends the match, which is already independently
    // covered by `computeTurnDeadline`'s own `phaseType === 'hand-over'`
    // null-return below — so re-querying `games.status` on every iteration
    // would be redundant, not a correctness gap.
    const deadline = computeTurnDeadline(freshRules, windowOpenedAt, state.phase.type, 'in-progress');
    if (deadline === null || Date.now() < deadline) return;

    const action = pickTimeoutAction(state);
    if (action === null) return;

    const applied = applyAction(state, action);
    if (isRuleError(applied)) {
      console.error(
        `[turn-timer] auto-action rejected by fresh state for game ${gameId} hand ${handNumber} ` +
          `(action ${JSON.stringify(action)}): [${applied.code}] ${applied.message}`,
      );
      return;
    }

    const appendResult = await appendActionAtSeq(db, gameId, handNumber, action, lastSeq + 1);
    if (appendResult === 'seq-conflict') {
      // Someone else (another concurrent applyTurnTimeouts call, or a real
      // player submitAction) claimed lastSeq + 1 first — loop back to a
      // fresh replay/re-check rather than retrying this same payload.
      continue;
    }

    // Mirror submitAction's own immediate follow-through (replay.ts): an
    // auto-discard can open a brand-new awaiting-claims window whose
    // zero-legal-option seats should be auto-passed instantly, exactly as
    // they would be for a manually-submitted discard — not left sitting
    // until a SECOND full turnTimerSeconds cycle elapses before the next
    // enforcement sweep even looks at them (a real bug found in review:
    // this window's own windowOpenedAt is "now", so the next loop iteration
    // below correctly sees it as not-yet-expired and would otherwise return
    // without ever clearing an unclaimable discard). `applyAutoPass` is a
    // cheap no-op (single fast-path check, no query) when `applied.phase`
    // isn't `awaiting-claims`.
    await applyAutoPass(db, gameId, handNumber, applied, lastSeq + 1);
    // Successful append; loop back for a fresh replay before considering
    // whether another seat's window is still expired (claim/rob-kong
    // windows may have multiple remaining seats sharing this deadline).
  }

  console.error(
    `[turn-timer] applyTurnTimeouts did not converge after ${MAX_TIMEOUT_ITERATIONS} attempts for game ${gameId}`,
  );
}
