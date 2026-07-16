/**
 * POST /api/games — creates a new game (status `waiting-for-players`) and
 * seats the caller at seat 0. Thin handler: all rule/persistence logic lives
 * in src/server/games.ts; this route only parses the request and shapes the
 * response.
 */

import { getDb } from '@/server/db';
import { createGame } from '@/server/games';
import { resolveProfileToken } from '@/server/ranked';
import { isValidProfileToken, isValidRulesOverride, type CreateGameResponse } from '@/lib/protocol';

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
  const { displayName, rules, profileToken } = body as {
    displayName?: unknown;
    rules?: unknown;
    profileToken?: unknown;
  };

  if (typeof displayName !== 'string' || displayName.trim().length === 0) {
    return Response.json({ error: 'displayName is required' }, { status: 400 });
  }
  if (!isValidRulesOverride(rules)) {
    return Response.json({ error: { type: 'validation-error', message: 'Invalid rules override' } }, { status: 400 });
  }
  if (!isValidProfileToken(profileToken)) {
    return Response.json({ error: { type: 'validation-error', message: 'Invalid profileToken' } }, { status: 400 });
  }

  const db = getDb();

  // An explicitly-supplied but unresolvable profileToken is a 401, never a
  // silent fall-through to an unranked game — the caller asked to be linked
  // and that request must not be swallowed.
  let profileId: string | undefined;
  if (typeof profileToken === 'string') {
    const resolved = await resolveProfileToken(db, profileToken);
    if (resolved === null) {
      return Response.json({ error: 'unauthorized' }, { status: 401 });
    }
    profileId = resolved.profileId;
  }

  const result = await createGame(db, { displayName, rules, profileId });

  const response: CreateGameResponse = {
    roomCode: result.roomCode,
    seat: result.seat,
    playerToken: result.playerToken,
    rules: result.rules,
    status: 'waiting-for-players',
  };

  return Response.json(response, { status: 201 });
}
