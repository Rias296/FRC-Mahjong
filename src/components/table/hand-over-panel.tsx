import Link from 'next/link';
import { TileFace } from './tile-face';
import { Button } from '@/components/ui/button';
import { formatTai, statusLabel } from '@/lib/theme/frc';
import { TABLE_STRINGS, paymentLegNarration } from '@/lib/i18n/table';
import { cn } from '@/lib/utils';
import type { ClientPlayerView } from '@/lib/protocol';
import type { HandResult } from '@/engine/game-state';
import type { WinType } from '@/engine/scoring';

export interface HandOverPanelProps {
  readonly result: HandResult;
  readonly players: readonly ClientPlayerView[];
  /** Present only when a next-hand action should be offered (not match-complete). */
  readonly onNextHand?: () => void;
  readonly pending: boolean;
  readonly isMatchComplete: boolean;
}

const WIN_TYPE_LABELS: Readonly<Record<WinType, string>> = {
  'self-draw': TABLE_STRINGS.winTypeSelfDraw,
  discard: TABLE_STRINGS.winTypeDiscard,
  'robbed-kong': TABLE_STRINGS.winTypeRobbedKong,
};

function nameFor(players: readonly ClientPlayerView[], seat: number): string {
  return players.find((p) => p.seat === seat)?.displayName ?? `Seat ${seat}`;
}

export function HandOverPanel({
  result,
  players,
  onNextHand,
  pending,
  isMatchComplete,
}: HandOverPanelProps): React.JSX.Element {
  return (
    <div
      className={cn(
        'fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm',
      )}
    >
      <div className="glass flex w-full max-w-md flex-col items-center gap-4 rounded-xl p-6 text-center">
        {isMatchComplete && (
          <h2 className="font-display text-2xl text-accent">{statusLabel('finished')}</h2>
        )}

        {result.kind === 'win' ? (
          <>
            {!isMatchComplete && (
              <h2 className={cn('font-display text-4xl text-accent', 'animate-buzzer-pulse')}>
                {TABLE_STRINGS.huHeading}
              </h2>
            )}

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
                    formatTai(leg.amount),
                  )}
                </span>
              ))}
            </div>

            {!isMatchComplete && (
              <span className="text-sm text-foreground">
                {TABLE_STRINGS.nextDealerLabel}: {nameFor(players, result.nextDealerSeat)}
                {result.nextRepeatCount > 0 ? ` (${TABLE_STRINGS.repeatLabel} ${result.nextRepeatCount})` : ''}
              </span>
            )}
          </>
        ) : (
          <>
            {!isMatchComplete && <h2 className="font-display text-2xl text-foreground">{TABLE_STRINGS.handEndsInDraw}</h2>}
            {!isMatchComplete && (
              <span className="text-sm text-foreground">
                {TABLE_STRINGS.nextDealerLabel}: {nameFor(players, result.nextDealerSeat)}
                {result.nextRepeatCount > 0 ? ` (${TABLE_STRINGS.repeatLabel} ${result.nextRepeatCount})` : ''}
              </span>
            )}
          </>
        )}

        {isMatchComplete && (
          <Button render={<Link href="/" />} variant="secondary">
            {TABLE_STRINGS.backToHomeButton}
          </Button>
        )}

        {!isMatchComplete && onNextHand !== undefined && (
          <Button onClick={onNextHand} disabled={pending}>
            {TABLE_STRINGS.nextHandButton}
          </Button>
        )}
      </div>
    </div>
  );
}
