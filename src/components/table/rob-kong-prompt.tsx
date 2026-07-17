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

/**
 * Below md, the game screen still scrolls (mobile zero-scroll is out of
 * scope this round), so this stays viewport-`fixed` there. On md+ it must
 * NOT stay viewport-fixed: the always-visible rack now sits flush against
 * the true viewport bottom (see game-table.tsx's fixed-viewport grid), so a
 * `bottom-4`-from-viewport prompt would sit directly on top of the local
 * rack right when the player needs to see their hand to decide whether to
 * rob. Anchored above/right of the rack instead, same pattern as
 * ClaimActionBar — the caller renders this inside that component's
 * `relative` rack wrapper.
 */
const POSITION_CLASS =
  'fixed right-4 bottom-4 left-4 z-30 sm:right-auto sm:left-1/2 sm:w-auto sm:-translate-x-1/2 md:absolute md:right-2 md:bottom-full md:left-auto md:mb-2 md:w-auto md:translate-x-0';

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
        className={cn('panel-plaque flex flex-col items-center gap-3 rounded-xl p-4 shadow-lg', POSITION_CLASS)}
        role="group"
        aria-label={TABLE_STRINGS.robKongPromptLabel}
      >
        {kongTileVisible !== null && <TileFace tile={kongTileVisible} className="h-20 w-14 scale-125" />}
        <div className="flex items-center gap-2">
          <Button variant="lacquer" disabled={pending} onClick={onRob} className={TOUCH_TARGET_CLASS}>
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
      className={cn('panel-plaque flex flex-col items-center gap-2 rounded-xl p-4 shadow-lg', POSITION_CLASS)}
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
