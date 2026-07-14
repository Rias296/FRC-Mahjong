/**
 * POST /api/games/[code]/next-hand — advances a finished hand to the next
 * one (or ends the game). All dealer/prevailing-wind/game-over derivation
 * lives in src/server/replay.ts's advanceToNextHand; this route only
 * authenticates and shapes the response.
 */

import { getDb } from '@/server/db';
import { getGameByRoomCode, listPlayers, resolvePlayerToken } from '@/server/games';
import { advanceToNextHand, type AdvanceToNextHandResult } from '@/server/replay';
import { getStartHandPayload } from '@/server/actions-log';
import { toClientView } from '@/server/views';

/** Duplicated per-route-file convention (see src/engine/*.test.ts). */
function extractBearerToken(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1] : null;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ code: string }> },
): Promise<Response> {
  const { code } = await params;

  const token = extractBearerToken(request);
  if (token === null) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  const db = getDb();
  const resolved = await resolvePlayerToken(db, token);
  if (resolved === null) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  const game = await getGameByRoomCode(db, code);
  if (game === null) {
    return Response.json({ error: 'not-found' }, { status: 404 });
  }
  if (resolved.gameId !== game.gameId) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  // Defense-in-depth, matching the actions route: advanceToNextHand throws
  // a bare Error (not a returned failure) when no hand has ever started for
  // this game (e.g. a seated player POSTs here before the 4th player has
  // joined) — never let that (or any other unexpected throw) propagate out
  // of the route handler uncaught.
  let result: AdvanceToNextHandResult;
  try {
    result = await advanceToNextHand(db, game.gameId);
  } catch {
    return Response.json(
      { error: { type: 'internal-error', message: 'An unexpected error occurred' } },
      { status: 500 },
    );
  }
  if ('error' in result) {
    return Response.json({ error: result.error }, { status: 409 });
  }

  const viewerSeat = resolved.seat;
  // Both prevailingWind and seq are derived without a second, independent
  // "what's the latest state of the world" query: prevailingWind is a
  // single indexed row lookup for the SPECIFIC hand result.state already
  // reflects, and seq comes straight from advanceToNextHand's own return
  // value (the exact same read that produced result.state) rather than a
  // separate getLatestSeq call that could race against a concurrent writer.
  const prevailingWind = (await getStartHandPayload(db, game.gameId, result.handNumber)).prevailingWind;
  const players = await listPlayers(db, game.gameId);
  const seq = result.lastSeq;

  // advanceToNextHand's success case (a real next hand actually started)
  // only ever occurs while the game is still in-progress: the 'game-finished'
  // outcome above is a distinct error branch, never bundled with a success
  // result, so the status here is always 'in-progress'.
  const view = toClientView(
    result.state,
    viewerSeat,
    players,
    code,
    'in-progress',
    result.handNumber,
    prevailingWind,
    seq,
  );

  return Response.json(view, { status: 200 });
}
