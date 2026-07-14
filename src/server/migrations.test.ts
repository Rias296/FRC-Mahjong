import { createClient } from '@libsql/client';
import { describe, expect, it } from 'vitest';
import { runMigrations } from './migrations';

describe('runMigrations', () => {
  it('applies migrations in filename order and records them in _migrations', async () => {
    const db = createClient({ url: ':memory:' });

    const applied = await runMigrations(db);
    expect(applied.map((m) => m.filename)).toEqual(['0001_init.sql', '0002_start_hand_unique.sql']);

    const rows = await db.execute('SELECT filename FROM _migrations ORDER BY filename ASC');
    expect(rows.rows.map((r) => String(r.filename))).toEqual(['0001_init.sql', '0002_start_hand_unique.sql']);
  });

  it('creates usable tables from the migration', async () => {
    const db = createClient({ url: ':memory:' });
    await runMigrations(db);

    await db.execute({
      sql: `INSERT INTO games (id, room_code, status, rules_config, engine_version, created_at, updated_at)
            VALUES (?, ?, 'waiting-for-players', ?, ?, ?, ?)`,
      args: ['g1', 'ABCDEF', '{}', '0.1.0', 1, 1],
    });
    const games = await db.execute('SELECT * FROM games');
    expect(games.rows.length).toBe(1);

    await db.execute({
      sql: `INSERT INTO players (id, game_id, seat, display_name, join_token, created_at)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: ['p1', 'g1', 0, 'Alice', 'tok1', 1],
    });
    const players = await db.execute('SELECT * FROM players');
    expect(players.rows.length).toBe(1);

    await db.execute({
      sql: `INSERT INTO actions (game_id, hand_number, seq, actor_seat, action_type, payload, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: ['g1', 1, 1, null, 'start-hand', '{}', 1],
    });
    const actions = await db.execute('SELECT * FROM actions');
    expect(actions.rows.length).toBe(1);
  });

  it('is idempotent: a second run applies nothing new', async () => {
    const db = createClient({ url: ':memory:' });
    await runMigrations(db);

    const secondRun = await runMigrations(db);
    expect(secondRun).toEqual([]);

    const rows = await db.execute('SELECT filename FROM _migrations');
    expect(rows.rows.length).toBe(2);
  });

  it('resolves the migrations directory correctly under the vitest execution context', async () => {
    // This test itself running successfully (finding and applying
    // migrations/0001_init.sql) is the assertion that path resolution works
    // under vitest's cwd, which may differ from `npm run db:migrate`'s cwd.
    const db = createClient({ url: ':memory:' });
    const applied = await runMigrations(db);
    expect(applied.length).toBeGreaterThan(0);
  });
});
