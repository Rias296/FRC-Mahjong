'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { DiscardPool } from './discard-pool';
import { HandOverPanel } from './hand-over-panel';
import { OpponentPanel } from './opponent-panel';
import { PlayerRack, type RackSelectionMode } from './player-rack';
import { StatusStrip } from './status-strip';
import { ClaimActionBar } from './claim-action-bar';
import { RobKongPrompt } from './rob-kong-prompt';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { seatPositionFor, type SeatPosition } from '@/lib/table/tile-display';
import { computeSelectionWindowSignature, deriveInteractions, type ClaimOffer } from '@/lib/table/interactions';
import { submitAction, advanceNextHand } from '@/lib/api-client';
import { ruleErrorMessage, TABLE_STRINGS } from '@/lib/i18n/table';
import { actionLabel } from '@/lib/theme/frc';
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

const TOUCH_TARGET_CLASS = 'h-11 min-w-11 px-4 text-base';

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
      />
    );
  }

  const viewerSeat = view.viewerSeat;

  const ownTurnControls =
    viewerSeat !== null && (interactions.canDraw || interactions.ownTurnDeclarations.length > 0) ? (
      <div className="flex flex-wrap items-center justify-center gap-2">
        {interactions.canDraw && (
          <Button size="sm" disabled={pending} onClick={() => void submit({ type: 'draw', seat: viewerSeat })}>
            {actionLabel('draw')}
          </Button>
        )}
        {interactions.ownTurnDeclarations.includes('hu') && (
          <Button
            size="sm"
            disabled={pending}
            onClick={() => void submit({ type: 'declare-hu', seat: viewerSeat })}
            className="bg-accent text-accent-foreground hover:bg-accent/90"
          >
            {actionLabel('hu')}
          </Button>
        )}
        {interactions.ownTurnDeclarations.includes('added-kong') && (
          <Button
            size="sm"
            variant="secondary"
            disabled={pending}
            onClick={() => {
              setSelectionMode('added-kong-select');
              setSelectedTileIds([]);
            }}
          >
            {TABLE_STRINGS.addedKongButton}
          </Button>
        )}
        {interactions.ownTurnDeclarations.includes('concealed-kong') && (
          <Button
            size="sm"
            variant="secondary"
            disabled={pending}
            onClick={() => {
              setSelectionMode('concealed-kong-select');
              setSelectedTileIds([]);
            }}
          >
            {TABLE_STRINGS.concealedKongButton}
          </Button>
        )}
      </div>
    ) : null;

  const selectionPrompt =
    selectionMode === 'chow-select' ? (
      <p className="text-xs text-muted-foreground">{TABLE_STRINGS.chowSelectPrompt}</p>
    ) : selectionMode === 'added-kong-select' ? (
      <div className="flex flex-col items-center gap-1">
        <p className="text-xs text-muted-foreground">{TABLE_STRINGS.addedKongSelectPrompt}</p>
        <Button variant="outline" size="sm" disabled={pending} onClick={handleCancelSelection}>
          {TABLE_STRINGS.selectionCancelButton}
        </Button>
      </div>
    ) : selectionMode === 'concealed-kong-select' ? (
      <div className="flex flex-col items-center gap-1">
        <p className="text-xs text-muted-foreground">{TABLE_STRINGS.concealedKongSelectPrompt}</p>
        <Button variant="outline" size="sm" disabled={pending} onClick={handleCancelSelection}>
          {TABLE_STRINGS.selectionCancelButton}
        </Button>
      </div>
    ) : null;

  const rack = viewerPlayer !== null && (
    <div className="flex flex-col items-center gap-2">
      {ownTurnControls}
      {selectionPrompt}
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
  );

  return (
    <div className="relative flex w-full flex-1 flex-col gap-3 overflow-x-hidden p-2 sm:p-4">
      <StatusStrip view={view} connected={connected} />

      {/* Tablet+: classic 4-seat cross layout around a center discard pool. */}
      <div className="hidden flex-1 grid-cols-3 grid-rows-3 items-center justify-items-center gap-2 md:grid">
        {opponentSeats.map((player) => (
          <div key={player.seat} className={QUADRANT_POSITION_CLASSES[seatPositionFor(player.seat, referenceSeat)]}>
            {opponentFor(player)}
          </div>
        ))}
        <div className="col-start-2 row-start-2 flex h-full w-full items-center justify-center">
          <DiscardPool view={view} />
        </div>
        {viewerPlayer !== null && <div className="col-start-2 row-start-3 flex items-end justify-center self-end">{rack}</div>}
      </div>

      {/* Mobile: stacked vertical layout, no horizontal scroll. */}
      <div className="flex flex-1 flex-col gap-3 md:hidden">
        <div className="flex flex-col gap-2">{opponentSeats.map((player) => opponentFor(player))}</div>
        <DiscardPool view={view} />
        {viewerPlayer !== null && <div className="mt-auto flex justify-center pb-2">{rack}</div>}
      </div>

      {interactions.claimBar !== null && selectionMode !== 'chow-select' && (
        <ClaimActionBar offer={interactions.claimBar.offer} pending={pending} onAction={handleClaimAction} />
      )}

      {selectionMode === 'chow-select' && (
        <div className="panel fixed right-4 bottom-4 left-4 z-30 flex flex-col items-center gap-2 rounded-xl p-3 shadow-lg sm:right-auto sm:left-1/2 sm:w-auto sm:-translate-x-1/2">
          <p className="text-xs text-muted-foreground">{TABLE_STRINGS.chowSelectPrompt}</p>
          <div className="flex items-center gap-2">
            <Button
              disabled={pending || selectedTileIds.length !== 2}
              onClick={handleConfirmChow}
              className={cn(TOUCH_TARGET_CLASS, 'bg-accent text-accent-foreground hover:bg-accent/90')}
            >
              {TABLE_STRINGS.chowSelectConfirm}
            </Button>
            <Button variant="outline" disabled={pending} onClick={handleCancelSelection} className={TOUCH_TARGET_CLASS}>
              {TABLE_STRINGS.selectionCancelButton}
            </Button>
          </div>
        </div>
      )}

      {interactions.robPrompt !== null && (
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
      )}

      {view.phase?.type === 'hand-over' && view.phase.result !== undefined && (
        <HandOverPanel
          result={view.phase.result}
          players={view.players}
          onNextHand={interactions.handOver === 'next-hand' ? handleNextHand : undefined}
          pending={nextHandPending}
          isMatchComplete={interactions.handOver === 'match-complete'}
        />
      )}
    </div>
  );
}
