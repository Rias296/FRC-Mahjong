import { beforeAll, describe, expect, it } from 'vitest';
import type { Client } from '@libsql/client';
import { getDb } from '@/server/db';
import { runMigrations } from '@/server/migrations';
import { createGame, joinGame } from '@/server/games';
import type { ClientGameView } from '@/lib/protocol';
import { GET } from './route';

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
  return new Request(`http://localhost/api/games/${code}/state`, { headers });
}

function callState(code: string, token: string | null): Promise<Response> {
  return GET(authedRequest(code, token), { params: Promise.resolve({ code }) });
}

async function fullyJoinedGame(): Promise<{
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
  return { roomCode: created.roomCode, tokens: [created.playerToken, j2.playerToken, j3.playerToken, j4.playerToken] };
}

function callStateRawAuth(code: string, authHeaderValue: string | undefined): Promise<Response> {
  const headers: Record<string, string> = {};
  if (authHeaderValue !== undefined) headers.authorization = authHeaderValue;
  const request = new Request(`http://localhost/api/games/${code}/state`, { headers });
  return GET(request, { params: Promise.resolve({ code }) });
}

describe('GET /api/games/[code]/state', () => {
  it('returns 401 for a non-Bearer auth scheme ("Basic ...")', async () => {
    const created = await createGame(db, { displayName: 'Alice' });
    const response = await callStateRawAuth(created.roomCode, `Basic ${created.playerToken}`);
    expect(response.status).toBe(401);
  });

  it('returns 401 for "Bearer" with no token at all', async () => {
    const created = await createGame(db, { displayName: 'Alice' });
    const response = await callStateRawAuth(created.roomCode, 'Bearer');
    expect(response.status).toBe(401);
  });

  it('returns 401 for an empty-string Authorization header', async () => {
    const created = await createGame(db, { displayName: 'Alice' });
    const response = await callStateRawAuth(created.roomCode, '');
    expect(response.status).toBe(401);
  });

  it('returns 401 with no Authorization header', async () => {
    const created = await createGame(db, { displayName: 'Alice' });
    const response = await callState(created.roomCode, null);
    expect(response.status).toBe(401);
  });

  it('returns 401 for an unknown token', async () => {
    const created = await createGame(db, { displayName: 'Alice' });
    const response = await callState(created.roomCode, 'not-a-real-token');
    expect(response.status).toBe(401);
  });

  it('returns 404 for an unknown room code even with a valid token (from another game)', async () => {
    const created = await createGame(db, { displayName: 'Alice' });
    const response = await callState('ZZZZZZ', created.playerToken);
    expect(response.status).toBe(404);
  });

  it("returns 401 when the token belongs to a DIFFERENT game than the room code addresses", async () => {
    const gameA = await createGame(db, { displayName: 'Alice' });
    const gameB = await createGame(db, { displayName: 'Zed' });
    const response = await callState(gameB.roomCode, gameA.playerToken);
    expect(response.status).toBe(401);
  });

  it('returns a waiting-for-players view with handNumber/phase/wallRemaining null before the game starts', async () => {
    const created = await createGame(db, { displayName: 'Alice' });
    const response = await callState(created.roomCode, created.playerToken);
    expect(response.status).toBe(200);

    const view = (await response.json()) as ClientGameView;
    expect(view.status).toBe('waiting-for-players');
    expect(view.handNumber).toBeNull();
    expect(view.phase).toBeNull();
    expect(view.wallRemaining).toBeNull();
    // CRITICAL (tester round): currentTurnSeat/dealerSeat/repeatCount must be
    // null in EXACTLY the waiting-for-players case, per protocol.ts's field
    // doc ("Null iff `phase` is null"). This route file's own
    // waitingForPlayersView branch is a second, independent implementation
    // of that contract from views.ts's toClientView — pin both explicitly so
    // they can never silently drift apart.
    expect(view.currentTurnSeat).toBeNull();
    expect(view.dealerSeat).toBeNull();
    expect(view.repeatCount).toBeNull();
    expect(view.viewerSeat).toBe(0);
    expect(view.players[0].displayName).toBe('Alice');
    expect(view.players[0].isViewer).toBe(true);
    expect(view.players[1].displayName).toBe('Seat 1');
    // Regression: the waiting-for-players branch must report seq=0 (the
    // seq of the zero-action-rows read it actually performed), never a
    // separate getLatestSeq() call that could race ahead of the "still
    // waiting" content if a concurrent 4th join starts the game between
    // the two reads (seq would then falsely claim the client is caught up
    // to a hand-start event its own view doesn't reflect).
    expect(view.seq).toBe(0);
  });

  it('returns the full redacted in-progress view once the game has 4 players', async () => {
    const { roomCode, tokens } = await fullyJoinedGame();
    const response = await callState(roomCode, tokens[0]);
    expect(response.status).toBe(200);

    const view = (await response.json()) as ClientGameView;
    expect(view.status).toBe('in-progress');
    expect(view.handNumber).toBe(1);
    expect(view.prevailingWind).toBe('east');
    expect(view.viewerSeat).toBe(0);
    expect(view.wallRemaining).toBeGreaterThan(0);
    // CRITICAL (tester round): the counterpart to the waiting-for-players
    // null-check above — once genuinely in-progress, all three fields must
    // be non-null, and agree with the real engine state (seat 0 is dealer
    // and currentTurnSeat on the opening draw; repeatCount starts at 0).
    expect(view.currentTurnSeat).toBe(0);
    expect(view.dealerSeat).toBe(0);
    expect(view.repeatCount).toBe(0);

    const me = view.players[0];
    expect(me.isViewer).toBe(true);
    expect(me.concealedTiles).not.toBeNull();
    expect(me.concealedTiles?.length).toBe(me.concealedCount);

    for (const seat of [1, 2, 3] as const) {
      const opponent = view.players[seat];
      expect(opponent.isViewer).toBe(false);
      expect(opponent.concealedTiles).toBeNull();
      expect(opponent.barredVisible).toBeNull();
    }

    // Seat 0 is the dealer and has the opening draw; awaiting-discard.
    expect(view.phase?.type).toBe('awaiting-discard');
  });

  it('gives each seat their own perspective (different token -> different isViewer/concealed visibility)', async () => {
    const { roomCode, tokens } = await fullyJoinedGame();
    const responseSeat1 = await callState(roomCode, tokens[1]);
    const viewSeat1 = (await responseSeat1.json()) as ClientGameView;

    expect(viewSeat1.viewerSeat).toBe(1);
    expect(viewSeat1.players[1].isViewer).toBe(true);
    expect(viewSeat1.players[1].concealedTiles).not.toBeNull();
    expect(viewSeat1.players[0].isViewer).toBe(false);
    expect(viewSeat1.players[0].concealedTiles).toBeNull();
  });

  it(
    'CRITICAL (tester round): currentTurnSeat/dealerSeat/repeatCount are genuinely public — every ' +
      'one of the 4 seats sees byte-identical values for these 3 fields via this live HTTP endpoint, ' +
      'unlike concealedTiles/barredVisible which correctly DO vary per viewer',
    async () => {
      const { roomCode, tokens } = await fullyJoinedGame();
      const views = await Promise.all(
        tokens.map(async (token) => {
          const response = await callState(roomCode, token);
          return (await response.json()) as ClientGameView;
        }),
      );

      for (const v of views) {
        expect(v.currentTurnSeat).toBe(0);
        expect(v.dealerSeat).toBe(0);
        expect(v.repeatCount).toBe(0);
      }
      // Contrast: concealedTiles genuinely DOES vary per viewer (proves the
      // test fixture isn't accidentally exercising a code path where
      // everything happens to be the same).
      expect(views[0].players[0].concealedTiles).not.toBeNull();
      expect(views[1].players[0].concealedTiles).toBeNull();
    },
  );

  it('waiting-for-players view marks only joined seats occupied', async () => {
    const created = await createGame(db, { displayName: 'Alice' });
    await joinGame(db, created.roomCode, { displayName: 'Bob' });

    const response = await callState(created.roomCode, created.playerToken);
    const view = (await response.json()) as ClientGameView;

    expect(view.status).toBe('waiting-for-players');
    expect(view.players[0].occupied).toBe(true);
    expect(view.players[1].occupied).toBe(true);
    expect(view.players[2].occupied).toBe(false);
    expect(view.players[3].occupied).toBe(false);
  });

  it('waiting view does not mark a seat occupied merely because a player is named "Seat 2"', async () => {
    const created = await createGame(db, { displayName: 'Seat 2' });

    const response = await callState(created.roomCode, created.playerToken);
    const view = (await response.json()) as ClientGameView;

    expect(view.status).toBe('waiting-for-players');
    expect(view.players[0].displayName).toBe('Seat 2');
    expect(view.players[0].occupied).toBe(true);
    expect(view.players[1].occupied).toBe(false);
    expect(view.players[2].occupied).toBe(false);
    expect(view.players[3].occupied).toBe(false);
  });
});
