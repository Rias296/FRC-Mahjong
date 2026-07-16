import { beforeAll, describe, expect, it } from 'vitest';
import type { Client } from '@libsql/client';
import { getDb } from '@/server/db';
import { runMigrations } from '@/server/migrations';
import { createProfile } from '@/server/ranked';
import { APEX_THRESHOLD_RP } from '@/lib/ranked/config';
import type { ApexLeaderboardResponse } from '@/lib/protocol';
import { GET } from './route';

/** See src/app/api/games/route.test.ts for why this singleton-routing setup is safe/isolated. */
let db: Client;

beforeAll(async () => {
  process.env.TURSO_DATABASE_URL = ':memory:';
  delete process.env.TURSO_AUTH_TOKEN;
  db = getDb();
  await runMigrations(db);
});

async function makeApexProfile(displayName: string, rankPoints: number, apexAttainedAt: number): Promise<string> {
  const profile = await createProfile(db, displayName);
  await db.execute({
    sql: 'UPDATE profiles SET rank_points = ?, apex_attained_at = ? WHERE id = ?',
    args: [rankPoints, apexAttainedAt, profile.profileId],
  });
  return profile.profileId;
}

describe('GET /api/leaderboard/apex', () => {
  it('returns empty leaderboards when no profile has reached Apex', async () => {
    await createProfile(db, 'NeverApex');
    const response = await GET();
    expect(response.status).toBe(200);
    const body = (await response.json()) as ApexLeaderboardResponse;
    expect(body.foundingOrder).toEqual([]);
    expect(body.rpOrder).toEqual([]);
  });

  it('orders foundingOrder by apexAttainedAt ascending and rpOrder by rankPoints descending', async () => {
    const first = await makeApexProfile('First', APEX_THRESHOLD_RP + 10, 1000);
    const second = await makeApexProfile('Second', APEX_THRESHOLD_RP + 500, 2000);
    const third = await makeApexProfile('Third', APEX_THRESHOLD_RP + 50, 3000);

    const response = await GET();
    const body = (await response.json()) as ApexLeaderboardResponse;

    expect(body.foundingOrder.map((e) => e.profileId)).toEqual([first, second, third]);
    expect(body.rpOrder.map((e) => e.profileId)).toEqual([second, third, first]);
  });

  it('never includes a profile that has not attained Apex', async () => {
    const bronze = await createProfile(db, 'Bronze');
    const apex = await makeApexProfile('Apex', APEX_THRESHOLD_RP, 5000);

    const response = await GET();
    const body = (await response.json()) as ApexLeaderboardResponse;
    const ids = body.foundingOrder.map((e) => e.profileId);
    expect(ids).toContain(apex);
    expect(ids).not.toContain(bronze.profileId);
  });
});
