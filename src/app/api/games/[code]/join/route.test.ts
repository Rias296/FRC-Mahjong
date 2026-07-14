import { beforeAll, describe, expect, it } from 'vitest';
import type { Client } from '@libsql/client';
import { getDb } from '@/server/db';
import { runMigrations } from '@/server/migrations';
import { createGame } from '@/server/games';
import type { JoinGameResponse } from '@/lib/protocol';
import { POST } from './route';

/** See src/app/api/games/route.test.ts for why this singleton-routing setup is safe/isolated. */
let db: Client;

beforeAll(async () => {
  process.env.TURSO_DATABASE_URL = ':memory:';
  delete process.env.TURSO_AUTH_TOKEN;
  db = getDb();
  await runMigrations(db);
});

function jsonRequest(code: string, body: unknown): Request {
  return new Request(`http://localhost/api/games/${code}/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function callJoin(code: string, body: unknown): Promise<Response> {
  return POST(jsonRequest(code, body), { params: Promise.resolve({ code }) });
}

describe('POST /api/games/[code]/join', () => {
  it('seats the caller at the lowest free seat and flips to in-progress on the 4th join', async () => {
    const created = await createGame(db, { displayName: 'Alice' });

    const r2 = await callJoin(created.roomCode, { displayName: 'Bob' });
    expect(r2.status).toBe(200);
    const b2 = (await r2.json()) as JoinGameResponse;
    expect(b2.seat).toBe(1);
    expect(b2.status).toBe('waiting-for-players');

    await callJoin(created.roomCode, { displayName: 'Carol' });
    const r4 = await callJoin(created.roomCode, { displayName: 'Dave' });
    const b4 = (await r4.json()) as JoinGameResponse;
    expect(b4.seat).toBe(3);
    expect(b4.status).toBe('in-progress');
  });

  it('returns 404 for an unknown room code', async () => {
    const response = await callJoin('ZZZZZZ', { displayName: 'Nobody' });
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe('not-found');
  });

  it('returns 409 already-started once the game has naturally started (4 seats taken)', async () => {
    const created = await createGame(db, { displayName: 'A' });
    await callJoin(created.roomCode, { displayName: 'B' });
    await callJoin(created.roomCode, { displayName: 'C' });
    await callJoin(created.roomCode, { displayName: 'D' });

    const fifth = await callJoin(created.roomCode, { displayName: 'E' });
    expect(fifth.status).toBe(409);
    const body = (await fifth.json()) as { error: string };
    expect(body.error).toBe('already-started');
  });

  it('rejects a missing displayName with 400', async () => {
    const created = await createGame(db, { displayName: 'Solo' });
    const response = await callJoin(created.roomCode, {});
    expect(response.status).toBe(400);
  });

  it('rejects malformed JSON with 400', async () => {
    const created = await createGame(db, { displayName: 'Solo2' });
    const request = new Request(`http://localhost/api/games/${created.roomCode}/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    const response = await POST(request, { params: Promise.resolve({ code: created.roomCode }) });
    expect(response.status).toBe(400);
  });
});
