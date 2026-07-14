/**
 * Game/player repository: room creation, joining, and the token-based auth
 * lookup. Composes with actions-log.ts exactly once, to append the hand-1
 * start-hand event the moment the 4th player joins (see
 * resolveInitialGameStart below).
 */

import { LibsqlError, type Client } from '@libsql/client';
import { randomBytes, randomInt } from 'node:crypto';
import { DEFAULT_RULES, type RulesConfig } from '../engine/rules-config';
import type { Seat } from '../engine/seats';
import { appendStartHand } from './actions-log';

/**
 * Bumped manually whenever the persisted GameState/GameAction shape changes
 * in a replay-relevant way. Not read from package.json's `version` field,
 * since that tracks the whole app's release version, not the engine's
 * replay-compatibility surface specifically.
 */
const ENGINE_VERSION = '0.1.0';

// Excludes 0/O/1/I/L to avoid visually-ambiguous room codes.
const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const ROOM_CODE_LENGTH = 6;
const MAX_ROOM_CODE_ATTEMPTS = 5;

/**
 * True for a UNIQUE-constraint violation (e.g. a room_code collision).
 * Checked via LibsqlError's machine-readable `code` first, falling back to a
 * message match for drivers/backends that don't populate `code` consistently.
 */
function isUniqueConstraintError(err: unknown): boolean {
  if (err instanceof LibsqlError) {
    return err.code.startsWith('SQLITE_CONSTRAINT');
  }
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
}

function generateRoomCode(): string {
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    code += ROOM_CODE_ALPHABET[randomInt(0, ROOM_CODE_ALPHABET.length)];
  }
  return code;
}

function mergeRules(overrides?: Partial<RulesConfig>): RulesConfig {
  if (!overrides) return DEFAULT_RULES;
  return {
    ...DEFAULT_RULES,
    ...overrides,
    robKong: { ...DEFAULT_RULES.robKong, ...overrides.robKong },
    sacredDiscard: { ...DEFAULT_RULES.sacredDiscard, ...overrides.sacredDiscard },
  };
}

export interface CreateGameResult {
  readonly roomCode: string;
  readonly gameId: string;
  readonly seat: 0;
  readonly playerToken: string;
  readonly rules: RulesConfig;
}

/**
 * Creates a game (status `waiting-for-players`) and seats the creator at
 * seat 0. Retries room-code generation (bounded) on a UNIQUE collision.
 */
export async function createGame(
  db: Client,
  params: { displayName: string; rules?: Partial<RulesConfig> },
): Promise<CreateGameResult> {
  const rules = mergeRules(params.rules);
  const gameId = randomBytes(16).toString('hex');
  const playerId = randomBytes(16).toString('hex');
  const playerToken = randomBytes(32).toString('base64url');
  const now = Date.now();

  let lastError: unknown = null;

  for (let attempt = 0; attempt < MAX_ROOM_CODE_ATTEMPTS; attempt++) {
    const roomCode = generateRoomCode();
    try {
      await db.batch(
        [
          {
            sql: `INSERT INTO games (id, room_code, status, rules_config, engine_version, created_at, updated_at)
                  VALUES (?, ?, 'waiting-for-players', ?, ?, ?, ?)`,
            args: [gameId, roomCode, JSON.stringify(rules), ENGINE_VERSION, now, now],
          },
          {
            sql: `INSERT INTO players (id, game_id, seat, display_name, join_token, created_at)
                  VALUES (?, ?, 0, ?, ?, ?)`,
            args: [playerId, gameId, params.displayName, playerToken, now],
          },
        ],
        'write',
      );
      return { roomCode, gameId, seat: 0, playerToken, rules };
    } catch (err) {
      lastError = err;
      if (!isUniqueConstraintError(err)) throw err;
      // room_code collision; retry with a freshly generated code.
    }
  }

  throw new Error(
    `createGame: exhausted ${MAX_ROOM_CODE_ATTEMPTS} room-code attempts: ${String(lastError)}`,
  );
}

export type JoinGameResult =
  | { readonly seat: Seat; readonly gameId: string; readonly playerToken: string; readonly rules: RulesConfig; readonly status: string }
  | { readonly error: 'not-found' | 'game-full' | 'already-started' };

const MAX_JOIN_SEAT_ATTEMPTS = 5;

/**
 * Once this join fills the 4th seat, flips the game to `in-progress` and
 * appends the hand-1 start-hand event (dealer seat 0, repeatCount 0, a fresh
 * crypto-random seed, prevailing wind 'east') at seq 1.
 */
async function resolveInitialGameStart(db: Client, gameId: string): Promise<void> {
  const now = Date.now();
  await db.execute({
    sql: `UPDATE games SET status = 'in-progress', updated_at = ? WHERE id = ?`,
    args: [now, gameId],
  });
  await appendStartHand(db, gameId, {
    handNumber: 1,
    dealerSeat: 0,
    seed: randomInt(0, 2 ** 31),
    repeatCount: 0,
    prevailingWind: 'east',
  });
}

/**
 * Assigns the caller the lowest free seat and joins them to `roomCode`.
 *
 * Uses the same read-validate-write-with-fresh-retry pattern as
 * `submitAction`/`applyAutoPass` in replay.ts, because this has the exact
 * same concurrency exposure: the old implementation read `occupiedSeats`
 * once via a SELECT, deterministically computed the lowest free seat from
 * that single snapshot, and INSERTed — with no retry on a UNIQUE(game_id,
 * seat) collision, just an immediate `'game-full'`. Two truly concurrent
 * joiners who both read the same pre-write snapshot independently compute
 * the SAME candidate seat; only one INSERT can win, and the old code told
 * every loser the game was full even when a different seat was genuinely
 * still open.
 *
 * On each attempt: re-fetch the game's CURRENT status and occupied seats
 * fresh (never reused from a prior iteration), decide `game-full`/pick a
 * seat from THAT read, and attempt the INSERT for that seat. A UNIQUE
 * collision (someone else took that exact seat between our read and our
 * write) loops back to a fresh read/re-decide rather than reporting
 * `game-full` — only a fresh read showing all 4 seats occupied does that.
 * Any other INSERT failure propagates. Exhausting the bounded attempt count
 * (a pathological, sustained collision storm — would need 5+ simultaneous
 * joiners repeatedly colliding on one seat) throws rather than silently
 * misreporting the game's state.
 */
export async function joinGame(
  db: Client,
  roomCode: string,
  params: { displayName: string },
): Promise<JoinGameResult> {
  const gameRow = await db.execute({
    sql: 'SELECT id, rules_config FROM games WHERE room_code = ?',
    args: [roomCode],
  });
  if (gameRow.rows.length === 0) {
    return { error: 'not-found' };
  }

  const gameId = String(gameRow.rows[0].id);
  const rules = JSON.parse(String(gameRow.rows[0].rules_config)) as RulesConfig;

  const playerId = randomBytes(16).toString('hex');
  const playerToken = randomBytes(32).toString('base64url');

  for (let attempt = 0; attempt < MAX_JOIN_SEAT_ATTEMPTS; attempt++) {
    // Fresh status read every attempt: a concurrent join filling the 4th
    // seat (which flips status to 'in-progress') could have happened since
    // our last iteration.
    const statusRow = await db.execute({
      sql: 'SELECT status FROM games WHERE id = ?',
      args: [gameId],
    });
    if (statusRow.rows.length === 0) {
      return { error: 'not-found' };
    }
    const status = String(statusRow.rows[0].status);
    if (status !== 'waiting-for-players') {
      return { error: 'already-started' };
    }

    // Fresh occupied-seats read every attempt — never reused from a prior
    // iteration — so `game-full` is only ever derived from up-to-date data.
    const seatsRow = await db.execute({
      sql: 'SELECT seat FROM players WHERE game_id = ?',
      args: [gameId],
    });
    const occupiedSeats = new Set(seatsRow.rows.map((r) => Number(r.seat)));

    if (occupiedSeats.size >= 4) {
      return { error: 'game-full' };
    }

    let seat: Seat | null = null;
    for (const candidate of [0, 1, 2, 3] as const) {
      if (!occupiedSeats.has(candidate)) {
        seat = candidate;
        break;
      }
    }
    if (seat === null) {
      return { error: 'game-full' };
    }

    const now = Date.now();

    try {
      await db.execute({
        sql: `INSERT INTO players (id, game_id, seat, display_name, join_token, created_at)
              VALUES (?, ?, ?, ?, ?, ?)`,
        args: [playerId, gameId, seat, params.displayName, playerToken, now],
      });
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        // The seat we picked was taken concurrently between our SELECT and
        // our INSERT. This does NOT mean the game is full — loop back to a
        // fresh read and re-decide, rather than reporting 'game-full'.
        continue;
      }
      throw err;
    }

    const fillsFourthSeat = occupiedSeats.size + 1 === 4;
    if (fillsFourthSeat) {
      await resolveInitialGameStart(db, gameId);
    }

    return {
      seat,
      gameId,
      playerToken,
      rules,
      status: fillsFourthSeat ? 'in-progress' : status,
    };
  }

  throw new Error(
    `joinGame: exhausted ${MAX_JOIN_SEAT_ATTEMPTS} seat-assignment attempts due to sustained concurrent ` +
      `seat collisions for game ${gameId}`,
  );
}

export async function getGameByRoomCode(
  db: Client,
  roomCode: string,
): Promise<{ gameId: string; status: string; rules: RulesConfig; roomCode: string } | null> {
  const result = await db.execute({
    sql: 'SELECT id, status, rules_config FROM games WHERE room_code = ?',
    args: [roomCode],
  });
  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  return {
    gameId: String(row.id),
    status: String(row.status),
    rules: JSON.parse(String(row.rules_config)) as RulesConfig,
    roomCode,
  };
}

/** The auth lookup: resolves a player's join_token to their game/seat. */
export async function resolvePlayerToken(
  db: Client,
  token: string,
): Promise<{ gameId: string; seat: Seat } | null> {
  const result = await db.execute({
    sql: 'SELECT game_id, seat FROM players WHERE join_token = ?',
    args: [token],
  });
  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  return { gameId: String(row.game_id), seat: Number(row.seat) as Seat };
}

export async function listPlayers(
  db: Client,
  gameId: string,
): Promise<Array<{ seat: Seat; displayName: string }>> {
  const result = await db.execute({
    sql: 'SELECT seat, display_name FROM players WHERE game_id = ? ORDER BY seat ASC',
    args: [gameId],
  });
  return result.rows.map((row) => ({
    seat: Number(row.seat) as Seat,
    displayName: String(row.display_name),
  }));
}
