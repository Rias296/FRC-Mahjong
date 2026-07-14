/**
 * Tester's closing verification pass for Phase 3 round 1. Independently
 * re-derives the joinGame fix from scratch (not trusting the builder's
 * report), then pushes past the existing join-race.test.ts coverage with:
 *
 *   1. 4 fully concurrent joins into a brand-new empty game, where one of
 *      the 4 "joiners" is a duplicate display name (not a distinct player),
 *      to confirm display-name uniqueness / token issuance is unaffected by
 *      the seat-retry race.
 *   2. 5 concurrent join attempts into a game that already has 3/4 seats
 *      filled (only 1 seat open): exactly 1 must succeed and the other 4
 *      must correctly get 'game-full' (the game genuinely IS full after the
 *      1st succeeds, so these are NOT false rejections).
 *   3. The 4th-seat-fills-the-game transactional start-hand append under the
 *      new retry-based joinGame: races the last two joins for the last two
 *      open seats and checks not just "no corruption" (already covered by
 *      join-race.test.ts) but that the game actually transitions to
 *      in-progress exactly once, with exactly one start-hand row at seq 1,
 *      and that a full replay via getCurrentHandState succeeds afterward.
 */
import { createClient, type Client } from '@libsql/client';
import { describe, expect, it } from 'vitest';
import { runMigrations } from './migrations';
import { createGame, joinGame, listPlayers, getGameByRoomCode } from './games';
import { getCurrentHandState } from './replay';
import { SEATS } from '../engine/seats';

async function freshDb(): Promise<Client> {
  const db = createClient({ url: ':memory:' });
  await runMigrations(db);
  return db;
}

describe('joinGame: 4-way concurrent join into empty game, one joiner uses a duplicate display name', () => {
  it('all 4 seats fill with distinct seats/tokens; the duplicate display name does not corrupt seat assignment or token issuance', async () => {
    for (let run = 0; run < 5; run++) {
      const db = await freshDb();
      const created = await createGame(db, { displayName: 'Alice' });
      // Alice already occupies seat 0. Race 3 more joiners for seats 1,2,3 —
      // one of them ("Alice-dup") deliberately reuses Alice's display name to
      // confirm display-name collisions don't interact badly with the seat
      // race (schema has no UNIQUE constraint on display_name, but the seat
      // retry loop and token generation must still behave correctly).
      const results = await Promise.all([
        joinGame(db, created.roomCode, { displayName: 'Alice' }), // duplicate name
        joinGame(db, created.roomCode, { displayName: 'Carol' }),
        joinGame(db, created.roomCode, { displayName: 'Dave' }),
      ]);

      for (const r of results) {
        expect('error' in r).toBe(false);
      }

      const players = await listPlayers(db, created.gameId);
      expect(players.length).toBe(4);
      const seatSet = new Set(players.map((p) => p.seat));
      expect(seatSet.size).toBe(4);
      expect([...seatSet].sort()).toEqual([0, 1, 2, 3]);

      // Two players share the display name "Alice" (seat 0's original + the
      // duplicate joiner) — that must be allowed, and each must have gotten
      // a DISTINCT, valid seat and a distinct token.
      const aliceNamed = players.filter((p) => p.displayName === 'Alice');
      expect(aliceNamed.length).toBe(2);

      const tokens = new Set(
        results
          .filter((r): r is Exclude<typeof r, { error: string }> => !('error' in r))
          .map((r) => r.playerToken),
      );
      expect(tokens.size).toBe(3); // 3 successful joiners, 3 distinct tokens

      // Game must have flipped to in-progress since all 4 seats are filled.
      const game = await getGameByRoomCode(db, created.roomCode);
      expect(game?.status).toBe('in-progress');
    }
  });
});

describe('joinGame: 5 concurrent joins into a game with 3/4 seats already filled', () => {
  it('exactly 1 succeeds (taking the last seat) and the other 4 correctly get game-full', async () => {
    for (let run = 0; run < 5; run++) {
      const db = await freshDb();
      const created = await createGame(db, { displayName: 'P0' });
      await joinGame(db, created.roomCode, { displayName: 'P1' });
      await joinGame(db, created.roomCode, { displayName: 'P2' });
      // Seats 0,1,2 filled; seat 3 is the ONLY open seat. 5 concurrent
      // joiners race for it.
      const results = await Promise.all([
        joinGame(db, created.roomCode, { displayName: 'Q0' }),
        joinGame(db, created.roomCode, { displayName: 'Q1' }),
        joinGame(db, created.roomCode, { displayName: 'Q2' }),
        joinGame(db, created.roomCode, { displayName: 'Q3' }),
        joinGame(db, created.roomCode, { displayName: 'Q4' }),
      ]);

      const successes = results.filter((r) => !('error' in r));
      // The single winning join fills the 4th seat and, in the SAME call,
      // synchronously flips the game to 'in-progress' (resolveInitialGameStart
      // runs before that joinGame call returns). So by the time any losing
      // concurrent attempt loops back to its fresh per-attempt status read,
      // it observes status === 'in-progress' and correctly returns
      // 'already-started' rather than 'game-full' — per the documented
      // contract in games.test.ts ("returns already-started on a 5th join
      // once the game has naturally started"; 'game-full' is reserved for
      // the defensive case of 4 occupied seats on a game whose status is
      // still, corruptly, 'waiting-for-players'). Both codes mean "you did
      // not get a seat, and rightly so" — accept either here, since which
      // one is used is an implementation detail of exactly when this
      // particular attempt's status read lands relative to the winner's
      // write, not a correctness distinction this test cares about.
      const rejections = results.filter(
        (r) => 'error' in r && (r.error === 'game-full' || r.error === 'already-started'),
      );

      expect(successes.length).toBe(1);
      expect(rejections.length).toBe(4);

      const players = await listPlayers(db, created.gameId);
      expect(players.length).toBe(4);
      const seatSet = new Set(players.map((p) => p.seat));
      expect(seatSet.size).toBe(4);

      const game = await getGameByRoomCode(db, created.roomCode);
      expect(game?.status).toBe('in-progress');
    }
  });
});

describe('joinGame: 4th-seat-fill transactional start-hand append under concurrent last-two-seat race', () => {
  it('races the last two seats concurrently; exactly one start-hand event lands at seq 1, status flips to in-progress exactly once, and the hand is genuinely replayable/playable afterward', async () => {
    for (let run = 0; run < 8; run++) {
      const db = await freshDb();
      const created = await createGame(db, { displayName: 'Alice' });
      await joinGame(db, created.roomCode, { displayName: 'Bob' });
      // Seats 0,1 filled; seats 2,3 open. Race the LAST two joins
      // concurrently — this is the scenario where each joiner's locally
      // read `occupiedSeats.size` (captured before either INSERT commits)
      // can independently under-count the post-insert total, since both
      // succeed against DIFFERENT seats (no UNIQUE collision to force a
      // retry-with-fresh-read for either of them).
      const [r1, r2] = await Promise.all([
        joinGame(db, created.roomCode, { displayName: 'Carol' }),
        joinGame(db, created.roomCode, { displayName: 'Dave' }),
      ]);

      for (const r of [r1, r2]) {
        expect('error' in r).toBe(false);
      }

      const players = await listPlayers(db, created.gameId);
      expect(players.length).toBe(4);
      const seatSet = new Set(players.map((p) => p.seat));
      expect(seatSet.size).toBe(4);

      // The game must have genuinely transitioned to in-progress...
      const game = await getGameByRoomCode(db, created.roomCode);
      expect(
        game?.status,
        `run ${run}: game did not transition to in-progress after all 4 seats filled ` +
          `(status is still '${game?.status}') — the 4th-seat-fill trigger was likely missed ` +
          `under the concurrent last-two-join race`,
      ).toBe('in-progress');

      // ...with EXACTLY one start-hand row at seq 1 (not zero, not two).
      const actionsRow = await db.execute({
        sql: `SELECT seq, action_type FROM actions WHERE game_id = ? ORDER BY seq ASC`,
        args: [created.gameId],
      });
      const startHandRows = actionsRow.rows.filter((r) => String(r.action_type) === 'start-hand');
      expect(
        startHandRows.length,
        `run ${run}: expected exactly 1 start-hand row, found ${startHandRows.length}`,
      ).toBe(1);
      expect(Number(startHandRows[0].seq)).toBe(1);

      // ...and the hand is genuinely playable: a full replay succeeds and
      // shows a valid dealer's opening hand. In this 16-tile Taiwanese
      // variant, deal() gives ALL FOUR seats 16 concealed tiles (see
      // src/engine/deal.ts); the dealer (seat 0) then immediately draws
      // their opening 17th tile as part of startHand, landing in phase
      // 'awaiting-discard' with 17 concealed tiles (16 if a pathological
      // seed hit an immediate exhaustive-draw/hand-over instead — handled
      // defensively below rather than assumed away).
      const current = await getCurrentHandState(db, created.gameId);
      expect(current).not.toBeNull();
      expect(current?.handNumber).toBe(1);
      const dealerExpected = current!.state.phase.type === 'awaiting-discard' ? 17 : 16;
      for (const seat of SEATS) {
        const concealedCount = current!.state.players[seat].hand.concealedTiles.length;
        const expected = seat === 0 ? dealerExpected : 16;
        expect(
          concealedCount,
          `run ${run}: seat ${seat} has ${concealedCount} concealed tiles, expected ${expected} ` +
            `(phase=${current!.state.phase.type})`,
        ).toBe(expected);
      }
    }
  });

  it('4-way fully-concurrent join into a brand-new empty game (no staged seats) also converges to exactly one start-hand + in-progress', async () => {
    for (let run = 0; run < 8; run++) {
      const db = await freshDb();
      const created = await createGame(db, { displayName: 'Alice' });
      // Alice occupies seat 0 already (createGame is not part of the raced
      // seat-assignment path). Race 3 concurrent joiners for seats 1,2,3 —
      // this is the maximal-concurrency variant of the same race.
      const results = await Promise.all([
        joinGame(db, created.roomCode, { displayName: 'Bob' }),
        joinGame(db, created.roomCode, { displayName: 'Carol' }),
        joinGame(db, created.roomCode, { displayName: 'Dave' }),
      ]);

      for (const r of results) {
        expect('error' in r).toBe(false);
      }

      const game = await getGameByRoomCode(db, created.roomCode);
      expect(
        game?.status,
        `run ${run}: game did not transition to in-progress (status='${game?.status}') after a fully ` +
          `concurrent 3-way join filled all 4 seats`,
      ).toBe('in-progress');

      const actionsRow = await db.execute({
        sql: `SELECT seq, action_type FROM actions WHERE game_id = ? ORDER BY seq ASC`,
        args: [created.gameId],
      });
      const startHandRows = actionsRow.rows.filter((r) => String(r.action_type) === 'start-hand');
      expect(
        startHandRows.length,
        `run ${run}: expected exactly 1 start-hand row, found ${startHandRows.length}`,
      ).toBe(1);

      const current = await getCurrentHandState(db, created.gameId);
      expect(current).not.toBeNull();
      expect(current?.handNumber).toBe(1);
    }
  });
});
