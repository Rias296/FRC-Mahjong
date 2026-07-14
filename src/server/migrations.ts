/**
 * Migration runner for the additive-only SQL migrations in migrations/*.sql.
 *
 * Migration files must contain ONLY plain DDL/DML statements (no triggers or
 * procedures with embedded semicolons): each file's SQL is split naively on
 * `;` and every non-empty fragment is executed as its own statement.
 */

import type { Client } from '@libsql/client';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolved relative to this module's own file location (not process.cwd()),
// so this works identically whether invoked via `npm run db:migrate` (tsx,
// cwd = repo root) or under vitest (vite-node, whose cwd may differ). This
// file lives at src/server/migrations.ts, so migrations/ is two levels up.
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(MODULE_DIR, '..', '..', 'migrations');

export interface AppliedMigration {
  readonly filename: string;
}

function splitStatements(sql: string): string[] {
  return sql
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Applies every `migrations/*.sql` file (sorted by filename) that is not yet
 * recorded in the `_migrations` tracking table, in filename order. Returns
 * the list of migrations applied by THIS call (empty if already up to date).
 */
export async function runMigrations(db: Client): Promise<AppliedMigration[]> {
  await db.execute(
    `CREATE TABLE IF NOT EXISTS _migrations (
      filename TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )`,
  );

  const appliedRows = await db.execute('SELECT filename FROM _migrations');
  const alreadyApplied = new Set(appliedRows.rows.map((r) => String(r.filename)));

  const filenames = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const applied: AppliedMigration[] = [];

  for (const filename of filenames) {
    if (alreadyApplied.has(filename)) continue;

    const sql = readFileSync(join(MIGRATIONS_DIR, filename), 'utf-8');
    const statements = splitStatements(sql);

    await db.batch(
      [
        ...statements,
        {
          sql: 'INSERT INTO _migrations (filename, applied_at) VALUES (?, ?)',
          args: [filename, Date.now()],
        },
      ],
      'write',
    );

    applied.push({ filename });
  }

  return applied;
}
