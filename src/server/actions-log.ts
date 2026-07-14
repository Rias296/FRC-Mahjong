/**
 * Append-only event log for a game's actions table: the source of truth that
 * replay.ts folds through the engine to reconstruct GameState. See
 * migrations/0001_init.sql for the `actions` table shape.
 */

import { LibsqlError, type Client, type Row } from '@libsql/client';
import type { GameAction } from '../engine/game-state';
import type { Seat } from '../engine/seats';

export interface StartHandPayload {
  readonly handNumber: number;
  readonly dealerSeat: Seat;
  readonly seed: number;
  readonly repeatCount: number;
  readonly prevailingWind: 'east' | 'south' | 'west' | 'north';
}

export interface ActionLogRow {
  readonly seq: number;
  readonly handNumber: number;
  readonly actorSeat: Seat | null;
  readonly actionType: 'start-hand' | GameAction['type'];
  readonly payload: StartHandPayload | GameAction;
  readonly createdAt: number;
}

const MAX_SEQ_RETRY_ATTEMPTS = 5;

/**
 * True for a UNIQUE-constraint violation (e.g. the UNIQUE(game_id, seq) race
 * this module retries around). Checked via LibsqlError's machine-readable
 * `code` first, falling back to a message match for drivers/backends that
 * don't populate `code` consistently.
 */
function isUniqueConstraintError(err: unknown): boolean {
  if (err instanceof LibsqlError) {
    return err.code.startsWith('SQLITE_CONSTRAINT');
  }
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
}

async function nextSeqFor(db: Client, gameId: string): Promise<number> {
  const result = await db.execute({
    sql: 'SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM actions WHERE game_id = ?',
    args: [gameId],
  });
  return Number(result.rows[0].next_seq);
}

async function existingStartHandSeq(db: Client, gameId: string, handNumber: number): Promise<number | null> {
  const result = await db.execute({
    sql: `SELECT seq FROM actions WHERE game_id = ? AND hand_number = ? AND action_type = 'start-hand'`,
    args: [gameId, handNumber],
  });
  return result.rows.length === 0 ? null : Number(result.rows[0].seq);
}

/**
 * Appends a `start-hand` event, computing the next seq as `MAX(seq)+1` for
 * the game. The insert is guarded by a `WHERE NOT EXISTS` clause scoped to
 * `(game_id, hand_number, action_type = 'start-hand')`, evaluated as part of
 * the same atomic INSERT..SELECT statement: this is what actually closes the
 * race two concurrent callers can hit advancing the same game to the same
 * next hand (a plain "check via SELECT, then INSERT" from two separate
 * round-trips is NOT atomic and can't prevent both callers from inserting a
 * second, corrupting start-hand row for one hand — see replay.test.ts's
 * concurrent advanceToNextHand coverage). If the insert affects 0 rows, a
 * start-hand row for this hand already exists (created by a concurrent
 * writer); this is treated as a no-op success, returning that row's seq
 * rather than inserting a duplicate. Also retries (bounded) on a genuine
 * UNIQUE(game_id, seq) collision from a concurrent writer picking the same
 * seq, recomputing the seq each attempt.
 */
export async function appendStartHand(
  db: Client,
  gameId: string,
  payload: StartHandPayload,
): Promise<{ seq: number }> {
  let lastError: unknown = null;

  for (let attempt = 0; attempt < MAX_SEQ_RETRY_ATTEMPTS; attempt++) {
    const seq = await nextSeqFor(db, gameId);
    try {
      const result = await db.execute({
        sql: `INSERT INTO actions (game_id, hand_number, seq, actor_seat, action_type, payload, created_at)
              SELECT ?, ?, ?, NULL, 'start-hand', ?, ?
              WHERE NOT EXISTS (
                SELECT 1 FROM actions WHERE game_id = ? AND hand_number = ? AND action_type = 'start-hand'
              )`,
        args: [gameId, payload.handNumber, seq, JSON.stringify(payload), Date.now(), gameId, payload.handNumber],
      });
      if (result.rowsAffected === 0) {
        const existingSeq = await existingStartHandSeq(db, gameId, payload.handNumber);
        if (existingSeq === null) {
          // Shouldn't happen (the NOT EXISTS guard and this lookup would
          // disagree only under an engine-level inconsistency), but don't
          // silently fabricate a seq.
          throw new Error(
            `appendStartHand: insert reported 0 rows affected for game ${gameId} hand ${payload.handNumber}, ` +
              `but no existing start-hand row was found`,
          );
        }
        return { seq: existingSeq };
      }
      return { seq };
    } catch (err) {
      lastError = err;
      if (!isUniqueConstraintError(err)) throw err;
      // Another writer landed at this seq first; recompute and retry.
    }
  }

  throw new Error(
    `appendStartHand: exhausted ${MAX_SEQ_RETRY_ATTEMPTS} seq-retry attempts for game ${gameId}: ${String(lastError)}`,
  );
}

/**
 * Appends a player action event, computing the next seq as `MAX(seq)+1` for
 * the game. Retries (bounded) on a UNIQUE(game_id, seq) collision from a
 * concurrent writer, recomputing the seq each attempt.
 *
 * UNSAFE FOR CONCURRENT PRODUCTION USE: on a seq collision this blindly
 * re-inserts the same already-decided payload without re-validating it
 * against fresh state, which can persist two semantically-conflicting rows
 * (this was the root cause of a real corruption bug in `submitAction` /
 * `applyAutoPass`, since fixed). Do NOT call this from any request-handling
 * path — use `appendActionAtSeq` there, paired with a fresh re-replay and
 * re-validation on every retry attempt (see replay.ts's `submitAction` /
 * `applyAutoPass`). Retained only for this module's own unit tests, which
 * exercise this primitive's low-level insert/retry behavior directly.
 */
export async function appendAction(
  db: Client,
  gameId: string,
  handNumber: number,
  action: GameAction,
): Promise<{ seq: number }> {
  let lastError: unknown = null;

  for (let attempt = 0; attempt < MAX_SEQ_RETRY_ATTEMPTS; attempt++) {
    const seq = await nextSeqFor(db, gameId);
    try {
      await db.execute({
        sql: `INSERT INTO actions (game_id, hand_number, seq, actor_seat, action_type, payload, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [gameId, handNumber, seq, action.seat, action.type, JSON.stringify(action), Date.now()],
      });
      return { seq };
    } catch (err) {
      lastError = err;
      if (!isUniqueConstraintError(err)) throw err;
      // Another writer landed at this seq first; recompute and retry.
    }
  }

  throw new Error(
    `appendAction: exhausted ${MAX_SEQ_RETRY_ATTEMPTS} seq-retry attempts for game ${gameId}: ${String(lastError)}`,
  );
}

export type AppendActionAtSeqResult = { readonly seq: number } | 'seq-conflict';

/**
 * Appends a player action event at an EXACT caller-supplied seq — a single,
 * precise insert attempt, with no internal "recompute seq and blindly retry
 * the same payload" behavior. This is the atomic primitive submitAction's
 * retry loop is built on: it either lands the row at exactly
 * `expectedNextSeq`, or (on a UNIQUE(game_id, seq) collision, meaning another
 * writer claimed that seq first) returns the string `'seq-conflict'` instead
 * of retrying itself. All retry/re-validation logic lives in the caller
 * (submitAction), which re-replays fresh state and re-validates the action's
 * semantic legality before trying again — unlike `appendAction` below, whose
 * own retry recomputes `seq` and reinserts the SAME (potentially now-stale/
 * invalid) payload without any re-validation.
 */
export async function appendActionAtSeq(
  db: Client,
  gameId: string,
  handNumber: number,
  action: GameAction,
  expectedNextSeq: number,
): Promise<AppendActionAtSeqResult> {
  try {
    await db.execute({
      sql: `INSERT INTO actions (game_id, hand_number, seq, actor_seat, action_type, payload, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [gameId, handNumber, expectedNextSeq, action.seat, action.type, JSON.stringify(action), Date.now()],
    });
    return { seq: expectedNextSeq };
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      return 'seq-conflict';
    }
    throw err;
  }
}

function rowToActionLogRow(row: Row): ActionLogRow {
  return {
    seq: Number(row.seq),
    handNumber: Number(row.hand_number),
    actorSeat: row.actor_seat === null ? null : (Number(row.actor_seat) as Seat),
    actionType: String(row.action_type) as ActionLogRow['actionType'],
    payload: JSON.parse(String(row.payload)) as StartHandPayload | GameAction,
    createdAt: Number(row.created_at),
  };
}

/** All action-log rows for a game, ordered by seq ascending. */
export async function listActionsForGame(db: Client, gameId: string): Promise<ActionLogRow[]> {
  const result = await db.execute({
    sql: `SELECT seq, hand_number, actor_seat, action_type, payload, created_at
          FROM actions WHERE game_id = ? ORDER BY seq ASC`,
    args: [gameId],
  });
  return result.rows.map(rowToActionLogRow);
}

/** All action-log rows for one hand of a game, ordered by seq ascending. */
export async function listActionsForHand(
  db: Client,
  gameId: string,
  handNumber: number,
): Promise<ActionLogRow[]> {
  const result = await db.execute({
    sql: `SELECT seq, hand_number, actor_seat, action_type, payload, created_at
          FROM actions WHERE game_id = ? AND hand_number = ? ORDER BY seq ASC`,
    args: [gameId, handNumber],
  });
  return result.rows.map(rowToActionLogRow);
}

/** The highest seq recorded for a game (0 if none), for use as an SSE cursor. */
export async function getLatestSeq(db: Client, gameId: string): Promise<number> {
  const result = await db.execute({
    sql: 'SELECT COALESCE(MAX(seq), 0) AS latest_seq FROM actions WHERE game_id = ?',
    args: [gameId],
  });
  return Number(result.rows[0].latest_seq);
}

/**
 * A single hand's own start-hand payload, via an indexed targeted lookup
 * (`hand_number` + `action_type = 'start-hand'`) rather than fetching and
 * JSON-parsing the whole hand's action log just to read its first row. Used
 * by routes that only need e.g. `prevailingWind` off a hand that's already
 * been (or is about to be) fully replayed elsewhere in the same request.
 */
export async function getStartHandPayload(
  db: Client,
  gameId: string,
  handNumber: number,
): Promise<StartHandPayload> {
  const result = await db.execute({
    sql: `SELECT payload FROM actions
          WHERE game_id = ? AND hand_number = ? AND action_type = 'start-hand'`,
    args: [gameId, handNumber],
  });
  if (result.rows.length === 0) {
    throw new Error(`getStartHandPayload: no start-hand row for game ${gameId} hand ${handNumber}`);
  }
  return JSON.parse(String(result.rows[0].payload)) as StartHandPayload;
}
