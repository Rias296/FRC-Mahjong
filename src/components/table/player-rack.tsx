import { Badge } from '@/components/ui/badge';
import { FaceDownTile, TileFace } from './tile-face';
import { meldFaceDown, sortTilesForDisplay } from '@/lib/table/tile-display';
import { TABLE_STRINGS } from '@/lib/i18n/table';
import { cn } from '@/lib/utils';
import type { ClientPlayerView, ClientTile } from '@/lib/protocol';

export type RackSelectionMode = 'none' | 'chow-select' | 'added-kong-select' | 'concealed-kong-select';

export interface PlayerRackProps {
  readonly player: ClientPlayerView;
  /**
   * The viewer's just-drawn tile, if any (from ClientPhaseView's
   * drawnTileForViewer — this component doesn't know its own phase, so the
   * caller passes it through). When present, it's rendered visually
   * separated at the end of the hand row rather than sorted in.
   */
  readonly drawnTile?: ClientTile | null;
  /** True iff the viewer may discard right now (awaiting-discard, their turn). */
  readonly canDiscard?: boolean;
  /** Called with the tapped tile's id when a discard-mode tap occurs. */
  readonly onDiscard?: (tileId: string) => void;
  /** When not 'none', tile taps toggle selection instead of discarding. */
  readonly selectionMode?: RackSelectionMode;
  readonly selectedTileIds?: readonly string[];
  readonly onToggleTileSelection?: (tileId: string) => void;
  /** True while an action submission is in flight — disables all tile taps. */
  readonly pending?: boolean;
}

export function PlayerRack({
  player,
  drawnTile,
  canDiscard = false,
  onDiscard,
  selectionMode = 'none',
  selectedTileIds = [],
  onToggleTileSelection,
  pending = false,
}: PlayerRackProps): React.JSX.Element {
  const allConcealed = player.concealedTiles ?? [];
  const restTiles =
    drawnTile != null ? allConcealed.filter((t) => t.id !== drawnTile.id) : allConcealed;
  const sortedRest = sortTilesForDisplay(restTiles);

  const tappable = !pending && (selectionMode !== 'none' || (canDiscard && onDiscard !== undefined));

  function handleTileTap(tileId: string): void {
    if (pending) return;
    if (selectionMode !== 'none') {
      onToggleTileSelection?.(tileId);
      return;
    }
    if (canDiscard) {
      onDiscard?.(tileId);
    }
  }

  function renderTile(tile: ClientTile, extraClassName?: string): React.JSX.Element {
    const selected = selectedTileIds.includes(tile.id);
    const tileFace = (
      <TileFace
        tile={tile}
        className={cn(
          extraClassName,
          selected && 'ring-2 ring-accent ring-offset-2 ring-offset-background -translate-y-1',
        )}
      />
    );

    if (!tappable) {
      return <span key={tile.id}>{tileFace}</span>;
    }

    return (
      <button
        key={tile.id}
        type="button"
        onClick={() => handleTileTap(tile.id)}
        className="min-h-11 min-w-11 cursor-pointer rounded-md border-0 bg-transparent p-0 transition-transform hover:-translate-y-1"
        aria-pressed={selectionMode !== 'none' ? selected : undefined}
      >
        {tileFace}
      </button>
    );
  }

  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-primary-hover/70 p-2">
      {player.barredVisible === true && <Badge variant="destructive">{TABLE_STRINGS.barredBadge}</Badge>}

      {player.melds.length > 0 && (
        <div className="flex flex-wrap items-center justify-center gap-2">
          {player.melds.map((meld, meldIndex) =>
            meldFaceDown(meld, true) ? (
              <div key={meldIndex} className="flex gap-0.5">
                {[0, 1, 2, 3].map((i) => (
                  <FaceDownTile key={i} />
                ))}
              </div>
            ) : (
              <div key={meldIndex} className="flex gap-0.5">
                {meld.tiles.map((tile) => (
                  <TileFace key={tile.id} tile={tile} />
                ))}
              </div>
            ),
          )}
        </div>
      )}

      {player.flowers.length > 0 && (
        <div className="flex flex-wrap items-center justify-center gap-1">
          {player.flowers.map((tile) => (
            <TileFace key={tile.id} tile={tile} className="scale-[0.8]" />
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-center gap-1">
        {sortedRest.map((tile) => renderTile(tile))}
        {drawnTile != null && renderTile(drawnTile, 'ml-2')}
      </div>
    </div>
  );
}
