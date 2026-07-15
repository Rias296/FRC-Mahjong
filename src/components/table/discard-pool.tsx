import { TileFace } from './tile-face';
import { seatPositionFor, type SeatPosition } from '@/lib/table/tile-display';
import { seatLabel } from '@/lib/theme/frc';
import { cn } from '@/lib/utils';
import type { ClientGameView, ClientPlayerView } from '@/lib/protocol';

export interface DiscardPoolProps {
  readonly view: ClientGameView;
}

const GRID_POSITION_CLASSES: Readonly<Record<SeatPosition, string>> = {
  bottom: 'col-start-2 row-start-3 justify-self-center',
  right: 'col-start-3 row-start-2 self-center',
  top: 'col-start-2 row-start-1 justify-self-center',
  left: 'col-start-1 row-start-2 self-center',
};

function SeatDiscardRow({ player }: { readonly player: ClientPlayerView }): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center justify-center gap-0.5" data-testid={`discard-row-${player.seat}`}>
      {player.discards.map((tile) => (
        <TileFace key={tile.id} tile={tile} className="h-8 w-6 sm:h-9 sm:w-7" />
      ))}
    </div>
  );
}

export function DiscardPool({ view }: DiscardPoolProps): React.JSX.Element {
  const referenceSeat = view.viewerSeat ?? 0;
  const pendingDiscard = view.phase?.type === 'awaiting-claims' ? (view.phase.discardedTile ?? null) : null;

  return (
    <div className="flex w-full flex-col items-center justify-center gap-3 p-2">
      {/* Tablet+: spatial grid quadrants matching each seat's table position. */}
      <div className="hidden aspect-square w-full max-w-sm grid-cols-3 grid-rows-3 place-items-center md:grid">
        {view.players.map((player) => (
          <div key={player.seat} className={cn(GRID_POSITION_CLASSES[seatPositionFor(player.seat, referenceSeat)])}>
            <SeatDiscardRow player={player} />
          </div>
        ))}
        {pendingDiscard && (
          <div className="col-start-2 row-start-2 flex items-center justify-center">
            <TileFace tile={pendingDiscard} className="ring-2 ring-accent ring-offset-2 ring-offset-background" />
          </div>
        )}
      </div>

      {/* Mobile: compact labeled stacked rows. */}
      <div className="flex w-full flex-col gap-1.5 md:hidden">
        {view.players.map((player) => (
          <div key={player.seat} className="flex items-center gap-2">
            <span className="w-16 shrink-0 text-xs text-muted-foreground">{seatLabel(player.seat)}</span>
            <SeatDiscardRow player={player} />
          </div>
        ))}
        {pendingDiscard && (
          <div className="flex items-center justify-center py-1">
            <TileFace tile={pendingDiscard} className="ring-2 ring-accent ring-offset-2 ring-offset-background" />
          </div>
        )}
      </div>
    </div>
  );
}
