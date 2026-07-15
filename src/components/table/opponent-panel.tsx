import { Badge } from '@/components/ui/badge';
import { FaceDownTile, TileFace } from './tile-face';
import { meldFaceDown } from '@/lib/table/tile-display';
import { seatLabel } from '@/lib/theme/frc';
import { TABLE_STRINGS } from '@/lib/i18n/table';
import { cn } from '@/lib/utils';
import type { ClientPlayerView } from '@/lib/protocol';

export interface OpponentPanelProps {
  readonly player: ClientPlayerView;
  readonly isCurrentTurn: boolean;
  readonly isDealer: boolean;
}

const COMPACT_TILE_CLASS = 'h-8 w-6 sm:h-9 sm:w-7';

export function OpponentPanel({ player, isCurrentTurn, isDealer }: OpponentPanelProps): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex flex-col items-center gap-1.5 rounded-lg p-2',
        isCurrentTurn && 'ring-2 ring-primary',
      )}
    >
      <div className="flex items-center gap-1.5">
        <span className="text-xs text-muted-foreground">{seatLabel(player.seat)}</span>
        <span className="text-sm font-medium text-foreground">{player.displayName}</span>
        {isDealer && (
          <Badge variant="secondary" className="text-[10px]">
            {TABLE_STRINGS.dealerBadge}
          </Badge>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-center gap-0.5">
        {Array.from({ length: player.concealedCount }, (_, i) => (
          <FaceDownTile key={i} className={COMPACT_TILE_CLASS} />
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
    </div>
  );
}
