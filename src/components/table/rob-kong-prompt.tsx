import { Button } from '@/components/ui/button';
import { TileFace } from './tile-face';
import { actionLabel } from '@/lib/theme/frc';
import { TABLE_STRINGS, waitingOnPlayersNarration } from '@/lib/i18n/table';
import { cn } from '@/lib/utils';
import type { ClientTile } from '@/lib/protocol';

export interface RobKongPromptProps {
  readonly state: 'choose' | 'waiting-declarer' | 'waiting-bystander';
  readonly kongTileVisible: ClientTile | null;
  readonly stillWaitingCount: number | undefined;
  readonly onRob: () => void;
  readonly onPass: () => void;
  readonly pending: boolean;
}

const TOUCH_TARGET_CLASS = 'h-11 min-w-11 px-4 text-base';

export function RobKongPrompt({
  state,
  kongTileVisible,
  stillWaitingCount,
  onRob,
  onPass,
  pending,
}: RobKongPromptProps): React.JSX.Element {
  if (state === 'choose') {
    return (
      <div
        className="glass fixed right-4 bottom-4 left-4 z-30 flex flex-col items-center gap-3 rounded-xl p-4 shadow-lg sm:right-auto sm:left-1/2 sm:w-auto sm:-translate-x-1/2"
        role="group"
        aria-label={TABLE_STRINGS.robKongPromptLabel}
      >
        {kongTileVisible !== null && <TileFace tile={kongTileVisible} className="h-20 w-14 scale-125" />}
        <div className="flex items-center gap-2">
          <Button
            variant="default"
            disabled={pending}
            onClick={onRob}
            className={cn(TOUCH_TARGET_CLASS, 'bg-accent text-accent-foreground hover:bg-accent/90')}
          >
            {actionLabel('rob')}
          </Button>
          <Button variant="outline" disabled={pending} onClick={onPass} className={TOUCH_TARGET_CLASS}>
            {actionLabel('pass')}
          </Button>
        </div>
        <p className="max-w-xs text-center text-xs text-muted-foreground">{TABLE_STRINGS.robWindowNote}</p>
      </div>
    );
  }

  const waitingLabel = state === 'waiting-declarer' ? TABLE_STRINGS.robWaitingDeclarer : TABLE_STRINGS.robWaitingBystander;

  return (
    <div
      className="glass fixed right-4 bottom-4 left-4 z-30 flex flex-col items-center gap-2 rounded-xl p-4 shadow-lg sm:right-auto sm:left-1/2 sm:w-auto sm:-translate-x-1/2"
      role="status"
      aria-live="polite"
    >
      <span className="text-sm text-foreground">
        {waitingLabel} {waitingOnPlayersNarration(stillWaitingCount)}
      </span>
      {state === 'waiting-bystander' && kongTileVisible !== null && <TileFace tile={kongTileVisible} />}
      {state === 'waiting-bystander' && kongTileVisible === null && (
        <span className="text-xs text-muted-foreground">{TABLE_STRINGS.concealedKongDeclaredNote}</span>
      )}
    </div>
  );
}
