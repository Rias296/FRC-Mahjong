import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { OrnateFrame } from './ornate-frame';
import { RankBadge } from '@/components/ranked/rank-badge';
import { computeStandings, type SeatTotals } from '@/engine/scoring';
import { asTierBand, formatMatchPoints, formatRankPoints, statusLabel } from '@/lib/theme/frc';
import { TABLE_STRINGS, placeLabel } from '@/lib/i18n/table';
import { cn } from '@/lib/utils';
import type { ClientGameView, ClientPlayerView } from '@/lib/protocol';

export interface MatchStandingsProps {
  /** ClientGameView.players, already in seat order (East=0..North=3, see views.ts). */
  readonly players: readonly ClientPlayerView[];
  /**
   * ClientGameView.ranked, when present. Absent/`'unranked'`/`'pending'`
   * render the exact same layout as an unranked casual match — no
   * ranked-related additions — per the plan: an unranked match must look
   * unchanged. Only `'settled'` adds a per-row RP delta + tier badge.
   */
  readonly ranked?: ClientGameView['ranked'];
}

function nameFor(players: readonly ClientPlayerView[], seat: number): string {
  return players.find((p) => p.seat === seat)?.displayName ?? `Seat ${seat}`;
}

/**
 * Full-screen end-of-match standings, rendered by game-table.tsx in place of
 * the normal table/HandOverPanel once `view.status === 'finished'`. Ranks
 * seats via the engine's `computeStandings` (never hand-rolled) and shows
 * each seat's final match-points total, plus (when this was a ranked match)
 * that seat's RP delta and resulting tier badge.
 */
export function MatchStandings({ players, ranked }: MatchStandingsProps): React.JSX.Element {
  const totals = players.reduce<[number, number, number, number]>(
    (acc, player) => {
      acc[player.seat] = player.matchPoints;
      return acc;
    },
    [0, 0, 0, 0],
  ) as SeatTotals;
  const standings = computeStandings(totals);
  const rankedSeats = ranked?.status === 'settled' ? ranked.seats : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/85 p-4">
      <OrnateFrame
        size="md"
        className="w-full max-w-md"
        contentClassName="flex flex-col items-center gap-4 rounded-[calc(var(--radius-md)-2px)] p-6 text-center"
      >
        <h2 className="font-display text-2xl text-accent">{statusLabel('finished')}</h2>
        <h3 className="font-display text-lg text-foreground">{TABLE_STRINGS.standingsHeading}</h3>

        <div className="flex w-full flex-col gap-2">
          {standings.map((standing) => {
            const rankedSeat = rankedSeats?.find((s) => s.seat === standing.seat) ?? null;
            return (
              <div
                key={standing.seat}
                className={cn(
                  'flex w-full items-center justify-between gap-3 rounded-lg border border-accent/30 px-3 py-2',
                  standing.place === 1 && 'border-accent',
                )}
              >
                <div className="flex items-center gap-2">
                  {standing.place === 1 && (
                    <span
                      className="-rotate-6 rounded-sm border-2 border-accent bg-accent/10 px-1.5 py-0.5 font-serif text-[10px] font-semibold tracking-wide text-accent uppercase"
                      aria-hidden="true"
                    >
                      {TABLE_STRINGS.championLabel}
                    </span>
                  )}
                  {rankedSeat !== null && <RankBadge tier={asTierBand(rankedSeat.tier)} division={rankedSeat.division} />}
                  <span className="font-display text-sm text-foreground">{placeLabel(standing.place)}</span>
                  <span className="text-sm font-medium text-foreground">{nameFor(players, standing.seat)}</span>
                </div>
                <div className="flex flex-col items-end gap-0.5">
                  <span className="font-hud text-accent">
                    {formatMatchPoints(standing.points)} {TABLE_STRINGS.pointsUnitLabel}
                  </span>
                  {rankedSeat !== null && (
                    <span className={cn('font-hud text-xs', rankedSeat.rpDelta > 0 ? 'text-accent' : 'text-destructive')}>
                      {rankedSeat.rpDelta > 0 ? '+' : ''}
                      {formatRankPoints(rankedSeat.rpDelta)}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <Button render={<Link href="/" />} variant="secondary">
          {TABLE_STRINGS.backToHomeButton}
        </Button>
      </OrnateFrame>
    </div>
  );
}
