import { Badge } from '@/components/ui/badge';
import { OrnateFrame } from './ornate-frame';
import { formatMatchPoints, prevailingWindLabel, seatWindLabel } from '@/lib/theme/frc';
import { TABLE_STRINGS } from '@/lib/i18n/table';
import type { ClientGameView } from '@/lib/protocol';

export interface CenterScoreboardProps {
  readonly view: ClientGameView;
}

/**
 * Always-visible center-table scoreboard: hand number, prevailing wind, wall
 * remaining, and one row per seat (wind / display name / match points) with
 * a dealer marker. Single-line-per-seat so all 4 totals stay visible without
 * clipping inside the table grid's fixed-height center cell down to
 * 1024x768 (the smallest supported tablet-landscape size — see game-table.tsx's
 * min-h-0/overflow-hidden grid). Replaces the status-strip fields that moved
 * here (see status-strip.tsx) and the per-seat points HUD that used to live
 * in PlayerRack/OpponentPanel (see those files' doc comments).
 */
export function CenterScoreboard({ view }: CenterScoreboardProps): React.JSX.Element {
  return (
    <OrnateFrame
      size="sm"
      role="region"
      aria-label={TABLE_STRINGS.scoreboardLabel}
      className="w-full max-w-[168px] shrink-0"
      contentClassName="flex flex-col items-center gap-1 p-1.5 text-xs"
    >
      <div className="flex flex-wrap items-center justify-center gap-x-2 font-hud text-accent leading-tight">
        {view.handNumber !== null && (
          <span>
            {TABLE_STRINGS.handLabel} {view.handNumber}
          </span>
        )}
        {view.prevailingWind !== null && <span className="text-muted-foreground">{prevailingWindLabel(view.prevailingWind)}</span>}
        {view.wallRemaining !== null && (
          <span className="text-muted-foreground">
            {TABLE_STRINGS.wallLabel}: {view.wallRemaining}
          </span>
        )}
      </div>

      <div className="flex w-full flex-col gap-0.5">
        {view.players.map((player) => (
          <div key={player.seat} className="flex min-w-0 items-center gap-1 leading-tight">
            <span className="w-4 shrink-0 text-[10px] text-muted-foreground">{seatWindLabel(player.seat)[0]}</span>
            {view.dealerSeat === player.seat && (
              <Badge variant="secondary" className="h-3.5 shrink-0 px-1 text-[9px] leading-none">
                {TABLE_STRINGS.dealerBadge}
              </Badge>
            )}
            <span className="min-w-0 flex-1 truncate text-foreground">{player.displayName}</span>
            <span className="font-hud shrink-0 text-accent">{formatMatchPoints(player.matchPoints)}</span>
          </div>
        ))}
      </div>
    </OrnateFrame>
  );
}
