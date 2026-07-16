import { beforeAll, describe, expect, it } from 'vitest';
import type { Client } from '@libsql/client';
import { getDb } from '@/server/db';
import { runMigrations } from '@/server/migrations';
import { createGame, joinGame } from '@/server/games';
import { getCurrentHandState } from '@/server/replay';
import { createProfile } from '@/server/ranked';
import { appendStartHand } from '@/server/actions-log';
import { DEFAULT_RULES, type RulesConfig } from '@/engine/rules-config';
import type { ClientGameView, SubmitActionResponse } from '@/lib/protocol';
import type { Seat } from '@/engine/seats';
import { POST } from './route';

/** See src/app/api/games/route.test.ts for why this singleton-routing setup is safe/isolated. */
let db: Client;

beforeAll(async () => {
  process.env.TURSO_DATABASE_URL = ':memory:';
  delete process.env.TURSO_AUTH_TOKEN;
  db = getDb();
  await runMigrations(db);
});

function actionRequest(code: string, token: string | null, action: unknown): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return new Request(`http://localhost/api/games/${code}/actions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ action }),
  });
}

function callActions(code: string, token: string | null, action: unknown): Promise<Response> {
  return POST(actionRequest(code, token, action), { params: Promise.resolve({ code }) });
}

async function fullyJoinedGame(): Promise<{
  gameId: string;
  roomCode: string;
  tokens: readonly [string, string, string, string];
}> {
  const created = await createGame(db, { displayName: 'Alice' });
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

function callActionsRawAuth(code: string, authHeaderValue: string | undefined, action: unknown): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (authHeaderValue !== undefined) headers.authorization = authHeaderValue;
  const request = new Request(`http://localhost/api/games/${code}/actions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ action }),
  });
  return POST(request, { params: Promise.resolve({ code }) });
}

describe('POST /api/games/[code]/actions', () => {
  it('returns 401 with no Authorization header', async () => {
    const created = await createGame(db, { displayName: 'Alice' });
    const response = await callActions(created.roomCode, null, { type: 'draw', seat: 0 });
    expect(response.status).toBe(401);
  });

  it('returns 401 for an unknown token', async () => {
    const created = await createGame(db, { displayName: 'Alice' });
    const response = await callActions(created.roomCode, 'bogus', { type: 'draw', seat: 0 });
    expect(response.status).toBe(401);
  });

  it('returns 401 when the token belongs to a DIFFERENT game than the room code addresses', async () => {
    const gameA = await createGame(db, { displayName: 'Alice' });
    const gameB = await createGame(db, { displayName: 'Zed' });
    const response = await callActions(gameB.roomCode, gameA.playerToken, { type: 'draw', seat: 0 });
    expect(response.status).toBe(401);
  });

  it('returns 401 for a non-Bearer auth scheme ("Basic ...")', async () => {
    const created = await createGame(db, { displayName: 'Alice' });
    const response = await callActionsRawAuth(created.roomCode, `Basic ${created.playerToken}`, {
      type: 'draw',
      seat: 0,
    });
    expect(response.status).toBe(401);
  });

  it('returns 401 for "Bearer" with no token at all (no trailing space)', async () => {
    const created = await createGame(db, { displayName: 'Alice' });
    const response = await callActionsRawAuth(created.roomCode, 'Bearer', { type: 'draw', seat: 0 });
    expect(response.status).toBe(401);
  });

  it('returns 401 for "Bearer " with a trailing space and an empty token', async () => {
    const created = await createGame(db, { displayName: 'Alice' });
    const response = await callActionsRawAuth(created.roomCode, 'Bearer ', { type: 'draw', seat: 0 });
    expect(response.status).toBe(401);
  });

  it('returns 401 for an empty-string Authorization header', async () => {
    const created = await createGame(db, { displayName: 'Alice' });
    const response = await callActionsRawAuth(created.roomCode, '', { type: 'draw', seat: 0 });
    expect(response.status).toBe(401);
  });

  it('returns 404 for an unknown room code', async () => {
    const created = await createGame(db, { displayName: 'Alice' });
    const response = await callActions('ZZZZZZ', created.playerToken, { type: 'draw', seat: 0 });
    expect(response.status).toBe(404);
  });

  it('returns 400 for malformed JSON', async () => {
    const created = await createGame(db, { displayName: 'Alice' });
    const request = new Request(`http://localhost/api/games/${created.roomCode}/actions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${created.playerToken}` },
      body: 'not json',
    });
    const response = await POST(request, { params: Promise.resolve({ code: created.roomCode }) });
    expect(response.status).toBe(400);
  });

  it('returns 400 for a missing/malformed action body', async () => {
    const created = await createGame(db, { displayName: 'Alice' });
    const request = new Request(`http://localhost/api/games/${created.roomCode}/actions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${created.playerToken}` },
      body: JSON.stringify({}),
    });
    const response = await POST(request, { params: Promise.resolve({ code: created.roomCode }) });
    expect(response.status).toBe(400);
  });

  it('returns 403 when action.seat does not match the authenticated token seat', async () => {
    const { roomCode, tokens } = await fullyJoinedGame();
    // tokens[0] is seat 0's token; submit an action claiming to be seat 1.
    const response = await callActions(roomCode, tokens[0], { type: 'draw', seat: 1 });
    expect(response.status).toBe(403);
  });

  it('returns 409 with a RuleError body for an illegal action', async () => {
    const { roomCode, tokens } = await fullyJoinedGame();
    // Seat 0 is the dealer and holds the opening draw (awaiting-discard);
    // discarding a tile that isn't in their hand is rejected by the engine.
    const response = await callActions(roomCode, tokens[0], {
      type: 'discard',
      seat: 0,
      tileId: 'not-a-real-tile-id',
    });
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { type: string; code: string } };
    expect(body.error.type).toBe('rule-error');
    expect(body.error.code).toBe('tile-not-in-hand');
  });

  it('accepts a legal discard and returns the submitting seat their redacted view', async () => {
    const { gameId, roomCode, tokens } = await fullyJoinedGame();

    const current = await getCurrentHandState(db, gameId);
    if (current === null || current.state.phase.type !== 'awaiting-discard' || current.state.phase.drawnTile === null) {
      throw new Error('test fixture assumption broken: expected dealer opening draw');
    }
    const drawnTileId = current.state.phase.drawnTile.id;

    const response = await callActions(roomCode, tokens[0], {
      type: 'discard',
      seat: 0 as Seat,
      tileId: drawnTileId,
    });
    expect(response.status).toBe(200);

    const body = (await response.json()) as SubmitActionResponse;
    expect(body.seq).toBeGreaterThan(1); // at least past the seq=1 start-hand row
    const view: ClientGameView = body.view;
    expect(view.viewerSeat).toBe(0);
    expect(view.seq).toBe(body.seq);
    // After a discard, control passes to the claim window (or straight to
    // the next player if nobody has any legal claim).
    expect(['awaiting-claims', 'awaiting-draw']).toContain(view.phase?.type);
    // Hand 1 hasn't finished yet, so every seat's match-points total is
    // still exactly the configured starting pool.
    for (const player of view.players) {
      expect(player.matchPoints).toBe(DEFAULT_RULES.points.startingPoints);
    }
  });

  it("reflects a completed win's payment legs in matchPoints, computed from a single self-consistent snapshot", async () => {
    const { gameId, roomCode, tokens } = await fullyJoinedGame();

    // Reuses the known seed-44703/dealer-0 fixture (see auto-pass-mixed.test.ts):
    // discarding 'tiao-7-4' leaves seat 2 with a real hu option.
    await db.execute({ sql: 'DELETE FROM actions WHERE game_id = ?', args: [gameId] });
    await appendStartHand(db, gameId, { handNumber: 1, dealerSeat: 0, seed: 44703, repeatCount: 0, prevailingWind: 'east' });

    const discardResponse = await callActions(roomCode, tokens[0], { type: 'discard', seat: 0, tileId: 'tiao-7-4' });
    expect(discardResponse.status).toBe(200);
    const passResponse = await callActions(roomCode, tokens[1], { type: 'pass', seat: 1 });
    expect(passResponse.status).toBe(200);
    const winResponse = await callActions(roomCode, tokens[2], { type: 'claim', seat: 2, claim: { type: 'hu' } });
    expect(winResponse.status).toBe(200);

    const winBody = (await winResponse.json()) as SubmitActionResponse;
    const winView = winBody.view;
    const winPhase = winView.phase;
    if (winPhase?.type !== 'hand-over' || winPhase.result === undefined || winPhase.result.kind !== 'win') {
      throw new Error('test fixture assumption broken: expected a win result');
    }
    const winnerSeat = winPhase.result.winners[0].seat;
    const winnerLeg = winPhase.result.legs.find((leg) => leg.payeeSeat === winnerSeat);
    if (winnerLeg === undefined) throw new Error('test fixture assumption broken: no leg for the winner');

    // Pool-scale (RULES.md §13): every seat starts at
    // rules.points.startingPoints, so the winner's total is
    // startingPoints + leg.amount and the payer's is startingPoints -
    // leg.amount, never the bare delta amount itself.
    expect(winView.players[winnerSeat].matchPoints).toBe(DEFAULT_RULES.points.startingPoints + winnerLeg.amount);
    expect(winView.players[winnerLeg.payerSeat].matchPoints).toBe(
      DEFAULT_RULES.points.startingPoints - winnerLeg.amount,
    );
  });

  it(
    "sets the response view's status to 'finished' the instant a winning action's own settlement " +
      'busts a seat — no follow-up next-hand call needed to observe it',
    async () => {
      // startingPoints low enough that a single ordinary payment leg
      // (basePoints 3000 + at least 1 tai * perTai 1000) drives the payer
      // below zero.
      const created = await createGame(db, {
        displayName: 'Alice',
        rules: { points: { startingPoints: 100 } } as Partial<RulesConfig>,
      });
      const j2 = await joinGame(db, created.roomCode, { displayName: 'Bob' });
      const j3 = await joinGame(db, created.roomCode, { displayName: 'Carol' });
      const j4 = await joinGame(db, created.roomCode, { displayName: 'Dave' });
      if ('error' in j2 || 'error' in j3 || 'error' in j4) {
        throw new Error('unexpected join error setting up fixture');
      }
      const tokens = [created.playerToken, j2.playerToken, j3.playerToken, j4.playerToken] as const;

      // Reuses the known seed-44703/dealer-0 fixture: discarding 'tiao-7-4'
      // leaves seat 2 with a real hu option.
      await db.execute({ sql: 'DELETE FROM actions WHERE game_id = ?', args: [created.gameId] });
      await appendStartHand(db, created.gameId, {
        handNumber: 1,
        dealerSeat: 0,
        seed: 44703,
        repeatCount: 0,
        prevailingWind: 'east',
      });

      const discardResponse = await callActions(created.roomCode, tokens[0], {
        type: 'discard',
        seat: 0,
        tileId: 'tiao-7-4',
      });
      expect(discardResponse.status).toBe(200);
      const passResponse = await callActions(created.roomCode, tokens[1], { type: 'pass', seat: 1 });
      expect(passResponse.status).toBe(200);
      const winResponse = await callActions(created.roomCode, tokens[2], {
        type: 'claim',
        seat: 2,
        claim: { type: 'hu' },
      });
      expect(winResponse.status).toBe(200);

      const winBody = (await winResponse.json()) as SubmitActionResponse;
      expect(winBody.view.phase?.type).toBe('hand-over');
      expect(winBody.view.status).toBe('finished');

      // The DB row itself was flipped too (not just the response view).
      const gameRow = await db.execute({ sql: 'SELECT status FROM games WHERE id = ?', args: [created.gameId] });
      expect(String(gameRow.rows[0].status)).toBe('finished');
    },
  );

  it(
    "includes a settled 'ranked' view in the winning submitter's own response the instant the match " +
      'busts, when all 4 seats are linked to a profile',
    async () => {
      const profiles = await Promise.all([0, 1, 2, 3].map(async (i) => createProfile(db, `RankedPlayer${i}`)));

      const created = await createGame(db, {
        displayName: 'Alice',
        rules: { points: { startingPoints: 100 } } as Partial<RulesConfig>,
        profileId: profiles[0].profileId,
      });
      const j2 = await joinGame(db, created.roomCode, { displayName: 'Bob', profileId: profiles[1].profileId });
      const j3 = await joinGame(db, created.roomCode, { displayName: 'Carol', profileId: profiles[2].profileId });
      const j4 = await joinGame(db, created.roomCode, { displayName: 'Dave', profileId: profiles[3].profileId });
      if ('error' in j2 || 'error' in j3 || 'error' in j4) {
        throw new Error('unexpected join error setting up fixture');
      }
      const tokens = [created.playerToken, j2.playerToken, j3.playerToken, j4.playerToken] as const;

      await db.execute({ sql: 'DELETE FROM actions WHERE game_id = ?', args: [created.gameId] });
      await appendStartHand(db, created.gameId, {
        handNumber: 1,
        dealerSeat: 0,
        seed: 44703,
        repeatCount: 0,
        prevailingWind: 'east',
      });

      await callActions(created.roomCode, tokens[0], { type: 'discard', seat: 0, tileId: 'tiao-7-4' });
      await callActions(created.roomCode, tokens[1], { type: 'pass', seat: 1 });
      const winResponse = await callActions(created.roomCode, tokens[2], {
        type: 'claim',
        seat: 2,
        claim: { type: 'hu' },
      });
      expect(winResponse.status).toBe(200);

      const winBody = (await winResponse.json()) as SubmitActionResponse;
      expect(winBody.view.status).toBe('finished');
      expect(winBody.view.ranked?.status).toBe('settled');
      if (winBody.view.ranked?.status !== 'settled') throw new Error('expected settled ranked view');
      expect(winBody.view.ranked.seats.length).toBe(4);
      const winnerSeatResult = winBody.view.ranked.seats.find((s) => s.seat === 2);
      expect(winnerSeatResult?.placement).toBe(1);
      expect(winnerSeatResult?.rpDelta).toBeGreaterThan(0);

      const historyRows = await db.execute({
        sql: 'SELECT COUNT(*) AS n FROM rank_history WHERE game_id = ?',
        args: [created.gameId],
      });
      expect(Number(historyRows.rows[0].n)).toBe(4);
    },
  );

  it("omits a settled 'ranked' view (reports unranked) when a seat is unlinked, even once the match finishes", async () => {
    const created = await createGame(db, {
      displayName: 'Alice',
      rules: { points: { startingPoints: 100 } } as Partial<RulesConfig>,
    });
    const j2 = await joinGame(db, created.roomCode, { displayName: 'Bob' });
    const j3 = await joinGame(db, created.roomCode, { displayName: 'Carol' });
    const j4 = await joinGame(db, created.roomCode, { displayName: 'Dave' });
    if ('error' in j2 || 'error' in j3 || 'error' in j4) {
      throw new Error('unexpected join error setting up fixture');
    }
    const tokens = [created.playerToken, j2.playerToken, j3.playerToken, j4.playerToken] as const;

    await db.execute({ sql: 'DELETE FROM actions WHERE game_id = ?', args: [created.gameId] });
    await appendStartHand(db, created.gameId, {
      handNumber: 1,
      dealerSeat: 0,
      seed: 44703,
      repeatCount: 0,
      prevailingWind: 'east',
    });
    await callActions(created.roomCode, tokens[0], { type: 'discard', seat: 0, tileId: 'tiao-7-4' });
    await callActions(created.roomCode, tokens[1], { type: 'pass', seat: 1 });
    const winResponse = await callActions(created.roomCode, tokens[2], { type: 'claim', seat: 2, claim: { type: 'hu' } });

    const winBody = (await winResponse.json()) as SubmitActionResponse;
    expect(winBody.view.status).toBe('finished');
    expect(winBody.view.ranked).toEqual({ status: 'unranked' });
  });
});
