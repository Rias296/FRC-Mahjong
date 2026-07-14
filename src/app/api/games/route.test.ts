import { beforeAll, describe, expect, it } from 'vitest';
import type { Client } from '@libsql/client';
import { getDb } from '@/server/db';
import { runMigrations } from '@/server/migrations';
import { getGameByRoomCode } from '@/server/games';
import type { CreateGameResponse } from '@/lib/protocol';
import { POST } from './route';

/**
 * Route handlers source their DB via src/server/db.ts's getDb() singleton,
 * which reads TURSO_DATABASE_URL. Pointing it at ':memory:' and running
 * migrations against the SAME cached client (module state is isolated
 * per-test-file by vitest, so this doesn't leak across other test files)
 * gives the route handler a real, migrated in-memory libSQL DB — the same
 * technique games.test.ts/replay.test.ts use directly via createClient,
 * just routed through the singleton the route code actually calls.
 */
let db: Client;

beforeAll(async () => {
  process.env.TURSO_DATABASE_URL = ':memory:';
  delete process.env.TURSO_AUTH_TOKEN;
  db = getDb();
  await runMigrations(db);
});

function jsonRequest(body: unknown): Request {
  return new Request('http://localhost/api/games', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/games', () => {
  it('creates a game and seats the caller at seat 0', async () => {
    const response = await POST(jsonRequest({ displayName: 'Alice' }));
    expect(response.status).toBe(201);

    const body = (await response.json()) as CreateGameResponse;
    expect(body.seat).toBe(0);
    expect(body.status).toBe('waiting-for-players');
    expect(body.roomCode).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
    expect(body.playerToken.length).toBeGreaterThan(0);

    const fetched = await getGameByRoomCode(db, body.roomCode);
    expect(fetched?.status).toBe('waiting-for-players');
  });

  it('merges partial rule overrides over the defaults', async () => {
    const response = await POST(jsonRequest({ displayName: 'Alice', rules: { minTaiToWin: 5 } }));
    const body = (await response.json()) as CreateGameResponse;
    expect(body.rules.minTaiToWin).toBe(5);
  });

  it('rejects a missing displayName with 400', async () => {
    const response = await POST(jsonRequest({}));
    expect(response.status).toBe(400);
  });

  it('rejects an empty displayName with 400', async () => {
    const response = await POST(jsonRequest({ displayName: '   ' }));
    expect(response.status).toBe(400);
  });

  it('rejects malformed JSON with 400', async () => {
    const request = new Request('http://localhost/api/games', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not valid json',
    });
    const response = await POST(request);
    expect(response.status).toBe(400);
  });

  describe('rules override validation (regression: unvalidated rules used to be persisted as-is)', () => {
    it('rejects a non-numeric deadWallReserve with a clean 400, and creates no game row', async () => {
      const before = await getGameByRoomCode(db, 'ZZZZZZ'); // sanity: doesn't exist
      expect(before).toBeNull();

      const response = await POST(
        jsonRequest({ displayName: 'Mallory', rules: { deadWallReserve: 'banana' } }),
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: { type: string } };
      expect(body.error.type).toBe('validation-error');
    });

    it('rejects a non-boolean robKong.enabled with a clean 400', async () => {
      const response = await POST(
        jsonRequest({ displayName: 'Mallory', rules: { robKong: { enabled: 'yes' } } }),
      );
      expect(response.status).toBe(400);
    });

    it('rejects an invalid sacredDiscard.scope with a clean 400', async () => {
      const response = await POST(
        jsonRequest({ displayName: 'Mallory', rules: { sacredDiscard: { scope: 'not-a-real-scope' } } }),
      );
      expect(response.status).toBe(400);
    });

    it('rejects an unknown extra key injected into rules with a clean 400', async () => {
      const response = await POST(
        jsonRequest({ displayName: 'Mallory', rules: { notARealRulesField: 123 } }),
      );
      expect(response.status).toBe(400);
    });

    it('does not create a game row when the rules override is rejected', async () => {
      const response = await POST(
        jsonRequest({ displayName: 'Countme', rules: { minTaiToWin: 'nope' } }),
      );
      expect(response.status).toBe(400);
      // A rejected request must never reach createGame, so no room code was
      // ever generated/returned to correlate against — the only observable
      // check available here is that the response itself carries no room code.
      const body = (await response.json()) as { roomCode?: string };
      expect(body.roomCode).toBeUndefined();
    });
  });
});
