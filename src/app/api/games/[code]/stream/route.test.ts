import { beforeAll, describe, expect, it } from 'vitest';
import type { Client } from '@libsql/client';
import { getDb } from '@/server/db';
import { runMigrations } from '@/server/migrations';
import { createGame, joinGame } from '@/server/games';
import { getCurrentHandState, submitAction } from '@/server/replay';
import { getLatestSeq } from '@/server/actions-log';
import type { Seat } from '@/engine/seats';
import { GET } from './route';

/** See src/app/api/games/route.test.ts for why this singleton-routing setup is safe/isolated. */
let db: Client;

beforeAll(async () => {
  process.env.TURSO_DATABASE_URL = ':memory:';
  delete process.env.TURSO_AUTH_TOKEN;
  db = getDb();
  await runMigrations(db);
});

function streamRequest(code: string, query: string): Request {
  return new Request(`http://localhost/api/games/${code}/stream${query}`);
}

function callStream(code: string, query: string): Promise<Response> {
  return GET(streamRequest(code, query), { params: Promise.resolve({ code }) });
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

describe('GET /api/games/[code]/stream', () => {
  it('returns 401 for an empty-string ?token= (present param, empty value — distinct from a totally missing param)', async () => {
    const created = await createGame(db, { displayName: 'Alice' });
    const response = await callStream(created.roomCode, '?token=');
    expect(response.status).toBe(401);
  });

  it('returns 401 with no ?token= query param', async () => {
    const created = await createGame(db, { displayName: 'Alice' });
    const response = await callStream(created.roomCode, '');
    expect(response.status).toBe(401);
  });

  it('returns 401 for an unknown token', async () => {
    const created = await createGame(db, { displayName: 'Alice' });
    const response = await callStream(created.roomCode, '?token=bogus');
    expect(response.status).toBe(401);
  });

  it('returns 404 for an unknown room code', async () => {
    const created = await createGame(db, { displayName: 'Alice' });
    const response = await callStream('ZZZZZZ', `?token=${created.playerToken}`);
    expect(response.status).toBe(404);
  });

  it('returns 401 when the token belongs to a different game than the room code addresses', async () => {
    const gameA = await createGame(db, { displayName: 'Alice' });
    const gameB = await createGame(db, { displayName: 'Zed' });
    const response = await callStream(gameB.roomCode, `?token=${gameA.playerToken}`);
    expect(response.status).toBe(401);
  });

  it(
    'streams an SSE change event once a new action lands after the given ?since= cursor, and stops on cancel',
    async () => {
      const { gameId, roomCode, tokens } = await fullyJoinedGame();
      const latestBefore = await getLatestSeq(db, gameId);

      const response = await callStream(roomCode, `?token=${tokens[0]}&since=${latestBefore}`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      expect(response.body).not.toBeNull();

      const reader = response.body!.getReader();

      // Submit a real action directly against the same DB the route is
      // polling, simulating another request handler's write.
      const current = await getCurrentHandState(db, gameId);
      if (
        current === null ||
        current.state.phase.type !== 'awaiting-discard' ||
        current.state.phase.drawnTile === null
      ) {
        throw new Error('test fixture assumption broken: expected dealer opening draw');
      }
      await submitAction(db, gameId, {
        type: 'discard',
        seat: 0 as Seat,
        tileId: current.state.phase.drawnTile.id,
      });

      const { value, done } = await reader.read();
      expect(done).toBe(false);

      const text = new TextDecoder().decode(value);
      expect(text).toContain('event: change');
      const match = /data: (\{.*\})\n\n/.exec(text);
      expect(match).not.toBeNull();
      const payload = JSON.parse(match![1]) as { seq: number };
      expect(payload.seq).toBeGreaterThan(latestBefore);

      // Cancelling the reader triggers the ReadableStream's cancel() hook,
      // which must abort the underlying poll loop and heartbeat promptly
      // rather than leaking timers past the end of the test.
      await reader.cancel();
    },
    10000,
  );
});
