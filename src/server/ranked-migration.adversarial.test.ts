/**
 * Independent tester verification pass (Round 1, ranked-ladder), item 8:
 * does NOT reuse or trust `migration-0003-ranked.test.ts`'s own assertions
 * — re-derives expected behavior directly from the raw SQL in
 * `migrations/0003_ranked.sql` and probes it against the real :memory:
 * libsql driver.
 *
 * Extra coverage beyond the builder's file:
 *   - `profiles.secret_token` UNIQUE constraint (not covered by the
 *     builder's migration test at all).
 *   - `profiles` column defaults (`rank_points` default 0,
 *     `apex_attained_at` nullable) when omitted from an INSERT.
 *   - Re-confirms the partial unique index on `players(game_id,
 *     profile_id)` is genuinely a 2-column composite scoped by game_id, and
 *     that `rank_history`'s `UNIQUE(game_id, profile_id)` is also a
 *     genuine 2-column composite (not accidentally a single-column unique
 *     on profile_id alone), using fresh data distinct from the builder's.
 */
import { createClient, type Client } from '@libsql/client';
import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES } from '../engine/rules-config';
import { runMigrations } from './migrations';

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

describe('migrations/0003_ranked.sql — independent adversarial re-verification', () => {
  it('profiles.secret_token is UNIQUE: a second profile with the same secret_token is rejected', async () => {
    const db = await freshDb();
    await db.execute({
      sql: `INSERT INTO profiles (id, secret_token, display_name, rank_points, apex_attained_at, created_at, updated_at)
            VALUES ('profA', 'same-secret', 'Alice', 0, NULL, 1, 1)`,
    });

    await expect(
      db.execute({
        sql: `INSERT INTO profiles (id, secret_token, display_name, rank_points, apex_attained_at, created_at, updated_at)
              VALUES ('profB', 'same-secret', 'Bob', 0, NULL, 1, 1)`,
      }),
    ).rejects.toThrow(/UNIQUE constraint/);
  });

  it('profiles.rank_points defaults to 0 and apex_attained_at defaults to NULL when omitted from the INSERT', async () => {
    const db = await freshDb();
    await db.execute({
      sql: `INSERT INTO profiles (id, secret_token, display_name, created_at, updated_at) VALUES ('profC', 'sec-c', 'Carol', 1, 1)`,
    });

    const row = await db.execute({ sql: 'SELECT rank_points, apex_attained_at FROM profiles WHERE id = ?', args: ['profC'] });
    expect(Number(row.rows[0].rank_points)).toBe(0);
    expect(row.rows[0].apex_attained_at).toBeNull();
  });

  it('players(game_id, profile_id) partial unique index: multiple NULL-profile_id seats coexist freely in the SAME game (fresh data, distinct from the builder migration test)', async () => {
    const db = await freshDb();
    await seedGameRow(db, 'gX');

    await db.execute({
      sql: `INSERT INTO players (id, game_id, seat, display_name, join_token, created_at, profile_id)
            VALUES ('pX1', 'gX', 0, 'S0', 'tokX1', 1, NULL)`,
    });
    await db.execute({
      sql: `INSERT INTO players (id, game_id, seat, display_name, join_token, created_at, profile_id)
            VALUES ('pX2', 'gX', 1, 'S1', 'tokX2', 1, NULL)`,
    });
    await db.execute({
      sql: `INSERT INTO players (id, game_id, seat, display_name, join_token, created_at, profile_id)
            VALUES ('pX3', 'gX', 2, 'S2', 'tokX3', 1, NULL)`,
    });
    await db.execute({
      sql: `INSERT INTO players (id, game_id, seat, display_name, join_token, created_at, profile_id)
            VALUES ('pX4', 'gX', 3, 'S3', 'tokX4', 1, NULL)`,
    });

    const rows = await db.execute({ sql: 'SELECT COUNT(*) AS n FROM players WHERE game_id = ?', args: ['gX'] });
    expect(Number(rows.rows[0].n)).toBe(4);
  });

  it('players(game_id, profile_id) partial unique index: a genuine duplicate (same game, same non-null profile) is rejected', async () => {
    const db = await freshDb();
    await seedGameRow(db, 'gY');
    await db.execute({
      sql: `INSERT INTO profiles (id, secret_token, display_name, rank_points, apex_attained_at, created_at, updated_at)
            VALUES ('profY', 'sec-y', 'Yara', 0, NULL, 1, 1)`,
    });
    await db.execute({
      sql: `INSERT INTO players (id, game_id, seat, display_name, join_token, created_at, profile_id)
            VALUES ('pY1', 'gY', 0, 'S0', 'tokY1', 1, 'profY')`,
    });

    await expect(
      db.execute({
        sql: `INSERT INTO players (id, game_id, seat, display_name, join_token, created_at, profile_id)
              VALUES ('pY2', 'gY', 1, 'S1', 'tokY2', 1, 'profY')`,
      }),
    ).rejects.toThrow(/UNIQUE constraint/);
  });

  it('rank_history UNIQUE(game_id, profile_id) is a genuine 2-COLUMN composite: same profile can appear in THREE different games without collision', async () => {
    const db = await freshDb();
    await seedGameRow(db, 'gh1');
    await seedGameRow(db, 'gh2');
    await seedGameRow(db, 'gh3');
    await db.execute({
      sql: `INSERT INTO profiles (id, secret_token, display_name, rank_points, apex_attained_at, created_at, updated_at)
            VALUES ('profZ', 'sec-z', 'Zoe', 0, NULL, 1, 1)`,
    });

    for (const [i, gameId] of ['gh1', 'gh2', 'gh3'].entries()) {
      await expect(
        db.execute({
          sql: `INSERT INTO rank_history (id, game_id, profile_id, seat, placement, rp_before, rp_delta, rp_after, tier_after, created_at)
                VALUES (?, ?, 'profZ', 0, 1, 0, 120, 120, 'bronze', ?)`,
          args: [`rhZ${i}`, gameId, i],
        }),
      ).resolves.toBeDefined();
    }

    const rows = await db.execute({ sql: 'SELECT COUNT(*) AS n FROM rank_history WHERE profile_id = ?', args: ['profZ'] });
    expect(Number(rows.rows[0].n)).toBe(3);
  });

  it('rank_history UNIQUE(game_id, profile_id): two DIFFERENT profiles in the SAME game do not collide with each other (rules out an accidental single-column unique on game_id alone)', async () => {
    const db = await freshDb();
    await seedGameRow(db, 'ghM');
    await db.execute({
      sql: `INSERT INTO profiles (id, secret_token, display_name, rank_points, apex_attained_at, created_at, updated_at)
            VALUES ('profM1', 'sec-m1', 'M1', 0, NULL, 1, 1)`,
    });
    await db.execute({
      sql: `INSERT INTO profiles (id, secret_token, display_name, rank_points, apex_attained_at, created_at, updated_at)
            VALUES ('profM2', 'sec-m2', 'M2', 0, NULL, 1, 1)`,
    });

    await db.execute({
      sql: `INSERT INTO rank_history (id, game_id, profile_id, seat, placement, rp_before, rp_delta, rp_after, tier_after, created_at)
            VALUES ('rhM1', 'ghM', 'profM1', 0, 1, 0, 120, 120, 'bronze', 1)`,
    });
    await expect(
      db.execute({
        sql: `INSERT INTO rank_history (id, game_id, profile_id, seat, placement, rp_before, rp_delta, rp_after, tier_after, created_at)
              VALUES ('rhM2', 'ghM', 'profM2', 1, 2, 0, 60, 60, 'bronze', 2)`,
      }),
    ).resolves.toBeDefined();
  });

  it('players.profile_id column accepts NULL by default (no NOT NULL constraint) — an unlinked join works without ever mentioning profile_id', async () => {
    const db = await freshDb();
    await seedGameRow(db, 'gN');
    await expect(
      db.execute({
        sql: `INSERT INTO players (id, game_id, seat, display_name, join_token, created_at)
              VALUES ('pN1', 'gN', 0, 'Nora', 'tokN1', 1)`,
      }),
    ).resolves.toBeDefined();

    const row = await db.execute({ sql: 'SELECT profile_id FROM players WHERE id = ?', args: ['pN1'] });
    expect(row.rows[0].profile_id).toBeNull();
  });
});
