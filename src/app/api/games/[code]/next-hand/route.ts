/**
 * POST /api/games/[code]/next-hand — advances a finished hand to the next
 * one (or ends the game). All dealer/prevailing-wind/game-over derivation
 * lives in src/server/replay.ts's advanceToNextHand; this route only
 * authenticates and shapes the response.
 */

import { getDb } from '@/server/db';
import { getGameByRoomCode, listPlayers, resolvePlayerToken } from '@/server/games';
import { advanceToNextHand, getMatchSnapshot, type AdvanceToNextHandResult } from '@/server/replay';
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

  // The response is built from a single getMatchSnapshot read taken AFTER
  // advanceToNextHand's write already landed, rather than from its own
  // returned state/handNumber/lastSeq plus a separate prevailingWind lookup:
  // every field in the response comes from this ONE snapshot (see
  // docs/DECISIONS.md's "seq can outrun view content" entries). A snapshot
  // taken right after a successful append is guaranteed to include that
  // append (the action log is append-only/monotonic), so this is safe, not a
  // race — and it additionally gives us matchPoints, which
  // advanceToNextHand's own return value deliberately does not compute (see
  // getMatchSnapshot's doc comment on why it's kept out of the write path).
  const snapshot = await getMatchSnapshot(db, game.gameId);
  if (snapshot === null) {
    // Unreachable in practice: advanceToNextHand just succeeded, which
    // requires the new hand's start-hand row (and therefore at least one
    // action row) to exist.
    return Response.json(
      { error: { type: 'internal-error', message: 'An unexpected error occurred' } },
      { status: 500 },
    );
  }

  const players = await listPlayers(db, game.gameId);

  // advanceToNextHand's success case (a real next hand actually started)
  // only ever occurs while the game is still in-progress: the 'game-finished'
  // outcome above is a distinct error branch, never bundled with a success
  // result, so the status here is always 'in-progress'.
  const view = toClientView(
    snapshot.state,
    viewerSeat,
    players,
    code,
    'in-progress',
    snapshot.handNumber,
    snapshot.prevailingWind,
    snapshot.lastSeq,
    snapshot.matchPoints,
  );

  return Response.json(view, { status: 200 });
}
