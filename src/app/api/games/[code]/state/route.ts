/**
 * GET /api/games/[code]/state — the current redacted view of a game for the
 * authenticated caller. Requires a valid `Authorization: Bearer <token>`
 * header (no unauthenticated spectator mode — that was not part of the
 * approved design, so it is deliberately not implemented here).
 */

import { getDb } from '@/server/db';
import { getGameByRoomCode, listPlayers, resolvePlayerToken } from '@/server/games';
import { getMatchSnapshot } from '@/server/replay';
import { toClientView } from '@/server/views';
import type { ClientGameView, ClientPlayerView } from '@/lib/protocol';
import type { Seat } from '@/engine/seats';

/** Duplicated per-route-file convention (see src/engine/*.test.ts). */
function extractBearerToken(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1] : null;
}

function waitingForPlayersView(
  code: string,
  status: 'waiting-for-players' | 'in-progress' | 'finished',
  players: readonly { seat: Seat; displayName: string }[],
  viewerSeat: Seat | null,
  seq: number,
): ClientGameView {
  const nameBySeat = new Map(players.map((p) => [p.seat, p.displayName]));
  const clientPlayers: ClientPlayerView[] = ([0, 1, 2, 3] as const).map((seat) => ({
    seat,
    displayName: nameBySeat.get(seat) ?? `Seat ${seat}`,
    isViewer: seat === viewerSeat,
    occupied: nameBySeat.has(seat),
    concealedTiles: null,
    concealedCount: 0,
    melds: [],
    flowers: [],
    discards: [],
    barredVisible: null,
    matchPoints: 0,
  }));

  return {
    seq,
    roomCode: code,
    status,
    handNumber: null,
    prevailingWind: null,
    players: clientPlayers,
    wallRemaining: null,
    phase: null,
    viewerSeat,
    currentTurnSeat: null,
    dealerSeat: null,
    repeatCount: null,
  };
}

export async function GET(
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

  const viewerSeat = resolved.seat;
  const status = game.status as 'waiting-for-players' | 'in-progress' | 'finished';
  const players = await listPlayers(db, game.gameId);

  const snapshot = await getMatchSnapshot(db, game.gameId);
  if (snapshot === null) {
    // getMatchSnapshot returning null means this exact read observed zero
    // action rows for the game — by definition the latest seq AT THAT READ
    // was 0. Report 0 directly rather than a second, independent
    // getLatestSeq call: a concurrent 4th-join could append the hand-1
    // start-hand row between the two reads, making a fresh getLatestSeq
    // call return a seq the just-computed "still waiting" content doesn't
    // reflect (seq outruns content — the same bug class fixed elsewhere in
    // this phase). Reporting the seq of the read we actually performed can
    // only be stale-low, never falsely-ahead, which is always safe: the
    // client's stream cursor will simply be notified on the next real seq.
    return Response.json(waitingForPlayersView(code, status, players, viewerSeat, 0), { status: 200 });
  }

  // Every field below comes from this ONE getMatchSnapshot read (state,
  // handNumber, lastSeq, prevailingWind, matchPoints all derived from the
  // same fetched action log) — never assembled from separate queries taken
  // at different times.
  const view = toClientView(
    snapshot.state,
    viewerSeat,
    players,
    code,
    status,
    snapshot.handNumber,
    snapshot.prevailingWind,
    snapshot.lastSeq,
    snapshot.matchPoints,
  );

  return Response.json(view, { status: 200 });
}
