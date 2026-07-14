/**
 * Independent tester verification pass (2nd round), item 6: directly probes
 * migrations/0002_start_hand_unique.sql's partial UNIQUE index
 * (`ON actions(game_id, hand_number) WHERE action_type = 'start-hand'`)
 * against the REAL :memory: libsql driver used by the whole test suite (not
 * merely "does CREATE INDEX not throw") to confirm:
 *   1. Genuine duplicates (same game_id + hand_number + action_type =
 *      'start-hand') are rejected at the DB layer.
 *   2. Different hand_number values for the SAME game are NOT blocked by
 *      this index — a real multi-hand game must be able to insert hand 1,
 *      hand 2, hand 3, ... start-hand rows without any of them colliding.
 *   3. The partial WHERE clause genuinely scopes the uniqueness to
 *      action_type = 'start-hand' only: two non-start-hand rows sharing
 *      (game_id, hand_number) are fine (this table intentionally holds many
 *      action rows per hand), and are NOT affected by this index at all.
 */
import { createClient, type Client } from '@libsql/client';
import { describe, expect, it } from 'vitest';
import { runMigrations } from './migrations';
import { DEFAULT_RULES } from '../engine/rules-config';

async function freshDb(): Promise<Client> {
  const db = createClient({ url: ':memory:' });
  await runMigrations(db);
  return db;
}

async function seedGameRow(db: Client, gameId: string): Promise<void> {
  await db.execute({
    sql: `INSERT INTO games (id, room_code, status, rules_config, engine_version, created_at, updated_at)
          VALUES (?, ?, 'in-progress', ?, '0.1.0', 1, 1)`,
    args: [gameId, gameId.slice(0, 6).toUpperCase().padEnd(6, 'X'), JSON.stringify(DEFAULT_RULES)],
  });
}

describe('migrations/0002_start_hand_unique.sql partial UNIQUE index — direct DB-layer verification', () => {
  it('allows a full 5-hand sequence of start-hand rows for the same game (different hand_number each) with no false collisions', async () => {
    const db = await freshDb();
    await seedGameRow(db, 'multi1');

    for (let hand = 1; hand <= 5; hand++) {
      await db.execute({
        sql: `INSERT INTO actions (game_id, hand_number, seq, actor_seat, action_type, payload, created_at)
              VALUES (?, ?, ?, NULL, 'start-hand', ?, ?)`,
        args: ['multi1', hand, hand, JSON.stringify({ handNumber: hand, dealerSeat: 0, seed: hand, repeatCount: 0, prevailingWind: 'east' }), 1],
      });
    }

    const rows = await db.execute({
      sql: `SELECT hand_number FROM actions WHERE game_id = ? AND action_type = 'start-hand' ORDER BY hand_number ASC`,
      args: ['multi1'],
    });
    expect(rows.rows.map((r) => Number(r.hand_number))).toEqual([1, 2, 3, 4, 5]);
  });

  it('rejects a genuine duplicate start-hand row for the SAME hand_number', async () => {
    const db = await freshDb();
    await seedGameRow(db, 'dup1');
    await db.execute({
      sql: `INSERT INTO actions (game_id, hand_number, seq, actor_seat, action_type, payload, created_at)
            VALUES ('dup1', 1, 1, NULL, 'start-hand', '{}', 1)`,
    });

    await expect(
      db.execute({
        sql: `INSERT INTO actions (game_id, hand_number, seq, actor_seat, action_type, payload, created_at)
              VALUES ('dup1', 1, 2, NULL, 'start-hand', '{}', 1)`,
      }),
    ).rejects.toThrow(/UNIQUE constraint/);
  });

  it('does NOT block two different games from each having their own hand-1 start-hand row (index is scoped per game_id too)', async () => {
    const db = await freshDb();
    await seedGameRow(db, 'gameA');
    await seedGameRow(db, 'gameB');

    await db.execute({
      sql: `INSERT INTO actions (game_id, hand_number, seq, actor_seat, action_type, payload, created_at)
            VALUES ('gameA', 1, 1, NULL, 'start-hand', '{}', 1)`,
    });
    // Must not throw: different game_id, same hand_number.
    await expect(
      db.execute({
        sql: `INSERT INTO actions (game_id, hand_number, seq, actor_seat, action_type, payload, created_at)
              VALUES ('gameB', 1, 1, NULL, 'start-hand', '{}', 1)`,
      }),
    ).resolves.toBeDefined();
  });

  it('does not affect non-start-hand rows sharing (game_id, hand_number) — many actions per hand remain fully unrestricted', async () => {
    const db = await freshDb();
    await seedGameRow(db, 'many1');
    await db.execute({
      sql: `INSERT INTO actions (game_id, hand_number, seq, actor_seat, action_type, payload, created_at)
            VALUES ('many1', 1, 1, NULL, 'start-hand', '{}', 1)`,
    });

    // Many discard/draw/pass rows for the SAME (game_id, hand_number),
    // none of them action_type = 'start-hand' — the partial index must not
    // touch these at all.
    for (let seq = 2; seq <= 10; seq++) {
      await expect(
        db.execute({
          sql: `INSERT INTO actions (game_id, hand_number, seq, actor_seat, action_type, payload, created_at)
                VALUES ('many1', 1, ?, 0, 'draw', '{"type":"draw","seat":0}', 1)`,
          args: [seq],
        }),
      ).resolves.toBeDefined();
    }

    const rows = await db.execute({
      sql: `SELECT COUNT(*) AS n FROM actions WHERE game_id = ? AND hand_number = 1`,
      args: ['many1'],
    });
    expect(Number(rows.rows[0].n)).toBe(10);
  });
});
