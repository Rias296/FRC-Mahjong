/**
 * GET /api/profiles/me — the caller's own full ranked profile (including the
 * exact RP total, private to the owner). Requires a valid
 * `Authorization: Bearer <profileToken>` header.
 */

import { getDb } from '@/server/db';
import { getOwnProfile } from '@/server/ranked';
import type { ProfileMeResponse } from '@/lib/protocol';

/** Duplicated per-route-file convention (see src/app/api/games/[code]/state/route.ts). */
function extractBearerToken(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1] : null;
}

export async function GET(request: Request): Promise<Response> {
  const token = extractBearerToken(request);
  if (token === null) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  const db = getDb();
  const profile = await getOwnProfile(db, token);
  if (profile === null) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  const response: ProfileMeResponse = {
    profileId: profile.profileId,
    displayName: profile.displayName,
    rankPoints: profile.rankPoints,
    tier: profile.tier,
    division: profile.division,
  };

  return Response.json(response, { status: 200 });
}
