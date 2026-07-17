/**
 * GET /api/games/[code]/state — the current redacted view of a game for the
 * authenticated caller. Requires a valid `Authorization: Bearer <token>`
 * header (no unauthenticated spectator mode — that was not part of the
 * approved design, so it is deliberately not implemented here).
 */

import { getDb } from '@/server/db';
import { getGameByRoomCode, listPlayers, resolvePlayerToken } from '@/server/games';
import { getMatchSnapshot } from '@/server/replay';
import { getRankedResultForGame, settleRankedMatch } from '@/server/ranked';
import { applyTurnTimeouts, computeTurnDeadline } from '@/server/turn-timer';
import { toClientView } from '@/server/views';
import type { ClientGameView, ClientPlayerView, ClientRankedResultView } from '@/lib/protocol';
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
  startingPoints: number,
  turnTimerSeconds: number,
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
    // Seeded with the match's configured starting pool (RULES.md §13,
    // Mahjong-Soul-style pool scoring — see scoring.ts's initialSeatTotals),
    // not 0: no hand has been folded yet, but every seat's real starting
    // total is `rules.points.startingPoints`, never zero.
    matchPoints: startingPoints,
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
    // No hand exists yet, so there is no open decision window — turnDeadline
    // is always null here — but turnTimerSeconds (the configured value) and
    // serverNow are still meaningfully reportable.
    turnDeadline: null,
    serverNow: Date.now(),
    turnTimerSeconds,
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

  // Lazy turn-timer enforcement: a GET here (like the ranked-settlement
  // "observer-healing path" below) is this route's established
  // precedent for a read that also writes when needed — settleRankedMatch
  // already does exactly this. applyTurnTimeouts is itself cheap-gated
  // (a lightweight games-row + latest-action-row read before ever
  // replaying a hand), and — same defensive wrapping as settleRankedMatch
  // below — must never crash this route's otherwise-successful response: a
  // timer-enforcement hiccup is not a reason to fail an ordinary state poll.
  if (status === 'in-progress') {
    try {
      await applyTurnTimeouts(db, game.gameId);
    } catch (err) {
      console.error(`[turn-timer] applyTurnTimeouts failed for game ${game.gameId}:`, err);
    }
  }

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
    return Response.json(
      waitingForPlayersView(
        code,
        status,
        players,
        viewerSeat,
        0,
        game.rules.points.startingPoints,
        game.rules.turnTimerSeconds,
      ),
      { status: 200 },
    );
  }

  // Observer-healing path: a spectator/player who never submitted the
  // finishing action still needs to see the ranked result once the game is
  // finished — settleRankedMatch's own cheap-path-first design (see
  // src/server/ranked.ts) makes this safe to call on every poll.
  //
  // settleRankedMatch can throw (see its doc comment's "per-seat error
  // isolation" — one permanently-broken seat still surfaces as an error, by
  // design, so it isn't silently invisible). That must never crash this
  // route's whole response: the rest of the game view is still valid and
  // worth returning even if ranked settlement hiccups. Fall back to a
  // read-only, always-safe getRankedResultForGame (never triggers
  // settlement itself, so it can't throw the same way) to still surface
  // whatever ranked result already exists; if even that fails, omit
  // `ranked` entirely rather than fail the request.
  let ranked: ClientRankedResultView | undefined;
  if (status === 'finished') {
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
  }

  // Every field below comes from this ONE getMatchSnapshot read (state,
  // handNumber, lastSeq, prevailingWind, matchPoints, windowOpenedAt, rules
  // all derived from the same fetched action log) — never assembled from
  // separate queries taken at different times. This snapshot was taken
  // AFTER the lazy enforcement above already landed any expired auto-action,
  // so `turnDeadline` below is computed from the post-enforcement window.
  const turnDeadline = computeTurnDeadline(snapshot.rules, snapshot.windowOpenedAt, snapshot.state.phase.type, status);

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
    ranked,
    { turnDeadline, serverNow: Date.now(), turnTimerSeconds: snapshot.rules.turnTimerSeconds },
  );

  return Response.json(view, { status: 200 });
}
