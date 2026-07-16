/**
 * POST /api/profiles — creates a new ranked profile (0 RP) and returns its
 * long-lived secret token. Thin handler: all persistence logic lives in
 * src/server/ranked.ts's createProfile.
 */

import { getDb } from '@/server/db';
import { createProfile } from '@/server/ranked';
import { isValidDisplayName, type CreateProfileResponse } from '@/lib/protocol';

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'invalid-json' }, { status: 400 });
  }

  if (typeof body !== 'object' || body === null) {
    return Response.json({ error: 'invalid-json' }, { status: 400 });
  }
  const { displayName } = body as { displayName?: unknown };

  if (!isValidDisplayName(displayName)) {
    return Response.json({ error: 'displayName is required' }, { status: 400 });
  }

  const db = getDb();
  const result = await createProfile(db, displayName);

  const response: CreateProfileResponse = {
    profileId: result.profileId,
    profileToken: result.secretToken,
  };

  return Response.json(response, { status: 201 });
}
