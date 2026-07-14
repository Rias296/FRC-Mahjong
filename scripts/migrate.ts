/**
 * CLI entry point: applies any unapplied migrations/*.sql files to the
 * database configured via TURSO_DATABASE_URL / TURSO_AUTH_TOKEN (see
 * src/server/db.ts). Usage: `npm run db:migrate`.
 */

import { getDb } from '../src/server/db';
import { runMigrations } from '../src/server/migrations';

async function main(): Promise<void> {
  const db = getDb();
  const applied = await runMigrations(db);

  if (applied.length === 0) {
    console.log('No new migrations to apply.');
    return;
  }

  console.log(`Applied ${applied.length} migration(s):`);
  for (const migration of applied) {
    console.log(`  - ${migration.filename}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
