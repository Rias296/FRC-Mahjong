import { createClient, type Client } from '@libsql/client';
import { describe, expect, it } from 'vitest';
import { runMigrations } from './migrations';
import { appendAction, appendStartHand, getLatestSeq, listActionsForGame, listActionsForHand } from './actions-log';
import type { GameAction } from '../engine/game-state';

async function freshDb(): Promise<Client> {
  const db = createClient({ url: ':memory:' });
  await runMigrations(db);
  return db;
}

async function seedGame(db: Client, gameId: string): Promise<void> {
  await db.execute({
    sql: `INSERT INTO games (id, room_code, status, rules_config, engine_version, created_at, updated_at)
          VALUES (?, ?, 'in-progress', '{}', '0.1.0', 1, 1)`,
    args: [gameId, gameId.slice(0, 6).toUpperCase().padEnd(6, 'X')],
  });
}

describe('actions-log', () => {
  it('assigns strictly increasing seq across mixed start-hand/action appends', async () => {
    const db = await freshDb();
    await seedGame(db, 'game1');

    const s1 = await appendStartHand(db, 'game1', {
      handNumber: 1,
      dealerSeat: 0,
      seed: 42,
      repeatCount: 0,
      prevailingWind: 'east',
    });
    const s2 = await appendAction(db, 'game1', 1, { type: 'draw', seat: 0 });
    const s3 = await appendAction(db, 'game1', 1, { type: 'discard', seat: 0, tileId: 'wan1-1' });

    expect(s1.seq).toBe(1);
    expect(s2.seq).toBe(2);
    expect(s3.seq).toBe(3);

    const latest = await getLatestSeq(db, 'game1');
    expect(latest).toBe(3);

    const rows = await listActionsForGame(db, 'game1');
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(rows.map((r) => r.actionType)).toEqual(['start-hand', 'draw', 'discard']);
  });

  it('getLatestSeq returns 0 for a game with no actions', async () => {
    const db = await freshDb();
    await seedGame(db, 'gameEmpty');
    expect(await getLatestSeq(db, 'gameEmpty')).toBe(0);
  });

  it('appendAction retries past a pre-existing row at the next seq (simulated race)', async () => {
    const db = await freshDb();
    await seedGame(db, 'game2');
    await appendStartHand(db, 'game2', {
      handNumber: 1,
      dealerSeat: 0,
      seed: 1,
      repeatCount: 0,
      prevailingWind: 'east',
    });

    // Simulate a concurrent writer landing at seq=2 first, before our
    // appendAction call below computes and tries to use that same seq.
    await db.execute({
      sql: `INSERT INTO actions (game_id, hand_number, seq, actor_seat, action_type, payload, created_at)
            VALUES ('game2', 1, 2, 0, 'draw', '{"type":"draw","seat":0}', 1)`,
    });

    const appended = await appendAction(db, 'game2', 1, { type: 'draw', seat: 1 });
    expect(appended.seq).toBe(3);

    const rows = await listActionsForHand(db, 'game2', 1);
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3]);
  });

  it('appendStartHand retries past a pre-existing row at the next seq (simulated race)', async () => {
    const db = await freshDb();
    await seedGame(db, 'game2b');
    await appendStartHand(db, 'game2b', {
      handNumber: 1,
      dealerSeat: 0,
      seed: 1,
      repeatCount: 0,
      prevailingWind: 'east',
    });

    // Simulate a concurrent writer landing at seq=2 first.
    await db.execute({
      sql: `INSERT INTO actions (game_id, hand_number, seq, actor_seat, action_type, payload, created_at)
            VALUES ('game2b', 1, 2, 0, 'draw', '{"type":"draw","seat":0}', 1)`,
    });

    const appended = await appendStartHand(db, 'game2b', {
      handNumber: 2,
      dealerSeat: 1,
      seed: 2,
      repeatCount: 0,
      prevailingWind: 'east',
    });
    expect(appended.seq).toBe(3);
  });

  it('appendStartHand no-ops (rather than inserting a duplicate) when a start-hand row for that hand already exists', async () => {
    const db = await freshDb();
    await seedGame(db, 'game2c');
    const first = await appendStartHand(db, 'game2c', {
      handNumber: 1,
      dealerSeat: 0,
      seed: 1,
      repeatCount: 0,
      prevailingWind: 'east',
    });

    // A second call for the SAME hand number (e.g. a racing caller that also
    // decided to start hand 1) must not create a second start-hand row; it
    // should resolve to the existing row's seq instead.
    const second = await appendStartHand(db, 'game2c', {
      handNumber: 1,
      dealerSeat: 2, // deliberately different payload to prove it's ignored
      seed: 999,
      repeatCount: 5,
      prevailingWind: 'north',
    });
    expect(second.seq).toBe(first.seq);

    const rows = await listActionsForHand(db, 'game2c', 1);
    const startHandRows = rows.filter((r) => r.actionType === 'start-hand');
    expect(startHandRows.length).toBe(1);
    expect(startHandRows[0].payload).toEqual({
      handNumber: 1,
      dealerSeat: 0,
      seed: 1,
      repeatCount: 0,
      prevailingWind: 'east',
    });
  });

  it('round-trips JSON payloads for each GameAction type', async () => {
    const db = await freshDb();
    await seedGame(db, 'game3');
    await appendStartHand(db, 'game3', {
      handNumber: 1,
      dealerSeat: 0,
      seed: 7,
      repeatCount: 0,
      prevailingWind: 'south',
    });

    const actions: GameAction[] = [
      { type: 'draw', seat: 0 },
      { type: 'discard', seat: 0, tileId: 'wan1-1' },
      { type: 'declare-hu', seat: 1 },
      { type: 'claim', seat: 1, claim: { type: 'pung' } },
      { type: 'claim', seat: 2, claim: { type: 'chow', tileIds: ['wan2-1', 'wan3-1'] } },
      { type: 'claim', seat: 3, claim: { type: 'kong' } },
      { type: 'claim', seat: 1, claim: { type: 'hu' } },
      { type: 'pass', seat: 3 },
      { type: 'declare-added-kong', seat: 0, tileId: 'tong5-1' },
      { type: 'declare-concealed-kong', seat: 0, kind: { category: 'suit', suit: 'wan', rank: 1 } },
      { type: 'declare-rob', seat: 1 },
    ];

    for (const action of actions) {
      await appendAction(db, 'game3', 1, action);
    }

    const rows = await listActionsForHand(db, 'game3', 1);
    const actionRows = rows.slice(1); // skip the start-hand row
    expect(actionRows.map((r) => r.payload)).toEqual(actions);
    expect(actionRows.map((r) => r.actorSeat)).toEqual(actions.map((a) => a.seat));
    expect(actionRows.map((r) => r.actionType)).toEqual(actions.map((a) => a.type));
  });

  it('listActionsForHand filters to only the requested hand', async () => {
    const db = await freshDb();
    await seedGame(db, 'game4');
    await appendStartHand(db, 'game4', {
      handNumber: 1,
      dealerSeat: 0,
      seed: 1,
      repeatCount: 0,
      prevailingWind: 'east',
    });
    await appendAction(db, 'game4', 1, { type: 'draw', seat: 0 });
    await appendStartHand(db, 'game4', {
      handNumber: 2,
      dealerSeat: 1,
      seed: 2,
      repeatCount: 0,
      prevailingWind: 'east',
    });
    await appendAction(db, 'game4', 2, { type: 'draw', seat: 1 });

    const hand1Rows = await listActionsForHand(db, 'game4', 1);
    const hand2Rows = await listActionsForHand(db, 'game4', 2);
    expect(hand1Rows.map((r) => r.handNumber)).toEqual([1, 1]);
    expect(hand2Rows.map((r) => r.handNumber)).toEqual([2, 2]);
  });
});
