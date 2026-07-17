import { beforeAll, describe, expect, it } from 'vitest';
import type { Client } from '@libsql/client';
import { getDb } from '@/server/db';
import { runMigrations } from '@/server/migrations';
import { createGame, joinGame } from '@/server/games';
import { appendStartHand } from '@/server/actions-log';
import { advanceToNextHand, submitAction } from '@/server/replay';
import { createProfile } from '@/server/ranked';
import { DEFAULT_RULES, type RulesConfig } from '@/engine/rules-config';
import type { GameState, RuleError } from '@/engine/game-state';
import type { ClientGameView } from '@/lib/protocol';
import { GET } from './route';

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
  return new Request(`http://localhost/api/games/${code}/state`, { headers });
}

function callState(code: string, token: string | null): Promise<Response> {
  return GET(authedRequest(code, token), { params: Promise.resolve({ code }) });
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
    // No hand has started, so every seat's match-points total is seeded
    // with the match's starting pool (rules.points.startingPoints), not 0.
    for (const player of view.players) {
      expect(player.matchPoints).toBe(DEFAULT_RULES.points.startingPoints);
    }
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

    // No hand has completed yet in this fresh match, so every seat's
    // match-points total is still exactly the configured starting pool.
    for (const player of view.players) {
      expect(player.matchPoints).toBe(DEFAULT_RULES.points.startingPoints);
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

  it('waiting-for-players view seeds matchPoints with the game\'s configured startingPoints, not 0', async () => {
    const created = await createGame(db, {
      displayName: 'Alice',
      rules: { points: { startingPoints: 50000 } } as Partial<RulesConfig>,
    });

    const response = await callState(created.roomCode, created.playerToken);
    expect(response.status).toBe(200);

    const view = (await response.json()) as ClientGameView;
    expect(view.status).toBe('waiting-for-players');
    for (const player of view.players) {
      expect(player.matchPoints).toBe(50000);
    }
  });

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

  it('reflects a completed hand\'s payment legs in every seat\'s matchPoints, identically for every viewer', async () => {
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

    const responses = await Promise.all(tokens.map((token) => callState(roomCode, token)));
    const views = (await Promise.all(responses.map((r) => r.json()))) as ClientGameView[];

    // Pool-scale (RULES.md §13): every seat starts at
    // rules.points.startingPoints, so the winner's total is
    // startingPoints + leg.amount and the payer's is startingPoints -
    // leg.amount, never the bare delta amount itself.
    for (const view of views) {
      expect(view.players[winnerSeat].matchPoints).toBe(DEFAULT_RULES.points.startingPoints + winnerLeg.amount);
      expect(view.players[winnerLeg.payerSeat].matchPoints).toBe(
        DEFAULT_RULES.points.startingPoints - winnerLeg.amount,
      );
    }
  });

  it(
    "surfaces a settled 'ranked' view to an OBSERVER (a seat who never submitted the finishing action) " +
      'once the match has finished — the observer-healing path',
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
      const roomCode = created.roomCode;
      const gameId = created.gameId;
      // Seat 2 is the winner below — use seat 1's token as "the observer"
      // (a seat who never submits the finishing action at all).
      const observerToken = j2.playerToken;

      await db.execute({ sql: 'DELETE FROM actions WHERE game_id = ?', args: [gameId] });
      await appendStartHand(db, gameId, { handNumber: 1, dealerSeat: 0, seed: 44703, repeatCount: 0, prevailingWind: 'east' });

      const discard = await submitAction(db, gameId, { type: 'discard', seat: 0, tileId: 'tiao-7-4' });
      if (isSubmitRuleError(discard)) throw new Error(`unexpected rule error: ${discard.message}`);
      const pass1 = await submitAction(db, gameId, { type: 'pass', seat: 1 });
      if (isSubmitRuleError(pass1)) throw new Error(`unexpected rule error: ${pass1.message}`);
      const win = await submitAction(db, gameId, { type: 'claim', seat: 2, claim: { type: 'hu' } });
      if (isSubmitRuleError(win)) throw new Error(`unexpected rule error: ${win.message}`);

      // Flip games.status to 'finished' via advanceToNextHand — mirrors what
      // would happen server-side after the winning action, WITHOUT going
      // through the actions route at all, so this test genuinely exercises
      // the /state route's OWN independent settleRankedMatch call, not a
      // side effect of the actions route's own hook.
      const advance = await advanceToNextHand(db, gameId);
      expect(advance).toEqual({ error: 'game-finished' });

      const response = await callState(roomCode, observerToken);
      expect(response.status).toBe(200);
      const view = (await response.json()) as ClientGameView;
      expect(view.status).toBe('finished');
      expect(view.ranked?.status).toBe('settled');
      if (view.ranked?.status !== 'settled') throw new Error('expected settled ranked view');
      expect(view.ranked.seats.length).toBe(4);

      const historyRows = await db.execute({ sql: 'SELECT COUNT(*) AS n FROM rank_history WHERE game_id = ?', args: [gameId] });
      expect(Number(historyRows.rows[0].n)).toBe(4);
    },
  );

  describe('turn-timer wire fields and lazy enforcement', () => {
    it('carries turnDeadline/serverNow/turnTimerSeconds on the in-progress view', async () => {
      const { roomCode, tokens } = await fullyJoinedGame();
      const response = await callState(roomCode, tokens[0]);
      const view = (await response.json()) as ClientGameView;

      expect(view.status).toBe('in-progress');
      expect(view.turnTimerSeconds).toBe(DEFAULT_RULES.turnTimerSeconds);
      expect(typeof view.serverNow).toBe('number');
      expect(typeof view.turnDeadline).toBe('number');
      expect(view.turnDeadline as number).toBeGreaterThan(Date.now() - 1000);
    });

    it('carries turnDeadline: null, but a real turnTimerSeconds, on the waiting-for-players view', async () => {
      const created = await createGame(db, { displayName: 'Alice' });
      const response = await callState(created.roomCode, created.playerToken);
      const view = (await response.json()) as ClientGameView;

      expect(view.status).toBe('waiting-for-players');
      expect(view.turnDeadline).toBeNull();
      expect(view.turnTimerSeconds).toBe(DEFAULT_RULES.turnTimerSeconds);
    });

    it('lazily enforces an already-expired opening window on GET, auto-acting before the response is built', async () => {
      const { gameId, roomCode, tokens } = await fullyJoinedGame();

      // Backdate the hand's start-hand row (the dealer's opening
      // awaiting-discard window opened at hand start) well past the
      // default 15s turnTimerSeconds.
      await db.execute({
        sql: `UPDATE actions SET created_at = ? WHERE game_id = ? AND action_type = 'start-hand'`,
        args: [Date.now() - 20000, gameId],
      });

      const beforeRows = await db.execute({ sql: 'SELECT COUNT(*) AS n FROM actions WHERE game_id = ?', args: [gameId] });
      expect(Number(beforeRows.rows[0].n)).toBe(1);

      const response = await callState(roomCode, tokens[0]);
      expect(response.status).toBe(200);
      const view = (await response.json()) as ClientGameView;

      // The dealer's opening discard should have been auto-timed-out by
      // this GET's own lazy enforcement, moving the phase on rather than
      // still sitting in awaiting-discard.
      expect(view.phase?.type).not.toBe('awaiting-discard');

      // Query for the discard row specifically rather than assuming it's the
      // very last row: applyTurnTimeouts's own applyAutoPass follow-through
      // (fixed in review — see turn-timer.ts's doc comment) can append
      // further zero-option auto-pass rows immediately after an unclaimable
      // discard, in this SAME enforcement call.
      const afterRows = await db.execute({
        sql: "SELECT payload FROM actions WHERE game_id = ? AND action_type = 'discard' ORDER BY seq DESC LIMIT 1",
        args: [gameId],
      });
      expect(afterRows.rows.length).toBe(1);
      const lastPayload = JSON.parse(String(afterRows.rows[0].payload)) as { timedOut?: boolean };
      expect(lastPayload.timedOut).toBe(true);
    });

    it('does not enforce (no-op) when turnTimerSeconds is disabled (<= 0), even for an ancient window', async () => {
      const created = await createGame(db, { displayName: 'Alice', rules: { turnTimerSeconds: 0 } });
      const j2 = await joinGame(db, created.roomCode, { displayName: 'Bob' });
      const j3 = await joinGame(db, created.roomCode, { displayName: 'Carol' });
      const j4 = await joinGame(db, created.roomCode, { displayName: 'Dave' });
      if ('error' in j2 || 'error' in j3 || 'error' in j4) {
        throw new Error('unexpected join error setting up fixture');
      }

      await db.execute({
        sql: `UPDATE actions SET created_at = ? WHERE game_id = ? AND action_type = 'start-hand'`,
        args: [Date.now() - 10 * 24 * 60 * 60 * 1000, created.gameId],
      });

      const response = await callState(created.roomCode, created.playerToken);
      const view = (await response.json()) as ClientGameView;

      expect(view.turnTimerSeconds).toBe(0);
      expect(view.turnDeadline).toBeNull();
      expect(view.phase?.type).toBe('awaiting-discard');

      const rows = await db.execute({ sql: 'SELECT COUNT(*) AS n FROM actions WHERE game_id = ?', args: [created.gameId] });
      expect(Number(rows.rows[0].n)).toBe(1);
    });
  });
});
