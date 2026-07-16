/**
 * POST /api/games/[code]/join — assigns the caller the lowest free seat in
 * an existing game. Thin handler: all rule/persistence/concurrency logic
 * lives in src/server/games.ts.
 */

import { getDb } from '@/server/db';
import { joinGame } from '@/server/games';
import { resolveProfileToken } from '@/server/ranked';
import { isValidProfileToken, type JoinGameRequest, type JoinGameResponse } from '@/lib/protocol';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ code: string }> },
): Promise<Response> {
  const { code } = await params;

  let body: JoinGameRequest;
  try {
    body = (await request.json()) as JoinGameRequest;
  } catch {
    return Response.json({ error: 'invalid-json' }, { status: 400 });
  }

  if (typeof body.displayName !== 'string' || body.displayName.trim().length === 0) {
    return Response.json({ error: 'displayName is required' }, { status: 400 });
  }
  if (!isValidProfileToken(body.profileToken)) {
    return Response.json({ error: { type: 'validation-error', message: 'Invalid profileToken' } }, { status: 400 });
  }

  const db = getDb();

  // Same "explicit-but-unresolvable token is a 401, never a silent
  // downgrade to unranked" rule as POST /api/games.
  let profileId: string | undefined;
  if (typeof body.profileToken === 'string') {
    const resolved = await resolveProfileToken(db, body.profileToken);
    if (resolved === null) {
      return Response.json({ error: 'unauthorized' }, { status: 401 });
    }
    profileId = resolved.profileId;
  }

  const result = await joinGame(db, code, { displayName: body.displayName, profileId });

  if ('error' in result) {
    const status = result.error === 'not-found' ? 404 : 409;
    return Response.json({ error: result.error }, { status });
  }

  const response: JoinGameResponse = {
    roomCode: code,
    seat: result.seat,
    playerToken: result.playerToken,
    rules: result.rules,
    status: result.status,
  };

  return Response.json(response, { status: 200 });
}
