import { Badge } from '@/components/ui/badge';
import { FaceDownTile, TileFace } from './tile-face';
import { OrnateFrame } from './ornate-frame';
import { COMPACT_TILE_CLASS, meldFaceDown, sortTilesForDisplay } from '@/lib/table/tile-display';
import { TABLE_STRINGS } from '@/lib/i18n/table';
import { cn } from '@/lib/utils';
import type { ClientPlayerView, ClientTile } from '@/lib/protocol';

export type RackSelectionMode = 'none' | 'chow-select' | 'added-kong-select' | 'concealed-kong-select';

/**
 * Local-rack (viewer's own hand) tile size — exact integer multiples of the
 * source sprite art geometry (44x60 art within a 64px cell; see
 * src/lib/table/tile-sprites.ts's ART_W/ART_H) at each breakpoint, so tiles
 * never render with non-integer aspect distortion:
 *   md-xl:  1x   -> 44x60
 *   xl:     1.5x -> 66x90 (a deliberate half-step — 2x cannot fit 17 tiles
 *                   at the 1366px xl breakpoint)
 *   2xl:    2x   -> 88x120
 * Below md, the default TileFace size (TILE_SIZE_CLASSES) is kept as-is.
 */
const RACK_TILE_CLASS = 'md:h-[60px] md:w-[44px] xl:h-[90px] xl:w-[66px] 2xl:h-[120px] 2xl:w-[88px]';

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
          RACK_TILE_CLASS,
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
    <OrnateFrame size="md" contentClassName="flex flex-col items-center gap-2 p-2">
      {player.barredVisible === true && <Badge variant="destructive">{TABLE_STRINGS.barredBadge}</Badge>}

      {player.melds.length > 0 && (
        <div className="flex flex-wrap items-center justify-center gap-2">
          {player.melds.map((meld, meldIndex) =>
            meldFaceDown(meld, true) ? (
              <div key={meldIndex} className="flex gap-0.5">
                {[0, 1, 2, 3].map((i) => (
                  <FaceDownTile key={i} className={COMPACT_TILE_CLASS} />
                ))}
              </div>
            ) : (
              <div key={meldIndex} className="flex gap-0.5">
                {meld.tiles.map((tile) => (
                  <TileFace key={tile.id} tile={tile} className={COMPACT_TILE_CLASS} />
                ))}
              </div>
            ),
          )}
        </div>
      )}

      {player.flowers.length > 0 && (
        <div className="flex flex-wrap items-center justify-center gap-1">
          {player.flowers.map((tile) => (
            <TileFace key={tile.id} tile={tile} className={COMPACT_TILE_CLASS} />
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-center gap-1">
        {sortedRest.map((tile) => renderTile(tile))}
        {drawnTile != null && renderTile(drawnTile, 'ml-2')}
      </div>
    </OrnateFrame>
  );
}
