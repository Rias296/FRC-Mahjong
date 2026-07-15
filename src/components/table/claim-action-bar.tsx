import { Button } from '@/components/ui/button';
import { actionLabel } from '@/lib/theme/frc';
import { TABLE_STRINGS } from '@/lib/i18n/table';
import { cn } from '@/lib/utils';
import type { ClaimOffer } from '@/lib/table/interactions';

export interface ClaimActionBarProps {
  readonly offer: readonly ClaimOffer[];
  readonly onAction: (claim: ClaimOffer) => void;
  readonly pending: boolean;
}

const TOUCH_TARGET_CLASS = 'h-11 min-w-11 px-4 text-base';

export function ClaimActionBar({ offer, onAction, pending }: ClaimActionBarProps): React.JSX.Element | null {
  if (offer.length === 0) return null;

  return (
    <div
      className="glass fixed right-4 bottom-4 left-4 z-30 flex flex-wrap items-center justify-center gap-2 rounded-xl p-3 shadow-lg sm:right-auto sm:left-1/2 sm:w-auto sm:-translate-x-1/2"
      role="group"
      aria-label={TABLE_STRINGS.claimActionsLabel}
    >
      {offer.map((claim) =>
        claim === 'hu' ? (
          <Button
            key={claim}
            variant="default"
            disabled={pending}
            onClick={() => onAction(claim)}
            className={cn(TOUCH_TARGET_CLASS, 'bg-accent text-accent-foreground hover:bg-accent/90')}
          >
            {actionLabel('hu')}
          </Button>
        ) : (
          <Button
            key={claim}
            variant={claim === 'pass' ? 'outline' : 'secondary'}
            disabled={pending}
            onClick={() => onAction(claim)}
            className={TOUCH_TARGET_CLASS}
          >
            {actionLabel(claim)}
          </Button>
        ),
      )}
    </div>
  );
}
