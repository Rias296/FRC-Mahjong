/**
 * Turns the persisted action log into a real GameState by folding it through
 * the actual engine (never a re-derivation shortcut), implements the
 * server-side auto-pass for zero-option seats, the optimistic-concurrency
 * write path (submitAction), and explicit hand-to-hand advancement
 * (advanceToNextHand), including prevailing-wind and game-over derivation.
 */

import { randomInt } from 'node:crypto';
import type { Client } from '@libsql/client';
import {
  applyAction,
  isRuleError,
  startHand,
  type GameAction,
  type GameState,
  type RuleError,
} from '../engine/game-state';
import { canChow, canKongFromDiscard, canPung } from '../engine/actions';
import { canWin } from '../engine/hand';
import type { RulesConfig } from '../engine/rules-config';
import { sumPaymentLegs, type SeatTotals } from '../engine/scoring';
import { SEATS, type Seat } from '../engine/seats';
import {
  appendActionAtSeq,
  appendStartHand,
  listActionsForGame,
  listActionsForHand,
  type ActionLogRow,
  type StartHandPayload,
} from './actions-log';

const MAX_AUTO_PASS_ATTEMPTS = 8;
const MAX_SUBMIT_OUTER_RETRIES = 5;

/**
 * Returned by submitAction when no hand exists to apply the action against
 * (e.g. the game hasn't started, or has finished with no further hands). The
 * engine itself has no dedicated code for "no hand exists" — it always
 * operates on an already-constructed GameState — so this is constructed here
 * using the existing 'wrong-phase' code with an explanatory message.
 */
const NO_ACTIVE_HAND_ERROR: RuleError = {
  type: 'rule-error',
  code: 'wrong-phase',
  message: 'No active hand exists for this game (it may not have started yet, or has already finished).',
};

// --- replayHand --------------------------------------------------------------

/**
 * Folds an already-fetched list of action-log rows for one hand through the
 * real engine: startHand from the stored start-hand payload, then
 * applyAction in seq order for everything after it. Throws a clear internal
 * error (never silently skips) if the log is corrupt: a missing/misplaced
 * start-hand row, or any applyAction call rejected by the engine. Shared,
 * DB-free fold logic used by both `replayHand` (which fetches its own rows)
 * and `getCurrentHandState` (which needs the fetched rows' seqs too, to
 * compute `lastSeq` without a second, potentially-racy round trip).
 */
function foldActionRows(
  gameId: string,
  handNumber: number,
  rows: readonly ActionLogRow[],
  rules: RulesConfig,
): GameState {
  if (rows.length === 0 || rows[0].actionType !== 'start-hand') {
    throw new Error(
      `replayHand: corrupt log for game ${gameId} hand ${handNumber} — expected the first row to be ` +
        `'start-hand', got ${rows.length === 0 ? '(no rows)' : rows[0].actionType}`,
    );
  }

  const startPayload = rows[0].payload as StartHandPayload;
  let state = startHand(startPayload.dealerSeat, startPayload.seed, rules, startPayload.repeatCount);

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const action = row.payload as GameAction;
    const result = applyAction(state, action);
    if (isRuleError(result)) {
      throw new Error(
        `replayHand: corrupt replay for game ${gameId} hand ${handNumber} at seq ${row.seq} ` +
          `(action ${JSON.stringify(action)}): [${result.code}] ${result.message}`,
      );
    }
    state = result;
  }

  return state;
}

/**
 * Reconstructs the GameState for one hand by replaying its action-log rows
 * through the real engine. Throws a clear internal error (never silently
 * skips) if the log is corrupt — see `foldActionRows`.
 */
export async function replayHand(
  db: Client,
  gameId: string,
  handNumber: number,
  rules: RulesConfig,
): Promise<GameState> {
  const rows = await listActionsForHand(db, gameId, handNumber);
  return foldActionRows(gameId, handNumber, rows, rules);
}

// --- getCurrentHandState -------------------------------------------------------

/**
 * Replays the latest hand for a game. Returns null if the game has zero
 * actions yet (shouldn't normally happen once in-progress, but handled
 * defensively rather than throwing).
 *
 * Also returns `lastSeq`: the seq of the last action-log row folded into
 * `state`. Since a hand's rows are always the most-recently-seq'd rows for
 * the game (seq is global per game, monotonic across hands, and earlier
 * hands never receive new rows once the current hand has started), `lastSeq`
 * is exactly the game's global latest seq at the instant these rows were
 * fetched — so `lastSeq + 1` is the correct, race-safe `expectedNextSeq` for
 * `appendActionAtSeq`, computed from the SAME read as the state it was
 * validated against (no separate, later `getLatestSeq` query that could
 * reintroduce a gap for a concurrent write to land in).
 */
export async function getCurrentHandState(
  db: Client,
  gameId: string,
): Promise<{ state: GameState; handNumber: number; lastSeq: number } | null> {
  const maxHandRow = await db.execute({
    sql: 'SELECT MAX(hand_number) AS max_hand FROM actions WHERE game_id = ?',
    args: [gameId],
  });
  const maxHand = maxHandRow.rows[0]?.max_hand;
  if (maxHand === null || maxHand === undefined) {
    return null;
  }
  const handNumber = Number(maxHand);

  const gameRow = await db.execute({
    sql: 'SELECT rules_config FROM games WHERE id = ?',
    args: [gameId],
  });
  if (gameRow.rows.length === 0) {
    throw new Error(`getCurrentHandState: no game found with id ${gameId}`);
  }
  const rules = JSON.parse(String(gameRow.rows[0].rules_config)) as RulesConfig;

  const rows = await listActionsForHand(db, gameId, handNumber);
  const state = foldActionRows(gameId, handNumber, rows, rules);
  const lastSeq = rows[rows.length - 1].seq;
  return { state, handNumber, lastSeq };
}

// --- getMatchSnapshot ----------------------------------------------------------

/**
 * A read-path-only counterpart to `getCurrentHandState` that additionally
 * derives the running per-seat match-points total (`matchPoints`) across
 * every completed hand of the match so far, alongside the same
 * `state`/`handNumber`/`lastSeq`/`prevailingWind` a caller would otherwise
 * assemble via `getCurrentHandState` + `getStartHandPayload`.
 *
 * Fetches the WHOLE game's action log in a single `listActionsForGame` call
 * (plus the same one-time `games.rules_config` read `getCurrentHandState`
 * does), groups the rows by `hand_number`, and folds each hand's rows
 * through the same `foldActionRows` used everywhere else in this module (no
 * duplicated replay logic). For every hand whose folded result reached
 * `hand-over` with `result.kind === 'win'`, that hand's `PaymentLeg[]` is
 * folded into a running `SeatTotals` via `sumPaymentLegs`; an
 * `exhaustive-draw` hand contributes no legs (no seat's total changes).
 *
 * Deliberately NOT used by `getCurrentHandState` itself or by any write-path
 * function (`submitAction`, `applyAutoPass`, `appendActionAtSeq`):
 * `getCurrentHandState` is re-invoked on every optimistic-concurrency retry
 * inside those write paths, and replaying the ENTIRE match on every retry
 * would multiply write-path cost for data (`matchPoints`) the write path
 * never uses. Callers that need match-points-aware responses (the API
 * routes) call this directly instead, as a single self-consistent snapshot
 * taken right after their own write already landed (safe: the action log is
 * append-only/monotonic, so a snapshot taken after a successful append is
 * guaranteed to include it).
 *
 * Returns null under the same condition as `getCurrentHandState`: zero
 * action rows recorded for this game yet.
 */
export async function getMatchSnapshot(
  db: Client,
  gameId: string,
): Promise<{
  state: GameState;
  handNumber: number;
  lastSeq: number;
  matchPoints: SeatTotals;
  prevailingWind: PrevailingWind;
} | null> {
  const rows = await listActionsForGame(db, gameId);
  if (rows.length === 0) {
    return null;
  }

  const gameRow = await db.execute({
    sql: 'SELECT rules_config FROM games WHERE id = ?',
    args: [gameId],
  });
  if (gameRow.rows.length === 0) {
    throw new Error(`getMatchSnapshot: no game found with id ${gameId}`);
  }
  const rules = JSON.parse(String(gameRow.rows[0].rules_config)) as RulesConfig;

  // Group by hand_number, preserving each hand's own seq-ascending row order
  // (listActionsForGame already returns rows ordered by seq ASC across the
  // whole game, which is also seq-ascending within each hand_number group).
  const rowsByHand = new Map<number, ActionLogRow[]>();
  for (const row of rows) {
    const bucket = rowsByHand.get(row.handNumber);
    if (bucket === undefined) {
      rowsByHand.set(row.handNumber, [row]);
    } else {
      bucket.push(row);
    }
  }
  const handNumbers = [...rowsByHand.keys()].sort((a, b) => a - b);

  let matchPoints: SeatTotals = [0, 0, 0, 0];
  let lastState: GameState | null = null;
  let lastHandNumber: number | null = null;
  let lastPrevailingWind: PrevailingWind | null = null;

  for (const handNumber of handNumbers) {
    const handRows = rowsByHand.get(handNumber);
    if (handRows === undefined) {
      // Unreachable: handNumbers is derived from rowsByHand's own keys.
      throw new Error(`getMatchSnapshot: internal error grouping rows for game ${gameId} hand ${handNumber}`);
    }
    const state = foldActionRows(gameId, handNumber, handRows, rules);
    lastState = state;
    lastHandNumber = handNumber;
    lastPrevailingWind = (handRows[0].payload as StartHandPayload).prevailingWind;

    if (state.phase.type === 'hand-over' && state.phase.result.kind === 'win') {
      matchPoints = sumPaymentLegs(state.phase.result.legs, matchPoints);
    }
  }

  if (lastState === null || lastHandNumber === null || lastPrevailingWind === null) {
    // Unreachable: rows.length > 0 guarantees at least one hand group above.
    throw new Error(`getMatchSnapshot: no hands found for game ${gameId} despite a non-empty action log`);
  }

  const lastSeq = rows[rows.length - 1].seq;

  return { state: lastState, handNumber: lastHandNumber, lastSeq, matchPoints, prevailingWind: lastPrevailingWind };
}

// --- applyAutoPass -------------------------------------------------------------

/**
 * For a state in the `awaiting-claims` phase, auto-passes every non-
 * discarder seat that is not already in phase.responses and has zero legal
 * options (no hu/pung/kong/chow) against the discarded tile, using the
 * engine's own capability functions.
 *
 * Uses the same atomic, re-validating pattern as `submitAction`, because
 * this function has the exact same concurrency exposure: two different
 * concurrent `submitAction` calls (e.g. one player's real claim and
 * another's real pass, both landing in the same claim window) can each
 * independently trigger their own `applyAutoPass` call, and both can
 * independently decide the SAME zero-option seat needs auto-passing. The
 * old implementation used `appendAction`'s blind seq-recompute-and-retry
 * (no re-validation against fresh state), which let both callers durably
 * append their own `pass` row for that seat — a duplicate response the
 * engine rejects on replay ('already-responded'), permanently corrupting
 * the hand's action log.
 *
 * Auto-passes are appended ONE AT A TIME: before every single
 * `appendActionAtSeq` attempt (including the very first), fresh state and
 * its matching `lastSeq` are re-derived from the DB via
 * `getCurrentHandState` — the same read `submitAction` uses to source
 * `lastSeq` — and the zero-option-and-unresponded seats are re-checked
 * against that fresh state. A locally-mutated state object is never
 * trusted across an append. If `appendActionAtSeq` reports `'seq-conflict'`
 * (another concurrent `applyAutoPass` call, or a genuine concurrent
 * `submitAction`, claimed that seq first), this loops back to a fresh
 * replay/re-check rather than blindly retrying the same payload — a seat
 * that raced against us and got a real response (or got auto-passed by the
 * other caller) is simply no longer picked next time.
 *
 * Bounded at MAX_AUTO_PASS_ATTEMPTS total append attempts across all seats
 * and retries (a single discard zero-option-bars at most 3 seats; each may
 * need a couple of retry rounds under contention). No-op if the state isn't
 * in `awaiting-claims`. Returns the final replayed `GameState` once no more
 * zero-option-unresponded seats remain, or once the phase has moved on for
 * any other reason (e.g. a concurrent real action resolved the window) —
 * paired with `lastSeq`, the seq of the last row folded into that exact
 * state, so a caller never has to re-derive it via a second, potentially
 * racy `getLatestSeq` query (see submitAction's use of this).
 */
export async function applyAutoPass(
  db: Client,
  gameId: string,
  handNumber: number,
  state: GameState,
  stateLastSeq: number,
): Promise<{ state: GameState; lastSeq: number }> {
  if (state.phase.type !== 'awaiting-claims') {
    return { state, lastSeq: stateLastSeq };
  }

  for (let attempt = 0; attempt < MAX_AUTO_PASS_ATTEMPTS; attempt++) {
    // Always re-derive fresh state (and its matching lastSeq, from the SAME
    // read) before checking/appending — even on the very first pass — since
    // a concurrent applyAutoPass call, or a genuine concurrent
    // submitAction, may have already changed the claim window since
    // `state` was captured by our caller.
    const fresh = await getCurrentHandState(db, gameId);
    if (fresh === null) {
      throw new Error(`applyAutoPass: no active hand found for game ${gameId} (expected hand ${handNumber})`);
    }
    if (fresh.handNumber !== handNumber) {
      // The hand has already advanced past the one we were auto-passing
      // for (e.g. it finished and advanceToNextHand already ran); nothing
      // left for us to do.
      return { state: fresh.state, lastSeq: fresh.lastSeq };
    }
    const { state: current, lastSeq } = fresh;

    if (current.phase.type !== 'awaiting-claims') {
      return { state: current, lastSeq };
    }
    const phase = current.phase;
    const discarderSeat = phase.discarderSeat;
    const discardedTile = phase.discardedTile;

    const zeroOptionSeat = SEATS.find((seat) => {
      if (seat === discarderSeat) return false;
      if (phase.responses[seat] !== undefined) return false;

      const hand = current.players[seat].hand;
      const hasWin = canWin(hand.concealedTiles, hand.melds.length, discardedTile);
      const hasPung = canPung(hand, discardedTile);
      const hasKong = canKongFromDiscard(hand, discardedTile);
      const hasChow = canChow(hand, discardedTile, seat, discarderSeat).length > 0;
      return !hasWin && !hasPung && !hasKong && !hasChow;
    });

    if (zeroOptionSeat === undefined) {
      return { state: current, lastSeq };
    }

    const appendResult = await appendActionAtSeq(
      db,
      gameId,
      handNumber,
      { type: 'pass', seat: zeroOptionSeat },
      lastSeq + 1,
    );
    if (appendResult === 'seq-conflict') {
      // Someone else claimed lastSeq + 1 first — loop back to a fresh
      // replay/re-check rather than retrying this same payload.
      continue;
    }
    // Successful append; loop back for a fresh replay before considering
    // the next seat.
  }

  throw new Error(
    `applyAutoPass: did not converge after ${MAX_AUTO_PASS_ATTEMPTS} attempts for game ${gameId} hand ${handNumber}`,
  );
}

// --- submitAction ----------------------------------------------------------------

/**
 * The core write path: optimistic concurrency against the current hand's
 * freshly-replayed state, re-validated and re-appended together on EVERY
 * attempt (never just the seq alone). This is the fix for the corruption bug
 * where two concurrent identical submissions (e.g. both `{type:'pass',
 * seat:1}`) could both validate against the same pre-write snapshot and both
 * get durably appended: `appendActionAtSeq` makes the append itself a single
 * precise "insert at exactly this seq, or tell me someone beat me to it"
 * attempt (no internal blind retry of a stale payload), so on a genuine
 * write race the loser re-replays state that now includes the winner's
 * write, and `applyAction` correctly re-rejects the loser (e.g.
 * 'already-responded') instead of it being durably appended a second time.
 *
 * On each attempt: replay fresh state (including `lastSeq`, from the SAME
 * read), validate `action` against it, and — only if validation succeeds —
 * attempt to append at exactly `lastSeq + 1`. A `RuleError` from validation
 * is returned immediately (no append attempt). A `'seq-conflict'` from the
 * append (someone else wrote between the replay and the insert) loops back
 * to a fresh replay/re-validate/re-append, up to MAX_SUBMIT_OUTER_RETRIES
 * times.
 */
export async function submitAction(
  db: Client,
  gameId: string,
  action: GameAction,
): Promise<{ state: GameState; handNumber: number; lastSeq: number } | RuleError> {
  for (let attempt = 0; attempt < MAX_SUBMIT_OUTER_RETRIES; attempt++) {
    const current = await getCurrentHandState(db, gameId);
    if (current === null) {
      return NO_ACTIVE_HAND_ERROR;
    }
    const { state, handNumber, lastSeq } = current;

    const result = applyAction(state, action);
    if (isRuleError(result)) {
      return result;
    }

    const appendResult = await appendActionAtSeq(db, gameId, handNumber, action, lastSeq + 1);
    if (appendResult === 'seq-conflict') {
      // Someone else wrote (and claimed lastSeq + 1) between our replay and
      // our insert attempt. Re-replay fresh state (now including their
      // write) and re-validate from scratch — never blindly retry this same
      // `result`/append pair.
      continue;
    }

    // appendActionAtSeq succeeded at lastSeq + 1; applyAutoPass re-derives
    // its own fresh state/lastSeq from there (which may advance further if
    // it appends auto-pass rows) — its returned lastSeq is the ONE correct
    // seq for the state actually being returned to the caller, never a
    // separate `getLatestSeq` call that could race against a concurrent
    // write landing between the append above and the caller reading `seq`.
    const { state: finalState, lastSeq: finalSeq } = await applyAutoPass(
      db,
      gameId,
      handNumber,
      result,
      appendResult.seq,
    );
    return { state: finalState, handNumber, lastSeq: finalSeq };
  }

  throw new Error(
    `submitAction: exhausted ${MAX_SUBMIT_OUTER_RETRIES} outer retries (repeated seq conflicts) for game ${gameId}`,
  );
}

// --- advanceToNextHand -------------------------------------------------------------

type PrevailingWind = StartHandPayload['prevailingWind'];

/**
 * The prevailing-wind progression, indexed by the number of "dealer
 * completes a full rotation back to seat 0" events that have occurred so
 * far (0 = the game's very first hand, before any rotation completes).
 * Per RULES.md §2: a full game (一將) is 4 wind rounds, E → S → W → N, each
 * lasting exactly 1 rotation; a 4th rotation-completion has nowhere left to
 * go and ends the game.
 */
const WIND_PROGRESSION: readonly PrevailingWind[] = ['east', 'south', 'west', 'north'];

async function fetchStartHandPayloads(
  db: Client,
  gameId: string,
  throughHandNumber: number,
): Promise<StartHandPayload[]> {
  const result = await db.execute({
    sql: `SELECT payload FROM actions
          WHERE game_id = ? AND action_type = 'start-hand' AND hand_number <= ?
          ORDER BY hand_number ASC`,
    args: [gameId, throughHandNumber],
  });
  return result.rows.map((row) => JSON.parse(String(row.payload)) as StartHandPayload);
}

/**
 * Counts how many "dealer completes a full rotation back to seat 0" events
 * have occurred among hands 1..throughHandNumber (inclusive), by comparing
 * each hand's own dealerSeat against the previous hand's.
 */
async function countWindTransitions(db: Client, gameId: string, throughHandNumber: number): Promise<number> {
  const payloads = await fetchStartHandPayloads(db, gameId, throughHandNumber);
  let transitions = 0;
  for (let i = 1; i < payloads.length; i++) {
    const prev = payloads[i - 1];
    const curr = payloads[i];
    if (curr.dealerSeat !== prev.dealerSeat && curr.dealerSeat === 0) {
      transitions++;
    }
  }
  return transitions;
}

export type AdvanceToNextHandResult =
  | { readonly state: GameState; readonly handNumber: number; readonly lastSeq: number }
  | { readonly error: 'hand-not-over' | 'game-finished' };

/**
 * Advances a finished hand to the next one: derives the next dealer/repeat
 * from the just-finished hand's HandResult, advances the prevailing wind
 * whenever the dealer completes a full rotation back to seat 0, and ends the
 * game (flipping games.status to 'finished') once the wind table is
 * exhausted past 'north'. A next-hand start-hand row that already exists
 * (e.g. from a racing caller) is treated as a no-op success rather than
 * re-appended.
 */
export async function advanceToNextHand(db: Client, gameId: string): Promise<AdvanceToNextHandResult> {
  const current = await getCurrentHandState(db, gameId);
  if (current === null) {
    throw new Error(`advanceToNextHand: no hand exists yet for game ${gameId}`);
  }
  const { state, handNumber } = current;

  if (state.phase.type !== 'hand-over') {
    return { error: 'hand-not-over' };
  }

  const { nextDealerSeat, nextRepeatCount } = state.phase.result;

  const handRows = await listActionsForHand(db, gameId, handNumber);
  const startPayload = handRows[0].payload as StartHandPayload;
  const currentDealerSeat = startPayload.dealerSeat;
  const currentWind = startPayload.prevailingWind;

  const dealerRotated = nextDealerSeat !== currentDealerSeat && nextDealerSeat === 0;

  let nextWind: PrevailingWind = currentWind;
  if (dealerRotated) {
    const priorTransitions = await countWindTransitions(db, gameId, handNumber);
    const newTransitionIndex = priorTransitions + 1;
    if (newTransitionIndex >= WIND_PROGRESSION.length) {
      await db.execute({
        sql: `UPDATE games SET status = 'finished', updated_at = ? WHERE id = ?`,
        args: [Date.now(), gameId],
      });
      return { error: 'game-finished' };
    }
    nextWind = WIND_PROGRESSION[newTransitionIndex];
  }

  const nextHandNumber = handNumber + 1;

  // appendStartHand itself is the no-op-on-race guard here (see its own
  // doc comment): it atomically no-ops (returning the existing row's seq)
  // rather than inserting a duplicate if a racing caller already created
  // this hand's start-hand row. A separate "check via SELECT, then insert"
  // pre-check here would NOT be race-safe (two callers could both pass the
  // check before either commits), so this always calls appendStartHand and
  // lets it resolve to whichever caller's payload actually won.
  await appendStartHand(db, gameId, {
    handNumber: nextHandNumber,
    dealerSeat: nextDealerSeat as Seat,
    seed: randomInt(0, 2 ** 31),
    repeatCount: nextRepeatCount,
    prevailingWind: nextWind,
  });

  // Re-derive via getCurrentHandState (not a direct replayHand call) so the
  // returned lastSeq comes from the exact same read as nextState — never a
  // separate getLatestSeq query that could race against a concurrent write
  // landing between the append above and this read.
  const next = await getCurrentHandState(db, gameId);
  if (next === null || next.handNumber !== nextHandNumber) {
    throw new Error(
      `advanceToNextHand: expected hand ${nextHandNumber} to be current for game ${gameId} after appendStartHand`,
    );
  }
  return { state: next.state, handNumber: next.handNumber, lastSeq: next.lastSeq };
}
