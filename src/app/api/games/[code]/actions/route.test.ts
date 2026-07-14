import { beforeAll, describe, expect, it } from 'vitest';
import type { Client } from '@libsql/client';
import { getDb } from '@/server/db';
import { runMigrations } from '@/server/migrations';
import { createGame, joinGame } from '@/server/games';
import { getCurrentHandState } from '@/server/replay';
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
  });
});
