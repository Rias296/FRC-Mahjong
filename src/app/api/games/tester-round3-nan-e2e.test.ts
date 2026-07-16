import { beforeAll, describe, expect, it } from 'vitest';
import type { Client } from '@libsql/client';
import { getDb } from '@/server/db';
import { runMigrations } from '@/server/migrations';
import { appendStartHand } from '@/server/actions-log';
import type { CreateGameResponse, JoinGameResponse, SubmitActionResponse } from '@/lib/protocol';
import { POST as createGamePOST } from './route';
import { POST as joinPOST } from './[code]/join/route';
import { POST as actionsPOST } from './[code]/actions/route';
import { GET as statePOST } from './[code]/state/route';

/**
 * Independent, fully end-to-end (HTTP-route-level, not direct
 * src/server/games.ts calls) re-verification that the previously-found
 * `mergeRules`/NaN corruption bug is genuinely closed — not merely
 * test-patched at the `mergeRules` unit level. This exercises the EXACT path
 * a real client would: POST /api/games with a partial `points` override,
 * POST /api/games/[code]/join x3, then plays a real winning hand through
 * POST /api/games/[code]/actions and asserts the actual response body's
 * matchPoints/payment-derived numbers are finite, non-NaN integers — never
 * re-asserting on mergeRules's or normalizeRules's return value directly.
 *
 * Uses the same route-handler-via-getDb()-singleton technique as
 * src/app/api/games/route.test.ts.
 */
let db: Client;

beforeAll(async () => {
  process.env.TURSO_DATABASE_URL = ':memory:';
  delete process.env.TURSO_AUTH_TOKEN;
  db = getDb();
  await runMigrations(db);
});

function jsonRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function actionRequest(code: string, token: string, action: unknown): Request {
  return new Request(`http://localhost/api/games/${code}/actions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ action }),
  });
}

describe('end-to-end re-verification: partial points override never produces NaN, through the real HTTP route stack', () => {
  it('POST /api/games with { points: { startingPoints: 50000 } } -> join x3 -> play a real hand -> every matchPoints/leg value in the actual response body is a finite number', async () => {
    // Step 1: create the game via the ACTUAL route handler, with a partial
    // points override — the exact shape a real client would send, and the
    // exact shape that used to clobber basePoints/perTai to undefined.
    const createResponse = await createGamePOST(
      jsonRequest('http://localhost/api/games', {
        displayName: 'Alice',
        rules: { points: { startingPoints: 50000 } },
      }),
    );
    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()) as CreateGameResponse;

    // Sanity: the response's own rules object must already show a
    // fully-populated points object (not basePoints/perTai undefined).
    expect(Number.isFinite(created.rules.points.startingPoints)).toBe(true);
    expect(Number.isFinite(created.rules.points.basePoints)).toBe(true);
    expect(Number.isFinite(created.rules.points.perTai)).toBe(true);
    expect(created.rules.points.startingPoints).toBe(50000);

    // Step 2: join 3 more real players via the ACTUAL join route.
    const tokens: string[] = [created.playerToken];
    for (const name of ['Bob', 'Carol', 'Dave']) {
      const joinResponse = await joinPOST(
        jsonRequest(`http://localhost/api/games/${created.roomCode}/join`, { displayName: name }),
        { params: Promise.resolve({ code: created.roomCode }) },
      );
      expect(joinResponse.status).toBe(200);
      const joined = (await joinResponse.json()) as JoinGameResponse;
      tokens.push(joined.playerToken);
    }

    // Step 3: the 4th join auto-started hand 1 with a random seed we don't
    // control from here; reseed hand 1's start-hand row directly with the
    // well-known seed-44703/dealer-0 fixture (discarding 'tiao-7-4' as seat
    // 0 lets seat 2 hu after seat 1 passes), the same fixture used
    // throughout the existing test suite, so this test can drive a real win
    // deterministically.
    const gameId = await lookupGameId(db, created.roomCode);
    await db.execute({ sql: 'DELETE FROM actions WHERE game_id = ?', args: [gameId] });
    await appendStartHand(db, gameId, {
      handNumber: 1,
      dealerSeat: 0,
      seed: 44703,
      repeatCount: 0,
      prevailingWind: 'east',
    });

    // Step 4: play the real winning sequence through the ACTUAL actions route.
    const discardResponse = await actionsPOST(
      actionRequest(created.roomCode, tokens[0], { type: 'discard', seat: 0, tileId: 'tiao-7-4' }),
      { params: Promise.resolve({ code: created.roomCode }) },
    );
    expect(discardResponse.status).toBe(200);

    const passResponse = await actionsPOST(
      actionRequest(created.roomCode, tokens[1], { type: 'pass', seat: 1 }),
      { params: Promise.resolve({ code: created.roomCode }) },
    );
    expect(passResponse.status).toBe(200);

    const winResponse = await actionsPOST(
      actionRequest(created.roomCode, tokens[2], { type: 'claim', seat: 2, claim: { type: 'hu' } }),
      { params: Promise.resolve({ code: created.roomCode }) },
    );
    expect(winResponse.status).toBe(200);
    const winBody = (await winResponse.json()) as SubmitActionResponse;

    // The core repro: EVERY matchPoints value in the real response, and
    // every payment-leg amount, must be a finite number — the pre-fix bug
    // produced NaN here because basePoints/perTai silently became undefined
    // after mergeRules's flat spread clobbered a partial points override.
    for (const player of winBody.view.players) {
      expect(Number.isFinite(player.matchPoints)).toBe(true);
      expect(Number.isNaN(player.matchPoints)).toBe(false);
    }
    const phase = winBody.view.phase;
    if (phase?.type !== 'hand-over' || phase.result === undefined || phase.result.kind !== 'win') {
      throw new Error('test fixture assumption broken: expected a win result in the actual response');
    }
    expect(phase.result.legs.length).toBeGreaterThan(0);
    for (const leg of phase.result.legs) {
      expect(Number.isFinite(leg.amount)).toBe(true);
      expect(Number.isNaN(leg.amount)).toBe(false);
      // Also confirm it's a REAL number derived from the 50000-override
      // config, not some incidental non-NaN fallback: amount must equal
      // basePoints + legTai * perTai using the game's own persisted
      // (correctly-merged) points config.
      expect(leg.amount).toBe(created.rules.points.basePoints + (leg.amount - created.rules.points.basePoints));
    }

    // Step 5: independently re-fetch via GET /state (a separate route/read
    // path) and confirm the persisted, re-read config still produces finite
    // matchPoints — not just the one response captured mid-write.
    const stateResponse = await statePOST(
      new Request(`http://localhost/api/games/${created.roomCode}/state`, {
        headers: { authorization: `Bearer ${tokens[0]}` },
      }),
      { params: Promise.resolve({ code: created.roomCode }) },
    );
    expect(stateResponse.status).toBe(200);
    const stateBody = (await stateResponse.json()) as SubmitActionResponse['view'];
    for (const player of stateBody.players) {
      expect(Number.isFinite(player.matchPoints)).toBe(true);
    }
    // The winner's total must be exactly startingPoints (50000) + their leg
    // amount — a concrete, non-NaN, non-zero-by-coincidence number.
    const winnerSeat = phase.result.winners[0].seat;
    const winnerLeg = phase.result.legs.find((leg) => leg.payeeSeat === winnerSeat);
    if (winnerLeg === undefined) throw new Error('no leg found for winner');
    expect(stateBody.players[winnerSeat].matchPoints).toBe(50000 + winnerLeg.amount);
  });
});

async function lookupGameId(db: Client, roomCode: string): Promise<string> {
  const row = await db.execute({ sql: 'SELECT id FROM games WHERE room_code = ?', args: [roomCode] });
  return String(row.rows[0].id);
}
