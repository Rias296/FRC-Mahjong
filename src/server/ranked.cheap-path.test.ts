/**
 * Dedicated mock-based coverage (same per-file `vi.mock` convention as
 * room-code-collision.test.ts) proving `settleRankedMatch`'s early-return
 * paths ('unranked'/'pending') never call `getMatchSnapshot` — i.e. never
 * replay the match — for a finished-but-unlinked or not-yet-finished game.
 * Kept in its own file since `vi.mock` hoists for the whole file and would
 * otherwise force every other ranked.test.ts test (which needs a REAL
 * settlement to run) to go through this instrumented wrapper too.
 */
import { createClient, type Client } from '@libsql/client';
import { describe, expect, it, vi } from 'vitest';
import { runMigrations } from './migrations';
import { DEFAULT_RULES } from '../engine/rules-config';
import type { Seat } from '../engine/seats';

let getMatchSnapshotCalls = 0;

vi.mock('./replay', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./replay')>();
  return {
    ...actual,
    getMatchSnapshot: (...args: Parameters<typeof actual.getMatchSnapshot>) => {
      getMatchSnapshotCalls += 1;
      return actual.getMatchSnapshot(...args);
    },
  };
});

async function freshDb(): Promise<Client> {
  const db = createClient({ url: ':memory:' });
  await runMigrations(db);
  return db;
}

async function seedGameRow(
  db: Client,
  gameId: string,
  status: 'waiting-for-players' | 'in-progress' | 'finished',
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO games (id, room_code, status, rules_config, engine_version, created_at, updated_at)
          VALUES (?, ?, ?, ?, '0.1.0', 1, 1)`,
    args: [gameId, gameId.slice(0, 6).toUpperCase().padEnd(6, 'X'), status, JSON.stringify(DEFAULT_RULES)],
  });
}

async function seedPlayerRow(db: Client, gameId: string, seat: Seat, profileId: string | null): Promise<void> {
  await db.execute({
    sql: `INSERT INTO players (id, game_id, seat, display_name, join_token, created_at, profile_id)
          VALUES (?, ?, ?, ?, ?, 1, ?)`,
    args: [`${gameId}-p${seat}`, gameId, seat, `Seat ${seat}`, `${gameId}-tok${seat}`, profileId],
  });
}

describe("settleRankedMatch's early-return paths never replay the match", () => {
  it('a finished game with an unlinked seat returns unranked without calling getMatchSnapshot', async () => {
    const { settleRankedMatch } = await import('./ranked');
    const db = await freshDb();
    await seedGameRow(db, 'g1', 'finished');
    await seedPlayerRow(db, 'g1', 0, 'prof0');
    await seedPlayerRow(db, 'g1', 1, 'prof1');
    await seedPlayerRow(db, 'g1', 2, 'prof2');
    await seedPlayerRow(db, 'g1', 3, null);

    getMatchSnapshotCalls = 0;
    const result = await settleRankedMatch(db, 'g1');
    expect(result).toEqual({ status: 'unranked' });
    expect(getMatchSnapshotCalls).toBe(0);
  });

  it('a not-yet-finished, fully-linked game returns pending without calling getMatchSnapshot', async () => {
    const { settleRankedMatch } = await import('./ranked');
    const db = await freshDb();
    await seedGameRow(db, 'g2', 'in-progress');
    await seedPlayerRow(db, 'g2', 0, 'prof0');
    await seedPlayerRow(db, 'g2', 1, 'prof1');
    await seedPlayerRow(db, 'g2', 2, 'prof2');
    await seedPlayerRow(db, 'g2', 3, 'prof3');

    getMatchSnapshotCalls = 0;
    const result = await settleRankedMatch(db, 'g2');
    expect(result).toEqual({ status: 'pending' });
    expect(getMatchSnapshotCalls).toBe(0);
  });

  it('a not-yet-finished game with an unlinked seat returns unranked without calling getMatchSnapshot', async () => {
    const { settleRankedMatch } = await import('./ranked');
    const db = await freshDb();
    await seedGameRow(db, 'g3', 'in-progress');
    await seedPlayerRow(db, 'g3', 0, 'prof0');
    await seedPlayerRow(db, 'g3', 1, null);
    await seedPlayerRow(db, 'g3', 2, 'prof2');
    await seedPlayerRow(db, 'g3', 3, 'prof3');

    getMatchSnapshotCalls = 0;
    const result = await settleRankedMatch(db, 'g3');
    expect(result).toEqual({ status: 'unranked' });
    expect(getMatchSnapshotCalls).toBe(0);
  });
});
