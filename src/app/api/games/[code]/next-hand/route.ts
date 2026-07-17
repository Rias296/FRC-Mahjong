/**
 * POST /api/games/[code]/next-hand — advances a finished hand to the next
 * one (or ends the game). All dealer/prevailing-wind/game-over derivation
 * lives in src/server/replay.ts's advanceToNextHand; this route only
 * authenticates and shapes the response.
 */

import { getDb } from '@/server/db';
import { getGameByRoomCode, listPlayers, resolvePlayerToken } from '@/server/games';
import { advanceToNextHand, getMatchSnapshot, type AdvanceToNextHandResult } from '@/server/replay';
import { getRankedResultForGame, settleRankedMatch } from '@/server/ranked';
import { computeTurnDeadline } from '@/server/turn-timer';
import { toClientView } from '@/server/views';
import type { ClientRankedResultView } from '@/lib/protocol';

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
    // The 'game-finished' branch is this route's own hook for the same
    // "settle/resolve the ranked result the instant the match ends" pattern
    // used by POST /actions — a caller landing here (having tried to advance
    // past an already-over match) should see the ranked result in this same
    // response rather than needing a follow-up /state poll. No ClientGameView
    // is built on this branch (there's no next hand to describe), so `ranked`
    // rides along on the existing error-shaped response as an additive field.
    if (result.error === 'game-finished') {
      // Same defensive wrapping as GET /state and POST /actions (see those
      // routes' comments): settleRankedMatch can throw by design (per-seat
      // error isolation), and that must never crash this route's own
      // otherwise-normal 409 response.
      let ranked: ClientRankedResultView | undefined;
      try {
        ranked = await settleRankedMatch(db, game.gameId);
      } catch (err) {
        console.error(`[ranked] settleRankedMatch failed for game ${game.gameId}:`, err);
        try {
          ranked = await getRankedResultForGame(db, game.gameId);
        } catch (fallbackErr) {
          console.error(`[ranked] getRankedResultForGame fallback also failed for game ${game.gameId}:`, fallbackErr);
        }
      }
      return Response.json({ error: result.error, ranked }, { status: 409 });
    }
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
  //
  // turnDeadline is computed from this same snapshot's windowOpenedAt/rules
  // (the brand-new hand's start-hand row), matching GET /state and POST
  // /actions so every in-progress response — including the one immediately
  // after a hand transition — carries a turnDeadline. Omitting it here was a
  // real gap: the response otherwise silently dropped turnDeadline/serverNow
  // /turnTimerSeconds until the next /state poll or SSE tick.
  const turnDeadline = computeTurnDeadline(
    snapshot.rules,
    snapshot.windowOpenedAt,
    snapshot.state.phase.type,
    'in-progress',
  );

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
    undefined,
    { turnDeadline, serverNow: Date.now(), turnTimerSeconds: snapshot.rules.turnTimerSeconds },
  );

  return Response.json(view, { status: 200 });
}
