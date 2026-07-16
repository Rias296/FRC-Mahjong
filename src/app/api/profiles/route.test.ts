import { beforeAll, describe, expect, it } from 'vitest';
import type { Client } from '@libsql/client';
import { getDb } from '@/server/db';
import { runMigrations } from '@/server/migrations';
import type { CreateProfileResponse } from '@/lib/protocol';
import { POST } from './route';

/** See src/app/api/games/route.test.ts for why this singleton-routing setup is safe/isolated. */
let db: Client;

beforeAll(async () => {
  process.env.TURSO_DATABASE_URL = ':memory:';
  delete process.env.TURSO_AUTH_TOKEN;
  db = getDb();
  await runMigrations(db);
});

function jsonRequest(body: unknown): Request {
  return new Request('http://localhost/api/profiles', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/profiles', () => {
  it('creates a profile at 0 RP and returns a resolvable profileToken', async () => {
    const response = await POST(jsonRequest({ displayName: 'Alice' }));
    expect(response.status).toBe(201);

    const body = (await response.json()) as CreateProfileResponse;
    expect(body.profileId.length).toBeGreaterThan(0);
    expect(body.profileToken.length).toBeGreaterThan(0);

    const row = await db.execute({ sql: 'SELECT rank_points FROM profiles WHERE id = ?', args: [body.profileId] });
    expect(Number(row.rows[0].rank_points)).toBe(0);
  });

  it('generates distinct profiles/tokens across multiple calls', async () => {
    const a = (await (await POST(jsonRequest({ displayName: 'A' }))).json()) as CreateProfileResponse;
    const b = (await (await POST(jsonRequest({ displayName: 'B' }))).json()) as CreateProfileResponse;
    expect(a.profileId).not.toBe(b.profileId);
    expect(a.profileToken).not.toBe(b.profileToken);
  });

  it('rejects a missing displayName with 400', async () => {
    const response = await POST(jsonRequest({}));
    expect(response.status).toBe(400);
  });

  it('rejects an empty displayName with 400', async () => {
    const response = await POST(jsonRequest({ displayName: '   ' }));
    expect(response.status).toBe(400);
  });

  it('rejects malformed JSON with 400', async () => {
    const request = new Request('http://localhost/api/profiles', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    const response = await POST(request);
    expect(response.status).toBe(400);
  });
});
