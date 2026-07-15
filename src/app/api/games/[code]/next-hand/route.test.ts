import { beforeAll, describe, expect, it } from 'vitest';
import type { Client } from '@libsql/client';
import { getDb } from '@/server/db';
import { runMigrations } from '@/server/migrations';
import { createGame, joinGame } from '@/server/games';
import { appendStartHand } from '@/server/actions-log';
import { submitAction } from '@/server/replay';
import type { GameState, RuleError } from '@/engine/game-state';
import type { ClientGameView } from '@/lib/protocol';
import type { RulesConfig } from '@/engine/rules-config';
import { POST } from './route';

function isSubmitRuleError(
  r: { readonly state: GameState; readonly handNumber: number } | RuleError,
): r is RuleError {
  return 'type' in r && r.type === 'rule-error';
}

/** See src/app/api/games/route.test.ts for why this singleton-routing setup is safe/isolated. */
let db: Client;

beforeAll(async () => {
  process.env.TURSO_DATABASE_URL = ':memory:';
  delete process.env.TURSO_AUTH_TOKEN;
  db = getDb();
  await runMigrations(db);
});

function authedRequest(code: string, token: string | null): Request {
  const headers: Record<string, string> = {};
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return new Request(`http://localhost/api/games/${code}/next-hand`, { method: 'POST', headers });
}

function callNextHand(code: string, token: string | null): Promise<Response> {
  return POST(authedRequest(code, token), { params: Promise.resolve({ code }) });
}

async function fullyJoinedGame(rulesOverride?: Partial<RulesConfig>): Promise<{
  gameId: string;
  roomCode: string;
  tokens: readonly [string, string, string, string];
}> {
  const created = await createGame(db, { displayName: 'Alice', rules: rulesOverride });
  const j2 = await joinGame(db, created.roomCode, { displayName: 'Bob' });
  const j3 = await joinGame(db, created.roomCode, { displayName: 'Carol' });
  const j4 = await joinGame(db, created.roomCode, { displayName: 'Dave' });
  if ('error' in j2 || 'error' in j3 || 'error' in j4) {
    throw new Error('unexpected join error setting up fixture');
  }
  return {
    gameId: created.gameId,
    roomCode: created.roomCode,
    tokens: [created.playerToken, j2.playerToken, j3.playerToken, j4.playerToken],
  };
}

function callNextHandRawAuth(code: string, authHeaderValue: string | undefined): Promise<Response> {
  const headers: Record<string, string> = {};
  if (authHeaderValue !== undefined) headers.authorization = authHeaderValue;
  const request = new Request(`http://localhost/api/games/${code}/next-hand`, { method: 'POST', headers });
  return POST(request, { params: Promise.resolve({ code }) });
}

describe('POST /api/games/[code]/next-hand', () => {
  it('returns 401 with no Authorization header', async () => {
    const created = await createGame(db, { displayName: 'Alice' });
    const response = await callNextHand(created.roomCode, null);
    expect(response.status).toBe(401);
  });

  it('returns 401 for an unknown token', async () => {
    const created = await createGame(db, { displayName: 'Alice' });
    const response = await callNextHand(created.roomCode, 'bogus');
    expect(response.status).toBe(401);
  });

  it('returns 401 when the token belongs to a DIFFERENT game than the room code addresses', async () => {
    const gameA = await createGame(db, { displayName: 'Alice' });
    const gameB = await createGame(db, { displayName: 'Zed' });
    const response = await callNextHand(gameB.roomCode, gameA.playerToken);
    expect(response.status).toBe(401);
  });

  it('returns 401 for a non-Bearer auth scheme ("Basic ...")', async () => {
    const created = await createGame(db, { displayName: 'Alice' });
    const response = await callNextHandRawAuth(created.roomCode, `Basic ${created.playerToken}`);
    expect(response.status).toBe(401);
  });

  it('returns 401 for "Bearer" with no token at all', async () => {
    const created = await createGame(db, { displayName: 'Alice' });
    const response = await callNextHandRawAuth(created.roomCode, 'Bearer');
    expect(response.status).toBe(401);
  });

  it('returns 401 for an empty-string Authorization header', async () => {
    const created = await createGame(db, { displayName: 'Alice' });
    const response = await callNextHandRawAuth(created.roomCode, '');
    expect(response.status).toBe(401);
  });

  it('returns 404 for an unknown room code', async () => {
    const created = await createGame(db, { displayName: 'Alice' });
    const response = await callNextHand('ZZZZZZ', created.playerToken);
    expect(response.status).toBe(404);
  });

  it('returns 409 hand-not-over while the current hand is still active', async () => {
    const { roomCode, tokens } = await fullyJoinedGame();
    const response = await callNextHand(roomCode, tokens[0]);
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe('hand-not-over');
  });

  it('regression: returns a clean 500 (not an uncaught crash) when no hand has ever started yet', async () => {
    // Only 3 of 4 seats joined — no start-hand event exists for this game,
    // so advanceToNextHand's internal getCurrentHandState throws. This must
    // never propagate out of the route handler uncaught.
    const created = await createGame(db, { displayName: 'Alice' });
    await joinGame(db, created.roomCode, { displayName: 'Bob' });
    await joinGame(db, created.roomCode, { displayName: 'Carol' });

    const response = await callNextHand(created.roomCode, created.playerToken);
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: { type: string } };
    expect(body.error.type).toBe('internal-error');
  });

  it('advances to hand 2 once hand 1 is over, returning the same view shape as /state', async () => {
    // A deadWallReserve high enough that startHand ends immediately in an
    // exhaustive draw (same technique as replay.test.ts's HIGH_RESERVE_RULES),
    // giving a deterministic hand-over state without needing to play out a
    // real winning hand.
    const { roomCode, tokens } = await fullyJoinedGame({ deadWallReserve: 140 });

    const response = await callNextHand(roomCode, tokens[1]);
    expect(response.status).toBe(200);

    const view = (await response.json()) as ClientGameView;
    expect(view.handNumber).toBe(2);
    expect(view.status).toBe('in-progress');
    expect(view.viewerSeat).toBe(1);
    expect(view.roomCode).toBe(roomCode);
    // Hand 1 was an exhaustive draw (no winner), so it contributed no
    // payment legs — every seat's match-points total is still zero going
    // into hand 2.
    for (const player of view.players) {
      expect(player.matchPoints).toBe(0);
    }
  });

  it("carries a completed win's payment legs forward as matchPoints once advanced to the next hand", async () => {
    const { gameId, roomCode, tokens } = await fullyJoinedGame();

    // Reuses the known seed-44703/dealer-0 fixture (see auto-pass-mixed.test.ts):
    // discarding 'tiao-7-4' leaves seat 2 with a real hu option.
    await db.execute({ sql: 'DELETE FROM actions WHERE game_id = ?', args: [gameId] });
    await appendStartHand(db, gameId, { handNumber: 1, dealerSeat: 0, seed: 44703, repeatCount: 0, prevailingWind: 'east' });

    const discard = await submitAction(db, gameId, { type: 'discard', seat: 0, tileId: 'tiao-7-4' });
    if (isSubmitRuleError(discard)) throw new Error(`unexpected rule error: ${discard.message}`);
    const pass1 = await submitAction(db, gameId, { type: 'pass', seat: 1 });
    if (isSubmitRuleError(pass1)) throw new Error(`unexpected rule error: ${pass1.message}`);
    const win = await submitAction(db, gameId, { type: 'claim', seat: 2, claim: { type: 'hu' } });
    if (isSubmitRuleError(win)) throw new Error(`unexpected rule error: ${win.message}`);
    if (win.state.phase.type !== 'hand-over' || win.state.phase.result.kind !== 'win') {
      throw new Error('test fixture assumption broken: expected a win result');
    }
    const winnerSeat = win.state.phase.result.winners[0].seat;
    const winnerLeg = win.state.phase.result.legs.find((leg) => leg.payeeSeat === winnerSeat);
    if (winnerLeg === undefined) throw new Error('test fixture assumption broken: no leg for the winner');

    const response = await callNextHand(roomCode, tokens[0]);
    expect(response.status).toBe(200);
    const view = (await response.json()) as ClientGameView;
    expect(view.handNumber).toBe(2);
    expect(view.players[winnerSeat].matchPoints).toBe(winnerLeg.amount);
    expect(view.players[winnerLeg.payerSeat].matchPoints).toBe(-winnerLeg.amount);
  });
});
