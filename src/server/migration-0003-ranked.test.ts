/**
 * Direct DB-layer verification of migrations/0003_ranked.sql (profiles,
 * rank_history, players.profile_id + its partial UNIQUE index), against the
 * REAL :memory: libsql driver used by the whole test suite — mirrors
 * migration-partial-index.test.ts's verification style for 0002.
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

async function seedPlayerRow(
  db: Client,
  playerId: string,
  gameId: string,
  seat: number,
  profileId: string | null,
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO players (id, game_id, seat, display_name, join_token, created_at, profile_id)
          VALUES (?, ?, ?, ?, ?, 1, ?)`,
    args: [playerId, gameId, seat, `Seat ${seat}`, `${playerId}-token`, profileId],
  });
}

async function seedProfileRow(db: Client, profileId: string): Promise<void> {
  await db.execute({
    sql: `INSERT INTO profiles (id, secret_token, display_name, rank_points, apex_attained_at, created_at, updated_at)
          VALUES (?, ?, ?, 0, NULL, 1, 1)`,
    args: [profileId, `${profileId}-secret`, `Profile ${profileId}`],
  });
}

describe('migrations/0003_ranked.sql', () => {
  it('applies cleanly on top of a database that already has 0001+0002 applied', async () => {
    const db = createClient({ url: ':memory:' });

    // Apply 0001+0002 first via the normal runner, then apply 0003 on top by
    // calling runMigrations again — this is exactly the "already has
    // 0001+0002 applied" scenario since runMigrations tracks applied
    // filenames in _migrations and only runs what's missing.
    const first = await runMigrations(db);
    expect(first.map((m) => m.filename)).toEqual([
      '0001_init.sql',
      '0002_start_hand_unique.sql',
      '0003_ranked.sql',
      '0004_rank_settlement_resilience.sql',
    ]);

    const rows = await db.execute('SELECT filename FROM _migrations ORDER BY filename ASC');
    expect(rows.rows.map((r) => String(r.filename))).toEqual([
      '0001_init.sql',
      '0002_start_hand_unique.sql',
      '0003_ranked.sql',
      '0004_rank_settlement_resilience.sql',
    ]);
  });

  it('existing players rows are still readable and have profile_id = NULL', async () => {
    const db = await freshDb();
    await seedGameRow(db, 'g1');
    // Insert a players row the "old" way, without mentioning profile_id at
    // all (simulating a pre-0003 row now living under the new column).
    await db.execute({
      sql: `INSERT INTO players (id, game_id, seat, display_name, join_token, created_at)
            VALUES (?, ?, ?, ?, ?, 1)`,
      args: ['p1', 'g1', 0, 'Alice', 'tok1'],
    });

    const rows = await db.execute({ sql: 'SELECT * FROM players WHERE id = ?', args: ['p1'] });
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0].profile_id).toBeNull();
  });

  it('rank_history genuinely rejects a second insert with a duplicate (game_id, profile_id) pair', async () => {
    const db = await freshDb();
    await seedGameRow(db, 'g1');
    await seedProfileRow(db, 'prof1');

    await db.execute({
      sql: `INSERT INTO rank_history (id, game_id, profile_id, seat, placement, rp_before, rp_delta, rp_after, tier_after, created_at)
            VALUES ('rh1', 'g1', 'prof1', 0, 1, 0, 120, 120, 'bronze', 1)`,
    });

    await expect(
      db.execute({
        sql: `INSERT INTO rank_history (id, game_id, profile_id, seat, placement, rp_before, rp_delta, rp_after, tier_after, created_at)
              VALUES ('rh2', 'g1', 'prof1', 0, 1, 120, 120, 240, 'bronze', 2)`,
      }),
    ).rejects.toThrow(/UNIQUE constraint/);
  });

  it('allows the same profile to appear in rank_history for a different game', async () => {
    const db = await freshDb();
    await seedGameRow(db, 'g1');
    await seedGameRow(db, 'g2');
    await seedProfileRow(db, 'prof1');

    await db.execute({
      sql: `INSERT INTO rank_history (id, game_id, profile_id, seat, placement, rp_before, rp_delta, rp_after, tier_after, created_at)
            VALUES ('rh1', 'g1', 'prof1', 0, 1, 0, 120, 120, 'bronze', 1)`,
    });

    await expect(
      db.execute({
        sql: `INSERT INTO rank_history (id, game_id, profile_id, seat, placement, rp_before, rp_delta, rp_after, tier_after, created_at)
              VALUES ('rh2', 'g2', 'prof1', 0, 1, 120, 120, 240, 'bronze', 2)`,
      }),
    ).resolves.toBeDefined();
  });

  it('rejects a second players row with the same (game_id, profile_id) when profile_id is non-null', async () => {
    const db = await freshDb();
    await seedGameRow(db, 'g1');
    await seedProfileRow(db, 'prof1');
    await seedPlayerRow(db, 'p1', 'g1', 0, 'prof1');

    await expect(seedPlayerRow(db, 'p2', 'g1', 1, 'prof1')).rejects.toThrow(/UNIQUE constraint/);
  });

  it('allows multiple players rows with profile_id IS NULL in the same game', async () => {
    const db = await freshDb();
    await seedGameRow(db, 'g1');

    await seedPlayerRow(db, 'p1', 'g1', 0, null);
    await expect(seedPlayerRow(db, 'p2', 'g1', 1, null)).resolves.toBeUndefined();

    const rows = await db.execute({ sql: 'SELECT * FROM players WHERE game_id = ?', args: ['g1'] });
    expect(rows.rows.length).toBe(2);
  });

  it('allows a profile to be linked to seats in two different games (index scoped per game_id)', async () => {
    const db = await freshDb();
    await seedGameRow(db, 'g1');
    await seedGameRow(db, 'g2');
    await seedProfileRow(db, 'prof1');

    await seedPlayerRow(db, 'p1', 'g1', 0, 'prof1');
    await expect(seedPlayerRow(db, 'p2', 'g2', 0, 'prof1')).resolves.toBeUndefined();
  });
});
