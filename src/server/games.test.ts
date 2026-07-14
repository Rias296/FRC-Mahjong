import { createClient, type Client } from '@libsql/client';
import { describe, expect, it } from 'vitest';
import { runMigrations } from './migrations';
import { createGame, getGameByRoomCode, joinGame, listPlayers, resolvePlayerToken } from './games';
import { DEFAULT_RULES } from '../engine/rules-config';

async function freshDb(): Promise<Client> {
  const db = createClient({ url: ':memory:' });
  await runMigrations(db);
  return db;
}

describe('createGame', () => {
  it('generates a valid room code and seats the creator at seat 0', async () => {
    const db = await freshDb();
    const result = await createGame(db, { displayName: 'Alice' });

    expect(result.roomCode).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
    expect(result.seat).toBe(0);
    expect(result.rules).toEqual(DEFAULT_RULES);
    expect(result.playerToken.length).toBeGreaterThan(0);

    const fetched = await getGameByRoomCode(db, result.roomCode);
    expect(fetched?.status).toBe('waiting-for-players');
    expect(fetched?.gameId).toBe(result.gameId);
  });

  it('merges partial rule overrides over DEFAULT_RULES', async () => {
    const db = await freshDb();
    const result = await createGame(db, { displayName: 'Alice', rules: { minTaiToWin: 3 } });
    expect(result.rules.minTaiToWin).toBe(3);
    expect(result.rules.basePoints).toBe(DEFAULT_RULES.basePoints);
  });

  it('generates distinct room codes across many games', async () => {
    const db = await freshDb();
    const codes = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const result = await createGame(db, { displayName: `Player${i}` });
      codes.add(result.roomCode);
    }
    expect(codes.size).toBe(20);
  });
});

describe('joinGame', () => {
  it('fills seats 0..3 in order and flips status to in-progress with a hand-1 start-hand event on the 4th join', async () => {
    const db = await freshDb();
    const created = await createGame(db, { displayName: 'Alice' });

    const j2 = await joinGame(db, created.roomCode, { displayName: 'Bob' });
    const j3 = await joinGame(db, created.roomCode, { displayName: 'Carol' });
    const j4 = await joinGame(db, created.roomCode, { displayName: 'Dave' });

    if ('error' in j2 || 'error' in j3 || 'error' in j4) {
      throw new Error('unexpected join error');
    }
    expect(j2.seat).toBe(1);
    expect(j3.seat).toBe(2);
    expect(j4.seat).toBe(3);
    expect(j4.status).toBe('in-progress');

    const fetched = await getGameByRoomCode(db, created.roomCode);
    expect(fetched?.status).toBe('in-progress');

    const actionsRow = await db.execute({
      sql: 'SELECT seq, hand_number, actor_seat, action_type, payload FROM actions WHERE game_id = ?',
      args: [created.gameId],
    });
    expect(actionsRow.rows.length).toBe(1);
    expect(actionsRow.rows[0].seq).toBe(1);
    expect(actionsRow.rows[0].actor_seat).toBeNull();
    expect(actionsRow.rows[0].action_type).toBe('start-hand');

    const payload = JSON.parse(String(actionsRow.rows[0].payload)) as {
      handNumber: number;
      dealerSeat: number;
      repeatCount: number;
      prevailingWind: string;
      seed: number;
    };
    expect(payload.handNumber).toBe(1);
    expect(payload.dealerSeat).toBe(0);
    expect(payload.repeatCount).toBe(0);
    expect(payload.prevailingWind).toBe('east');
    expect(typeof payload.seed).toBe('number');

    const players = await listPlayers(db, created.gameId);
    expect(players).toEqual([
      { seat: 0, displayName: 'Alice' },
      { seat: 1, displayName: 'Bob' },
      { seat: 2, displayName: 'Carol' },
      { seat: 3, displayName: 'Dave' },
    ]);
  });

  it('returns already-started on a 5th join once the game has naturally started', async () => {
    const db = await freshDb();
    const created = await createGame(db, { displayName: 'Alice' });
    await joinGame(db, created.roomCode, { displayName: 'Bob' });
    await joinGame(db, created.roomCode, { displayName: 'Carol' });
    await joinGame(db, created.roomCode, { displayName: 'Dave' });

    const fifth = await joinGame(db, created.roomCode, { displayName: 'Eve' });
    expect(fifth).toEqual({ error: 'already-started' });
  });

  it('defends against a corrupted waiting-for-players game with 4 seats already filled (returns game-full)', async () => {
    const db = await freshDb();
    const created = await createGame(db, { displayName: 'Alice' });
    await joinGame(db, created.roomCode, { displayName: 'Bob' });
    await joinGame(db, created.roomCode, { displayName: 'Carol' });
    await joinGame(db, created.roomCode, { displayName: 'Dave' });

    // Simulate corruption: force status back to waiting-for-players despite
    // all 4 seats being filled (shouldn't happen via the normal join path).
    await db.execute({
      sql: `UPDATE games SET status = 'waiting-for-players' WHERE id = ?`,
      args: [created.gameId],
    });

    const fifth = await joinGame(db, created.roomCode, { displayName: 'Eve' });
    expect(fifth).toEqual({ error: 'game-full' });
  });

  it('returns not-found for an unknown room code', async () => {
    const db = await freshDb();
    const result = await joinGame(db, 'ZZZZZZ', { displayName: 'Nobody' });
    expect(result).toEqual({ error: 'not-found' });
  });
});

describe('resolvePlayerToken', () => {
  it('round-trips seat/game for a known token, and returns null for an unknown token', async () => {
    const db = await freshDb();
    const created = await createGame(db, { displayName: 'Alice' });

    const resolved = await resolvePlayerToken(db, created.playerToken);
    expect(resolved).toEqual({ gameId: created.gameId, seat: 0 });

    const unknown = await resolvePlayerToken(db, 'not-a-real-token');
    expect(unknown).toBeNull();
  });

  it('resolves each joined player to their own seat', async () => {
    const db = await freshDb();
    const created = await createGame(db, { displayName: 'Alice' });
    const j2 = await joinGame(db, created.roomCode, { displayName: 'Bob' });
    if ('error' in j2) throw new Error('unexpected join error');

    const resolved = await resolvePlayerToken(db, j2.playerToken);
    expect(resolved).toEqual({ gameId: created.gameId, seat: 1 });
  });
});
