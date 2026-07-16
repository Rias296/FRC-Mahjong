import { beforeAll, describe, expect, it } from 'vitest';
import type { Client } from '@libsql/client';
import { getDb } from '@/server/db';
import { runMigrations } from '@/server/migrations';
import { createProfile } from '@/server/ranked';
import type { ProfileMeResponse } from '@/lib/protocol';
import { GET } from './route';

/** See src/app/api/games/route.test.ts for why this singleton-routing setup is safe/isolated. */
let db: Client;

beforeAll(async () => {
  process.env.TURSO_DATABASE_URL = ':memory:';
  delete process.env.TURSO_AUTH_TOKEN;
  db = getDb();
  await runMigrations(db);
});

function authedRequest(token: string | null): Request {
  const headers: Record<string, string> = {};
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return new Request('http://localhost/api/profiles/me', { headers });
}

describe('GET /api/profiles/me', () => {
  it('returns the caller own profile at 0 RP / bronze / division 3 for a freshly created profile', async () => {
    const profile = await createProfile(db, 'Alice');
    const response = await GET(authedRequest(profile.secretToken));
    expect(response.status).toBe(200);

    const body = (await response.json()) as ProfileMeResponse;
    expect(body.profileId).toBe(profile.profileId);
    expect(body.displayName).toBe('Alice');
    expect(body.rankPoints).toBe(0);
    expect(body.tier).toBe('bronze');
    expect(body.division).toBe(3);
  });

  it('returns 401 with no Authorization header', async () => {
    const response = await GET(authedRequest(null));
    expect(response.status).toBe(401);
  });

  it('returns 401 for an unknown token', async () => {
    const response = await GET(authedRequest('not-a-real-token'));
    expect(response.status).toBe(401);
  });

  it('reflects an updated RP total after a direct profiles.rank_points change', async () => {
    const profile = await createProfile(db, 'Bob');
    await db.execute({ sql: 'UPDATE profiles SET rank_points = ? WHERE id = ?', args: [1250, profile.profileId] });

    const response = await GET(authedRequest(profile.secretToken));
    const body = (await response.json()) as ProfileMeResponse;
    expect(body.rankPoints).toBe(1250);
    expect(body.tier).toBe('silver');
    expect(body.division).toBe(2);
  });
});
