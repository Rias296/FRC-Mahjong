/**
 * Independent tester verification pass (2nd round): probes games.ts's
 * `joinGame` seat-assignment logic for the SAME bug class the review brief
 * asked to hunt for — a "read state, decide, write" race. joinGame reads
 * `occupiedSeats` via a SELECT, then deterministically picks the FIRST
 * unoccupied seat from [0,1,2,3], then INSERTs. Two truly concurrent callers
 * who both read the SAME `occupiedSeats` snapshot (before either INSERT
 * commits) will deterministically compute the SAME candidate seat — even if
 * a DIFFERENT seat is also genuinely open — so the loser collides on
 * UNIQUE(game_id, seat) and is told 'game-full', even though the game is
 * NOT actually full. This is not the data-corruption bug class (the schema's
 * UNIQUE(game_id, seat) constraint prevents any duplicate-seat corruption),
 * but it IS a genuine availability/correctness race: a real player can be
 * incorrectly rejected from a room that has open seats.
 */
import { createClient, type Client } from '@libsql/client';
import { describe, expect, it } from 'vitest';
import { runMigrations } from './migrations';
import { createGame, joinGame, listPlayers } from './games';

async function freshDb(): Promise<Client> {
  const db = createClient({ url: ':memory:' });
  await runMigrations(db);
  return db;
}

describe('joinGame under concurrent last-two-seats race (independent verification, not in original brief)', () => {
  it('two genuinely concurrent joins for the last two open seats: at most one may be incorrectly told game-full despite an open seat remaining', async () => {
    const db = await freshDb();
    const created = await createGame(db, { displayName: 'Alice' });
    await joinGame(db, created.roomCode, { displayName: 'Bob' });
    // Seats 0,1 filled; seats 2,3 open. Two concurrent joiners race for them.

    const [r1, r2] = await Promise.all([
      joinGame(db, created.roomCode, { displayName: 'Carol' }),
      joinGame(db, created.roomCode, { displayName: 'Dave' }),
    ]);

    const results = [r1, r2];
    const successes = results.filter((r) => !('error' in r));
    const gameFullErrors = results.filter((r) => 'error' in r && r.error === 'game-full');

    // Whatever happens, the DB itself must never end up corrupted: no two
    // players sharing a seat, no more than 4 players total.
    const players = await listPlayers(db, created.gameId);
    const seatSet = new Set(players.map((p) => p.seat));
    expect(seatSet.size).toBe(players.length); // no duplicate seats ever landed
    expect(players.length).toBeLessThanOrEqual(4);

    // Document actual behavior: if BOTH concurrent joins landed as
    // successes, the race is actually fine (no bug). If one came back
    // 'game-full' while the game still has an open seat afterward, that is
    // a genuine (non-corrupting) availability bug in the seat-picking logic.
    if (gameFullErrors.length > 0 && players.length < 4) {
      // A real open seat existed, but a real player was incorrectly turned
      // away. Flag this loudly rather than silently accepting it.
      throw new Error(
        `joinGame race bug reproduced: ${gameFullErrors.length} join(s) incorrectly rejected as ` +
          `'game-full' while the game only has ${players.length}/4 seats filled (a real seat was open). ` +
          `successes=${successes.length}`,
      );
    }
  });

  it('four fully concurrent joins for an empty 4-seat game all succeed with distinct seats (no corruption, no false rejections)', async () => {
    for (let run = 0; run < 5; run++) {
      const db = await freshDb();
      const created = await createGame(db, { displayName: 'Alice' });
      // Alice already occupies seat 0; race 3 more joiners for seats 1,2,3.
      const results = await Promise.all([
        joinGame(db, created.roomCode, { displayName: 'Bob' }),
        joinGame(db, created.roomCode, { displayName: 'Carol' }),
        joinGame(db, created.roomCode, { displayName: 'Dave' }),
      ]);

      const players = await listPlayers(db, created.gameId);
      const seatSet = new Set(players.map((p) => p.seat));
      expect(seatSet.size).toBe(players.length);
      expect(players.length).toBeLessThanOrEqual(4);

      const gameFullErrors = results.filter((r) => 'error' in r && r.error === 'game-full');
      if (gameFullErrors.length > 0 && players.length < 4) {
        throw new Error(
          `run ${run}: joinGame race bug reproduced under 3-way concurrency: ` +
            `${gameFullErrors.length} rejected as 'game-full' with only ${players.length}/4 seated`,
        );
      }
    }
  });
});
