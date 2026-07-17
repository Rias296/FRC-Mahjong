import { TileFace } from './tile-face';
import { AnimatedNumber } from './animated-number';
import { OrnateFrame } from './ornate-frame';
import { Button } from '@/components/ui/button';
import { formatMatchPoints, formatTai } from '@/lib/theme/frc';
import { TABLE_STRINGS, paymentLegNarration } from '@/lib/i18n/table';
import { cn } from '@/lib/utils';
import { sumPaymentLegs } from '@/engine/scoring';
import type { ClientPlayerView } from '@/lib/protocol';
import type { HandResult } from '@/engine/game-state';
import type { WinType } from '@/engine/scoring';

export interface HandOverPanelProps {
  readonly result: HandResult;
  readonly players: readonly ClientPlayerView[];
  /**
   * Present only when a next-hand action should be offered (e.g. absent for
   * spectators). This component now only ever renders the "this hand just
   * ended" view — match-complete is handled entirely by MatchStandings,
   * which game-table.tsx renders instead of the table (and this panel) once
   * `view.status === 'finished'`.
   */
  readonly onNextHand?: () => void;
  readonly pending: boolean;
}

const WIN_TYPE_LABELS: Readonly<Record<WinType, string>> = {
  'self-draw': TABLE_STRINGS.winTypeSelfDraw,
  discard: TABLE_STRINGS.winTypeDiscard,
  'robbed-kong': TABLE_STRINGS.winTypeRobbedKong,
};

function nameFor(players: readonly ClientPlayerView[], seat: number): string {
  return players.find((p) => p.seat === seat)?.displayName ?? `Seat ${seat}`;
}

export function HandOverPanel({ result, players, onNextHand, pending }: HandOverPanelProps): React.JSX.Element {
  const deltas = result.kind === 'win' ? sumPaymentLegs(result.legs) : null;

  return (
    <div
      className={cn(
        'fixed inset-0 z-50 flex items-center justify-center bg-background/85 p-4',
        result.kind === 'win' && 'animate-buzzer-edge-flash',
      )}
    >
      <OrnateFrame
        size="md"
        className="w-full max-w-md"
        contentClassName="flex flex-col items-center gap-4 rounded-[calc(var(--radius-md)-2px)] p-6 text-center"
      >
        {result.kind === 'win' ? (
          <>
            <h2 className={cn('font-display text-4xl text-accent', 'animate-buzzer-pulse')}>{TABLE_STRINGS.huHeading}</h2>

            <div className="flex w-full flex-col gap-3">
              {result.winners.map((winner) => (
                <div key={winner.seat} className="flex items-center justify-center gap-3">
                  <TileFace tile={winner.winningTile} />
                  <div className="flex flex-col items-start">
                    <span className="font-medium text-foreground">
                      {nameFor(players, winner.seat)} {TABLE_STRINGS.winsSuffix} — {WIN_TYPE_LABELS[winner.winType]}
                    </span>
                    <span className="text-sm text-muted-foreground">{formatTai(winner.handTai)}</span>
                  </div>
                </div>
              ))}
            </div>

            <div className="flex w-full flex-col gap-1">
              {result.legs.map((leg, index) => (
                <span key={index} className="text-sm text-muted-foreground">
                  {paymentLegNarration(
                    nameFor(players, leg.payerSeat),
                    nameFor(players, leg.payeeSeat),
                    `${formatMatchPoints(leg.amount)} ${TABLE_STRINGS.pointsUnitLabel}`,
                  )}
                </span>
              ))}
            </div>

            {deltas !== null && (
              <div className="flex w-full flex-col gap-1.5 border-t border-border pt-3">
                <span className="font-display text-sm text-foreground">{TABLE_STRINGS.settlementHeading}</span>
                {players
                  .filter((player) => deltas[player.seat] !== 0)
                  .map((player) => {
                    const delta = deltas[player.seat];
                    return (
                      <div key={player.seat} className="flex items-center justify-between gap-3 text-sm">
                        <span className="text-foreground">{player.displayName}</span>
                        <div className="flex items-center gap-2">
                          <span className={cn('font-hud', delta > 0 ? 'text-accent' : 'text-destructive')}>
                            {delta > 0 ? '+' : ''}
                            {formatMatchPoints(delta)}
                          </span>
                          <AnimatedNumber value={player.matchPoints} delta={delta} className="animate-points-pop text-foreground" />
                          <span className="text-xs text-muted-foreground">{TABLE_STRINGS.pointsUnitLabel}</span>
                        </div>
                      </div>
                    );
                  })}
              </div>
            )}

            <span className="text-sm text-foreground">
              {TABLE_STRINGS.nextDealerLabel}: {nameFor(players, result.nextDealerSeat)}
              {result.nextRepeatCount > 0 ? ` (${TABLE_STRINGS.repeatLabel} ${result.nextRepeatCount})` : ''}
            </span>
          </>
        ) : (
          <>
            <h2 className="font-display text-2xl text-foreground">{TABLE_STRINGS.handEndsInDraw}</h2>
            <span className="text-sm text-foreground">
              {TABLE_STRINGS.nextDealerLabel}: {nameFor(players, result.nextDealerSeat)}
              {result.nextRepeatCount > 0 ? ` (${TABLE_STRINGS.repeatLabel} ${result.nextRepeatCount})` : ''}
            </span>
          </>
        )}

        {onNextHand !== undefined && (
          <Button onClick={onNextHand} disabled={pending}>
            {TABLE_STRINGS.nextHandButton}
          </Button>
        )}
      </OrnateFrame>
    </div>
  );
}
