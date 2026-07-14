/**
 * Tester-round deep coverage for the SSE stream route's heartbeat wiring and
 * abort-cleanup path, driven through the REAL exported GET route handler
 * (not realtime.ts's DbPollingRealtimeSource.subscribe in isolation). Two
 * concerns, both requested explicitly for this round:
 *
 *  1. The 15s heartbeat interval is actually created via setInterval, and
 *     actually torn down via clearInterval when the request is cancelled —
 *     verified with spies rather than a real 15s wait (impractical in a unit
 *     test), so this confirms the WIRING, not that a real client would
 *     literally receive a byte every 15s.
 *  2. Aborting the request signal actually stops the underlying DB polling
 *     loop (DbPollingRealtimeSource.subscribe's `while (!signal.aborted)`)
 *     promptly — verified by counting real getLatestSeq DB calls before and
 *     after cancellation across one full poll interval, so a production
 *     server accumulating many client disconnects does not leak a polling
 *     loop per abandoned connection.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Client } from '@libsql/client';
import { getDb } from '@/server/db';
import { runMigrations } from '@/server/migrations';
import { createGame, joinGame } from '@/server/games';
import * as actionsLog from '@/server/actions-log';
import { GET } from './route';

let db: Client;

beforeAll(async () => {
  process.env.TURSO_DATABASE_URL = ':memory:';
  delete process.env.TURSO_AUTH_TOKEN;
  db = getDb();
  await runMigrations(db);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function streamRequest(code: string, query: string, signal?: AbortSignal): Request {
  return new Request(`http://localhost/api/games/${code}/stream${query}`, { signal });
}

function callStream(code: string, query: string, signal?: AbortSignal): Promise<Response> {
  return GET(streamRequest(code, query, signal), { params: Promise.resolve({ code }) });
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('GET /api/games/[code]/stream — heartbeat wiring + abort cleanup (real route handler)', () => {
  it('creates the 15s heartbeat interval on start, and clears it via clearInterval when the reader is cancelled', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

    const { roomCode, tokens } = await fullyJoinedGame();
    const response = await callStream(roomCode, `?token=${tokens[0]}`);
    expect(response.status).toBe(200);

    // The heartbeat's setInterval call is made inside the ReadableStream's
    // start() callback, which the Response constructor invokes synchronously
    // enough that it has already run by the time callStream's promise
    // resolves (start() is called eagerly when the stream is constructed).
    const heartbeatCallIndex = setIntervalSpy.mock.calls.findIndex((call) => call[1] === 15000);
    expect(heartbeatCallIndex).toBeGreaterThanOrEqual(0);

    const reader = response.body!.getReader();
    await reader.cancel();

    // cancel() must synchronously invoke the route's cleanup(), which calls
    // clearInterval on exactly the timer setInterval returned.
    const heartbeatResult = setIntervalSpy.mock.results[heartbeatCallIndex];
    const heartbeatTimerId = heartbeatResult.value as ReturnType<typeof setInterval>;
    const wasCleared = clearIntervalSpy.mock.calls.some((call) => call[0] === heartbeatTimerId);
    expect(wasCleared).toBe(true);
  });

  it(
    'aborting the request signal stops the underlying DB polling loop promptly: no further ' +
      'getLatestSeq calls occur after abort, across one full poll interval',
    async () => {
      const getLatestSeqSpy = vi.spyOn(actionsLog, 'getLatestSeq');

      const { roomCode, tokens } = await fullyJoinedGame();
      const controller = new AbortController();
      const response = await callStream(roomCode, `?token=${tokens[0]}`, controller.signal);
      expect(response.status).toBe(200);

      // Let the polling loop run for a bit so we know it has actually started
      // (at least one getLatestSeq call from the subscribe loop's first
      // iteration, which runs immediately without waiting out the interval).
      await sleep(100);
      expect(getLatestSeqSpy.mock.calls.length).toBeGreaterThan(0);

      const callCountAtAbort = getLatestSeqSpy.mock.calls.length;
      controller.abort();

      // POLL_INTERVAL_MS is 1500ms in realtime.ts; wait past one full interval
      // and confirm the loop did NOT wake up and poll again after the abort.
      await sleep(1700);
      expect(getLatestSeqSpy.mock.calls.length).toBe(callCountAtAbort);
    },
    10000,
  );

  it('reading past a cancelled stream reports done, confirming the stream is actually closed (not just paused)', async () => {
    const { roomCode, tokens } = await fullyJoinedGame();
    const response = await callStream(roomCode, `?token=${tokens[0]}`);
    const reader = response.body!.getReader();
    await reader.cancel();

    const result = await reader.read();
    expect(result.done).toBe(true);
  });
});
