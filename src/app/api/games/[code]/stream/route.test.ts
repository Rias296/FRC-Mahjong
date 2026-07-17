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

  it(
    "a poll tick invokes turn-timer enforcement (the route's onPoll hook); the resulting " +
      'timed-out auto-action append emits a change event just like a real player action would',
    async () => {
      const { gameId, roomCode, tokens } = await fullyJoinedGame();
      const latestBefore = await getLatestSeq(db, gameId);

      // Backdate the dealer's opening awaiting-discard window (default
      // turnTimerSeconds = 15s) well past its deadline, so the very first
      // poll tick's lazy enforcement finds it already expired.
      await db.execute({
        sql: `UPDATE actions SET created_at = ? WHERE game_id = ? AND action_type = 'start-hand'`,
        args: [Date.now() - 20000, gameId],
      });

      const response = await callStream(roomCode, `?token=${tokens[0]}&since=${latestBefore}`);
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();

      const { value, done } = await reader.read();
      expect(done).toBe(false);

      const text = new TextDecoder().decode(value);
      expect(text).toContain('event: change');
      const match = /data: (\{.*\})\n\n/.exec(text);
      expect(match).not.toBeNull();
      const payload = JSON.parse(match![1]) as { seq: number };
      expect(payload.seq).toBeGreaterThan(latestBefore);

      // Query for the discard row specifically rather than assuming it's the
      // very last row: applyTurnTimeouts's own applyAutoPass follow-through
      // (fixed in review — see turn-timer.ts's doc comment) can append
      // further zero-option auto-pass rows immediately after an unclaimable
      // discard, in this SAME enforcement call.
      const rows = await db.execute({
        sql: "SELECT payload FROM actions WHERE game_id = ? AND action_type = 'discard' ORDER BY seq DESC LIMIT 1",
        args: [gameId],
      });
      expect(rows.rows.length).toBe(1);
      const lastPayload = JSON.parse(String(rows.rows[0].payload)) as { timedOut?: boolean };
      expect(lastPayload.timedOut).toBe(true);

      await reader.cancel();
    },
    10000,
  );

  it(
    'TESTER ROUND: a poll tick never enforces (the onPoll hook is never wired at all, not merely a ' +
      'no-op) when the game\'s configured turnTimerSeconds is <= 0, even for an ancient expired window',
    async () => {
      const created = await createGame(db, { displayName: 'Alice', rules: { turnTimerSeconds: 0 } });
      const j2 = await joinGame(db, created.roomCode, { displayName: 'Bob' });
      const j3 = await joinGame(db, created.roomCode, { displayName: 'Carol' });
      const j4 = await joinGame(db, created.roomCode, { displayName: 'Dave' });
      if ('error' in j2 || 'error' in j3 || 'error' in j4) {
        throw new Error('unexpected join error setting up fixture');
      }
      const { gameId, roomCode } = created;
      const token = created.playerToken;
      const latestBefore = await getLatestSeq(db, gameId);

      await db.execute({
        sql: `UPDATE actions SET created_at = ? WHERE game_id = ? AND action_type = 'start-hand'`,
        args: [Date.now() - 10 * 24 * 60 * 60 * 1000, gameId],
      });

      const response = await callStream(roomCode, `?token=${token}&since=${latestBefore}`);
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();

      // Give the generator a poll cycle's worth of time to run (well short
      // of the 1500ms interval, since with the timer disabled it should
      // never yield a change event at all here).
      const raceResult = await Promise.race([
        reader.read().then(() => 'yielded' as const),
        new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 400)),
      ]);
      expect(raceResult).toBe('timed-out');

      const rows = await db.execute({ sql: 'SELECT COUNT(*) AS n FROM actions WHERE game_id = ?', args: [gameId] });
      expect(Number(rows.rows[0].n)).toBe(1); // only the original start-hand row — nothing enforced/appended

      await reader.cancel();
    },
    10000,
  );
});
