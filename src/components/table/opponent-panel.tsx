import { Badge } from '@/components/ui/badge';
import { FaceDownTile, TileFace } from './tile-face';
import { OrnateFrame } from './ornate-frame';
import { COMPACT_TILE_CLASS, meldFaceDown } from '@/lib/table/tile-display';
import { seatLabel } from '@/lib/theme/frc';
import { TABLE_STRINGS } from '@/lib/i18n/table';
import { cn } from '@/lib/utils';
import type { ClientPlayerView } from '@/lib/protocol';

export interface OpponentPanelProps {
  readonly player: ClientPlayerView;
  readonly isCurrentTurn: boolean;
  readonly isDealer: boolean;
  /**
   * Optional turn-timer countdown ring (see turn-timer-ring.tsx), passed in
   * by game-table.tsx only for the seat whose decision window is currently
   * open and that the viewer isn't themselves part of (see that file's
   * `showOpponentTimer` derivation). Rendered in the header row alongside
   * the seat/name/dealer chrome, never over the tile content, per
   * docs/THEME.md's "ornament stays on chrome, never on tiles" rule.
   */
  readonly timer?: React.ReactNode;
}

/**
 * Face-down concealed-hand strip tiles — smaller than COMPACT_TILE_CLASS
 * (melds/flowers) with a horizontal overlap (negative margin via
 * -space-x-*) so a full 16-tile opponent hand fits the new height budget
 * from the md+ fixed-viewport table layout (see game-table.tsx).
 */
const CONCEALED_STRIP_TILE_CLASS = 'h-7 w-5 sm:h-8 sm:w-6';

export function OpponentPanel({ player, isCurrentTurn, isDealer, timer }: OpponentPanelProps): React.JSX.Element {
  return (
    <OrnateFrame
      size="sm"
      className={cn(isCurrentTurn && 'ring-2 ring-frc-blue-text')}
      contentClassName="flex flex-col items-center gap-1.5 p-2"
    >
      <div className="flex items-center gap-1.5">
        <span className="text-xs text-muted-foreground">{seatLabel(player.seat)}</span>
        <span className="text-sm font-medium text-foreground">{player.displayName}</span>
        {isDealer && (
          <Badge variant="secondary" className="text-[10px]">
            {TABLE_STRINGS.dealerBadge}
          </Badge>
        )}
        {timer}
      </div>

      <div className="flex flex-wrap items-center justify-center -space-x-1.5">
        {Array.from({ length: player.concealedCount }, (_, i) => (
          <FaceDownTile key={i} className={CONCEALED_STRIP_TILE_CLASS} />
        ))}
      </div>

      {player.melds.length > 0 && (
        <div className="flex flex-wrap items-center justify-center gap-1">
          {player.melds.map((meld, meldIndex) =>
            meldFaceDown(meld, false) ? (
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
        <div className="flex flex-wrap items-center justify-center gap-0.5">
          {player.flowers.map((tile) => (
            <TileFace key={tile.id} tile={tile} className={COMPACT_TILE_CLASS} />
          ))}
        </div>
      )}
    </OrnateFrame>
  );
}
