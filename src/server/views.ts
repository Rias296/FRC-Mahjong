/**
 * Redaction layer: turns a full, server-authoritative GameState into the
 * per-viewer ClientGameView that actually crosses the wire. This is the only
 * place raw GameState is allowed to be read for building a client-facing
 * response — every field below is redacted (or deliberately passed through
 * as public) per docs/RULES.md's hidden-information rules. A leak here
 * defeats the whole point of server-authoritative state, so every branch
 * mirrors the exact spec it was built against; do not "simplify" this file
 * without re-checking each rule.
 *
 * Pure function, no side effects, no DB/network access — takes state in,
 * returns a view out.
 */

import type { GameState, Phase } from '../engine/game-state';
import type { PlayerMeld } from '../engine/actions';
import type { SeatTotals } from '../engine/scoring';
import { SEATS, type Seat } from '../engine/seats';
import type { Tile, TileKind } from '../engine/tiles';
import { remaining } from '../engine/wall';
import type {
  ClientGameView,
  ClientMeld,
  ClientPhaseView,
  ClientPlayerView,
  ClientRankedResultView,
  ClientTile,
  PrevailingWind,
} from '../lib/protocol';

function toClientTile(tile: Tile): ClientTile {
  return { id: tile.id, kind: tile.kind };
}

/**
 * Sentinel placeholder tile for an opponent's concealed-kong tiles: always
 * the red-dragon kind, with ids `hidden-0`..`hidden-3`. This particular kind
 * is arbitrary — any fixed, structurally-valid TileKind would do — the point
 * is that it is CONSTANT regardless of what the real masked tile is, so a
 * client (or a sufficiently nosy player) can never learn anything about the
 * real tile from the placeholder's shape. Never treat this as a real tile.
 */
const HIDDEN_KONG_PLACEHOLDER_KIND: TileKind = { category: 'dragon', dragon: 'red' };

function hiddenKongTile(index: number): ClientTile {
  return { id: `hidden-${index}`, kind: HIDDEN_KONG_PLACEHOLDER_KIND };
}

function redactMeld(meld: PlayerMeld, isViewer: boolean): ClientMeld {
  if (meld.kind === 'kong' && meld.concealed && !isViewer) {
    return {
      kind: 'kong',
      concealed: true,
      tiles: [0, 1, 2, 3].map(hiddenKongTile),
    };
  }
  return {
    kind: meld.kind,
    concealed: meld.concealed,
    tiles: meld.tiles.map(toClientTile),
  };
}

function redactPlayer(
  state: GameState,
  seat: Seat,
  viewerSeat: Seat | null,
  displayName: string,
  occupied: boolean,
  matchPoints: SeatTotals,
): ClientPlayerView {
  const player = state.players[seat];
  const isViewer = seat === viewerSeat;

  return {
    seat,
    displayName,
    isViewer,
    occupied,
    concealedTiles: isViewer ? player.hand.concealedTiles.map(toClientTile) : null,
    concealedCount: player.hand.concealedTiles.length,
    melds: player.hand.melds.map((meld) => redactMeld(meld, isViewer)),
    flowers: player.flowers.map(toClientTile),
    discards: player.discards.map(toClientTile),
    barredVisible: isViewer ? player.barred : null,
    // Public for every viewer (see ClientPlayerView's field doc) — never
    // gated on isViewer/occupied, unlike the hand-content fields above.
    matchPoints: matchPoints[seat],
  };
}

function redactPhase(state: GameState, viewerSeat: Seat | null): ClientPhaseView {
  const phase: Phase = state.phase;

  switch (phase.type) {
    case 'awaiting-draw':
      return { type: 'awaiting-draw' };

    case 'awaiting-discard': {
      const isCurrentTurnViewer = viewerSeat !== null && state.currentTurnSeat === viewerSeat;
      if (!isCurrentTurnViewer) {
        return { type: 'awaiting-discard' };
      }
      return {
        type: 'awaiting-discard',
        drawnTileForViewer: phase.drawnTile === null ? null : toClientTile(phase.drawnTile),
      };
    }

    case 'awaiting-claims':
      return {
        type: 'awaiting-claims',
        discarderSeat: phase.discarderSeat,
        discardedTile: toClientTile(phase.discardedTile),
        respondedSeats: Object.keys(phase.responses).map((s) => Number(s) as Seat),
      };

    case 'awaiting-rob-kong': {
      const youMayRob = viewerSeat !== null && phase.eligibleRobbers.includes(viewerSeat);
      const isDeclarer = viewerSeat !== null && viewerSeat === phase.declarerSeat;
      // COUNT only — never the seat list. The list would reveal exactly which
      // seats are eligible-and-pending (i.e. could hu on this kong tile) to
      // every viewer, including bystanders and spectators who have no stake
      // in the window. See the protocol.ts field doc for the rationale.
      const stillWaitingCount = phase.eligibleRobbers.filter((seat) => phase.responses[seat] === undefined).length;

      // Added kongs are public by nature (the promoted meld is already
      // visible), so the tile is always shown. A concealed kong's tile is
      // shown only to the declarer (who obviously knows it) or an eligible
      // robber (who needs to know what they'd be robbing) — never to a
      // bystander who has no stake in this window.
      const kongTileVisible: ClientTile | null =
        phase.kongType === 'added' || isDeclarer || youMayRob ? toClientTile(phase.kongTile) : null;

      // Only set (never `false`) when the viewer is an eligible robber who
      // has already recorded a response — matches the optional-field
      // convention used by youMayRob/stillWaitingCount elsewhere in this
      // phase branch. Leaving it undefined for everyone else (declarer,
      // bystanders, spectators) avoids revealing anything about other seats'
      // responses.
      const youHaveResponded =
        youMayRob && viewerSeat !== null && phase.responses[viewerSeat] !== undefined ? true : undefined;

      return {
        type: 'awaiting-rob-kong',
        declarerSeat: phase.declarerSeat,
        kongTileVisible,
        youMayRob,
        stillWaitingCount,
        ...(youHaveResponded !== undefined ? { youHaveResponded } : {}),
      };
    }

    case 'hand-over':
      return { type: 'hand-over', result: phase.result };
  }
}

/**
 * Builds the redacted, per-viewer ClientGameView for `state`. `viewerSeat`
 * is null for a spectator/unauthenticated view (isViewer is then false for
 * every seat, and every viewer-gated field redacts to its "not you" case).
 *
 * `ranked` is an additive, optional trailing parameter (default `undefined`,
 * matching the "only meaningfully present when status === 'finished'" field
 * doc on `ClientGameView.ranked`) — existing call sites that don't pass it
 * are unaffected. Already fully redacted by the time it reaches here (see
 * `src/server/ranked.ts`'s `RankedResultView` doc comment); this function
 * passes it through verbatim, never reads raw RP off it.
 */
export function toClientView(
  state: GameState,
  viewerSeat: Seat | null,
  players: readonly { seat: Seat; displayName: string }[],
  roomCode: string,
  status: 'waiting-for-players' | 'in-progress' | 'finished',
  handNumber: number | null,
  prevailingWind: PrevailingWind | null,
  seq: number,
  matchPoints: SeatTotals,
  ranked?: ClientRankedResultView,
): ClientGameView {
  const nameBySeat = new Map(players.map((p) => [p.seat, p.displayName]));

  const clientPlayers: ClientPlayerView[] = SEATS.map((seat) =>
    redactPlayer(state, seat, viewerSeat, nameBySeat.get(seat) ?? `Seat ${seat}`, nameBySeat.has(seat), matchPoints),
  );

  return {
    seq,
    roomCode,
    status,
    handNumber,
    prevailingWind,
    players: clientPlayers,
    wallRemaining: remaining(state.wall),
    phase: redactPhase(state, viewerSeat),
    viewerSeat,
    currentTurnSeat: state.currentTurnSeat,
    dealerSeat: state.dealerSeat,
    repeatCount: state.repeatCount,
    ranked,
  };
}
