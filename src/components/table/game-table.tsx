'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { CenterScoreboard } from './center-scoreboard';
import { DiscardPool } from './discard-pool';
import { HandOverPanel } from './hand-over-panel';
import { MatchStandings } from './match-standings';
import { OpponentPanel } from './opponent-panel';
import { PlayerRack, type RackSelectionMode } from './player-rack';
import { StatusStrip } from './status-strip';
import { ClaimActionBar } from './claim-action-bar';
import { RobKongPrompt } from './rob-kong-prompt';
import { TurnTimerRing } from './turn-timer-ring';
import { seatPositionFor, type SeatPosition } from '@/lib/table/tile-display';
import {
  computeSelectionWindowSignature,
  deriveInteractions,
  isOpponentTimerSeat,
  type ClaimOffer,
} from '@/lib/table/interactions';
import { submitAction, advanceNextHand } from '@/lib/api-client';
import { ruleErrorMessage, TABLE_STRINGS } from '@/lib/i18n/table';
import { LOBBY_STRINGS } from '@/lib/i18n/lobby';
import type { ClientGameView, ClientPlayerView } from '@/lib/protocol';
import type { ApiError } from '@/lib/api-client';
import type { GameAction } from '@/engine/game-state';

export interface GameTableProps {
  readonly view: ClientGameView;
  readonly connected: boolean;
  readonly code: string;
  readonly playerToken: string;
  readonly onViewUpdate: (view: ClientGameView) => void;
  readonly onResync: () => void;
}

const QUADRANT_POSITION_CLASSES: Readonly<Record<SeatPosition, string>> = {
  bottom: 'col-start-2 row-start-3 self-end justify-self-center',
  right: 'col-start-3 row-start-2 self-center justify-self-start',
  top: 'col-start-2 row-start-1 self-start justify-self-center',
  left: 'col-start-1 row-start-2 self-center justify-self-end',
};

function genericActionErrorMessage(kind: ApiError['kind']): string {
  switch (kind) {
    case 'network-error':
      return LOBBY_STRINGS.errorNetwork;
    case 'validation-error':
      return LOBBY_STRINGS.errorGeneric;
    default:
      return LOBBY_STRINGS.errorServer;
  }
}

export function GameTable({ view, connected, code, playerToken, onViewUpdate, onResync }: GameTableProps): React.JSX.Element {
  const [pending, setPending] = useState(false);
  const [nextHandPending, setNextHandPending] = useState(false);
  const [selectionMode, setSelectionMode] = useState<RackSelectionMode>('none');
  const [selectedTileIds, setSelectedTileIds] = useState<readonly string[]>([]);

  // Reset any in-progress tile selection whenever the underlying decision
  // WINDOW changes (a new discard to claim, a new rob-kong declaration, a new
  // draw on the viewer's own turn) — see computeSelectionWindowSignature's
  // doc comment for why this must NOT be a full-phase-object comparison.
  // This adjusts state during render (React's recommended pattern for "state
  // that depends on a changing prop") rather than in a useEffect, which would
  // cause an extra cascading render.
  const windowSignature = computeSelectionWindowSignature(view);
  const [lastWindowSignature, setLastWindowSignature] = useState(windowSignature);
  if (windowSignature !== lastWindowSignature) {
    setLastWindowSignature(windowSignature);
    setSelectionMode('none');
    setSelectedTileIds([]);
  }

  // Once the match is over, MatchStandings fully replaces the table (and any
  // hand-over panel) — this is the only place that check is made; see
  // hand-over-panel.tsx's doc comment on why it no longer has its own
  // match-complete branch.
  if (view.status === 'finished') {
    return <MatchStandings players={view.players} ranked={view.ranked} />;
  }

  const viewerPlayer = view.players.find((p) => p.isViewer) ?? null;
  const referenceSeat = view.viewerSeat ?? 0;
  // Spectator-shaped views (viewerPlayer === null) have no seat to exclude —
  // every seat, including the "bottom" reference seat, renders as an
  // OpponentPanel instead of a PlayerRack.
  const opponentSeats = viewerPlayer !== null ? view.players.filter((p) => p.seat !== referenceSeat) : view.players;
  const drawnTileForViewer =
    view.phase?.type === 'awaiting-discard' && view.phase.drawnTileForViewer !== undefined
      ? view.phase.drawnTileForViewer
      : null;

  const interactions = deriveInteractions(view);

  // Server-authoritative turn-timer display (Round 2 added the fields to
  // ClientGameView; this round is pure display, see turn-timer-ring.tsx's
  // doc comment — never a client-side enforcement/auto-action trigger).
  const turnDeadline = view.turnDeadline ?? null;
  const turnTimerSeconds = view.turnTimerSeconds ?? null;
  // serverNow is populated by the server on every response that also sets
  // turnDeadline (see server/views.ts's `timing` argument) — no client-clock
  // fallback here (that would defeat the whole point of a server-anchored
  // countdown; see timer-display.ts's doc comment), so the ring simply
  // doesn't render on the rare shape that's missing it.
  const timerRing = turnDeadline !== null && view.serverNow !== undefined && (
    <TurnTimerRing turnDeadline={turnDeadline} serverNow={view.serverNow} turnTimerSeconds={turnTimerSeconds} />
  );
  // True whenever the viewer is themselves part of the currently-open
  // decision window (their own draw/discard turn, or a claim/rob-kong
  // window they're a participant in) — exactly the set of windows already
  // rendered in the rack-relative wrapper below (actionCluster/robPrompt).
  const viewerHasOpenWindow =
    interactions.canDraw || interactions.canDiscard || interactions.claimBar !== null || interactions.robPrompt !== null;
  // Only shown on OpponentPanel(s), and only when the window isn't already
  // covered by the rack-anchored ring below (see deriveInteractions' doc
  // comment — at most one of these two locations is ever "the" window for a
  // given viewer at a time). Which specific seat(s) get it is phase-aware
  // (see interactions.ts's isOpponentTimerSeat doc comment — currentTurnSeat
  // alone is wrong during awaiting-claims, a real bug found in review).
  const showOpponentTimer = turnDeadline !== null && !viewerHasOpenWindow;

  async function submit(action: GameAction): Promise<void> {
    setPending(true);
    try {
      const result = await submitAction(code, playerToken, action);
      if (result.ok) {
        onViewUpdate(result.data.view);
        setSelectionMode('none');
        setSelectedTileIds([]);
        return;
      }
      if (result.error.kind === 'rule-error') {
        toast.error(ruleErrorMessage(result.error.ruleError.code));
      } else {
        toast.error(genericActionErrorMessage(result.error.kind));
      }
      onResync();
    } finally {
      setPending(false);
    }
  }

  async function handleNextHand(): Promise<void> {
    setNextHandPending(true);
    try {
      const result = await advanceNextHand(code, playerToken);
      if (result.ok) {
        onViewUpdate(result.data);
        return;
      }
      if (result.error.kind === 'conflict') {
        // Benign race: another player already advanced the hand. Soft/neutral
        // toast, not an error — resync picks up whatever actually happened.
        toast(TABLE_STRINGS.benignRaceMessage);
      } else if (result.error.kind === 'network-error') {
        toast.error(LOBBY_STRINGS.errorNetwork);
      } else {
        toast.error(LOBBY_STRINGS.errorServer);
      }
      onResync();
    } finally {
      setNextHandPending(false);
    }
  }

  function handleCancelSelection(): void {
    setSelectionMode('none');
    setSelectedTileIds([]);
  }

  function handleToggleTileSelection(tileId: string): void {
    const viewerSeat = view.viewerSeat;
    if (viewerSeat === null) return;

    if (selectionMode === 'chow-select') {
      setSelectedTileIds((current) => {
        if (current.includes(tileId)) return current.filter((id) => id !== tileId);
        if (current.length >= 2) return current;
        return [...current, tileId];
      });
      return;
    }

    if (selectionMode === 'added-kong-select') {
      setSelectionMode('none');
      setSelectedTileIds([]);
      void submit({ type: 'declare-added-kong', seat: viewerSeat, tileId });
      return;
    }

    if (selectionMode === 'concealed-kong-select') {
      const tile = (viewerPlayer?.concealedTiles ?? []).find((t) => t.id === tileId);
      setSelectionMode('none');
      setSelectedTileIds([]);
      if (tile !== undefined) {
        void submit({ type: 'declare-concealed-kong', seat: viewerSeat, kind: tile.kind });
      }
    }
  }

  function handleConfirmChow(): void {
    const viewerSeat = view.viewerSeat;
    if (viewerSeat === null || selectedTileIds.length !== 2) return;
    const [firstTileId, secondTileId] = selectedTileIds;
    void submit({ type: 'claim', seat: viewerSeat, claim: { type: 'chow', tileIds: [firstTileId, secondTileId] } });
  }

  function handleClaimAction(claim: ClaimOffer): void {
    const viewerSeat = view.viewerSeat;
    if (viewerSeat === null) return;

    if (claim === 'pass') {
      void submit({ type: 'pass', seat: viewerSeat });
      return;
    }
    if (claim === 'chow') {
      setSelectionMode('chow-select');
      setSelectedTileIds([]);
      return;
    }
    void submit({ type: 'claim', seat: viewerSeat, claim: { type: claim } });
  }

  function opponentFor(player: ClientPlayerView): React.JSX.Element {
    return (
      <OpponentPanel
        key={player.seat}
        player={player}
        isCurrentTurn={view.currentTurnSeat === player.seat}
        isDealer={view.dealerSeat === player.seat}
        timer={showOpponentTimer && isOpponentTimerSeat(view, player.seat) ? timerRing : undefined}
      />
    );
  }

  const viewerSeat = view.viewerSeat;

  // Single floating action cluster: claim offers on another player's
  // discard, own-turn declarations (draw/hu/added-kong/concealed-kong —
  // previously game-table.tsx's static `ownTurnControls` block), and the
  // chow-select/kong-select prompts, all anchored at the same point above
  // the local rack row. See claim-action-bar.tsx's doc comment.
  const actionCluster = (
    <ClaimActionBar
      offer={interactions.claimBar?.offer ?? []}
      canDraw={interactions.canDraw}
      ownTurnDeclarations={interactions.ownTurnDeclarations}
      selectionMode={selectionMode}
      selectedTileCount={selectedTileIds.length}
      pending={pending}
      onClaimAction={handleClaimAction}
      onDraw={() => {
        if (viewerSeat !== null) void submit({ type: 'draw', seat: viewerSeat });
      }}
      onDeclareHu={() => {
        if (viewerSeat !== null) void submit({ type: 'declare-hu', seat: viewerSeat });
      }}
      onStartAddedKongSelect={() => {
        setSelectionMode('added-kong-select');
        setSelectedTileIds([]);
      }}
      onStartConcealedKongSelect={() => {
        setSelectionMode('concealed-kong-select');
        setSelectedTileIds([]);
      }}
      onConfirmChow={handleConfirmChow}
      onCancelSelection={handleCancelSelection}
    />
  );

  // RobKongPrompt is rendered in this same relative wrapper (not as a
  // game-table-level sibling) so it can anchor above the rack on md+
  // instead of covering it — see rob-kong-prompt.tsx's doc comment.
  // interactions.robPrompt is only ever non-null when viewerSeat is set
  // (deriveInteractions returns ZERO_INTERACTIONS for a null viewerSeat),
  // i.e. exactly when this wrapper renders at all.
  const robPrompt = interactions.robPrompt !== null && (
    <RobKongPrompt
      state={interactions.robPrompt}
      kongTileVisible={view.phase?.kongTileVisible ?? null}
      stillWaitingCount={view.phase?.stillWaitingCount}
      onRob={() => {
        if (viewerSeat !== null) void submit({ type: 'declare-rob', seat: viewerSeat });
      }}
      onPass={() => {
        if (viewerSeat !== null) void submit({ type: 'pass', seat: viewerSeat });
      }}
      pending={pending}
    />
  );

  const rack = viewerPlayer !== null && (
    <div className="relative flex flex-col items-center gap-2">
      {actionCluster}
      {robPrompt}
      <div className="flex items-end gap-2">
        {/*
          Rendered here (chrome beside the rack, not over any tile) whenever
          the viewer is themselves part of the open window — see
          viewerHasOpenWindow's doc comment above.
        */}
        {viewerHasOpenWindow && timerRing}
        <PlayerRack
          player={viewerPlayer}
          drawnTile={drawnTileForViewer}
          canDiscard={interactions.canDiscard}
          onDiscard={(tileId) => {
            if (viewerSeat !== null) void submit({ type: 'discard', seat: viewerSeat, tileId });
          }}
          selectionMode={selectionMode}
          selectedTileIds={selectedTileIds}
          onToggleTileSelection={handleToggleTileSelection}
          pending={pending}
        />
      </div>
    </div>
  );

  return (
    <div className="relative flex w-full flex-1 flex-col gap-3 overflow-x-hidden p-2 sm:p-4 md:h-dvh md:max-h-dvh md:grid md:grid-rows-[auto_minmax(0,1fr)_auto] md:gap-2 md:overflow-hidden">
      <StatusStrip view={view} connected={connected} />

      {/*
        Tablet+: classic 4-seat cross layout around a center discard pool +
        scoreboard. This is the middle row of the outer 3-row grid
        (status strip / table grid / rack+cluster) — it keeps its own
        minmax(0,1fr) row tracks (via grid-rows-3) and overflow-hidden so it
        can never push the rack row below the fold.
      */}
      <div className="hidden min-h-0 grid-cols-3 grid-rows-3 items-center justify-items-center gap-2 overflow-hidden md:grid">
        {opponentSeats.map((player) => (
          <div key={player.seat} className={QUADRANT_POSITION_CLASSES[seatPositionFor(player.seat, referenceSeat)]}>
            {opponentFor(player)}
          </div>
        ))}
        <div className="col-start-2 row-start-2 flex h-full w-full min-h-0 items-center justify-center gap-3 overflow-hidden">
          <CenterScoreboard view={view} />
          <DiscardPool view={view} />
        </div>
      </div>

      {/* Mobile: stacked vertical layout, no horizontal scroll (unchanged this round). */}
      <div className="flex flex-1 flex-col gap-3 md:hidden">
        <div className="flex flex-col gap-2">{opponentSeats.map((player) => opponentFor(player))}</div>
        <CenterScoreboard view={view} />
        <DiscardPool view={view} />
        {viewerPlayer !== null && <div className="mt-auto flex justify-center pb-2">{rack}</div>}
      </div>

      {/* md+: bottom row of the outer 3-row grid — rack + floating action cluster. */}
      {viewerPlayer !== null && <div className="hidden md:flex md:items-end md:justify-center">{rack}</div>}

      {view.phase?.type === 'hand-over' && view.phase.result !== undefined && (
        <HandOverPanel
          result={view.phase.result}
          players={view.players}
          onNextHand={interactions.handOver === 'next-hand' ? handleNextHand : undefined}
          pending={nextHandPending}
        />
      )}
    </div>
  );
}
