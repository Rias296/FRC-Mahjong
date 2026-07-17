import { Badge } from '@/components/ui/badge';
import { TABLE_STRINGS } from '@/lib/i18n/table';
import { cn } from '@/lib/utils';
import type { ClientGameView } from '@/lib/protocol';

export interface StatusStripProps {
  readonly view: ClientGameView;
  readonly connected: boolean;
}

/**
 * Slimmed status strip — connection dot + current-turn player name +
 * dealer/repeat badge only. Hand number, prevailing wind, and wall count
 * moved to CenterScoreboard (see center-scoreboard.tsx).
 */
export function StatusStrip({ view, connected }: StatusStripProps): React.JSX.Element {
  const currentTurnPlayer = view.players.find((p) => p.seat === view.currentTurnSeat) ?? null;
  const dealerPlayer = view.players.find((p) => p.seat === view.dealerSeat) ?? null;

  return (
    <div className="panel-plaque flex w-full flex-wrap items-center justify-center gap-x-4 gap-y-1 rounded-lg px-4 py-2 text-sm">
      {currentTurnPlayer !== null && (
        <span className="text-muted-foreground">
          {TABLE_STRINGS.currentTurnLabel}: <span className="text-foreground">{currentTurnPlayer.displayName}</span>
        </span>
      )}

      {dealerPlayer !== null && (
        <Badge variant="secondary">
          {TABLE_STRINGS.dealerLabel}: {dealerPlayer.displayName}
          {view.repeatCount !== null && view.repeatCount > 0 ? ` (${TABLE_STRINGS.repeatLabel} ${view.repeatCount})` : ''}
        </Badge>
      )}

      <span
        className={cn('ml-auto size-2 rounded-full', connected ? 'bg-success' : 'bg-muted-foreground')}
        aria-hidden="true"
      />
    </div>
  );
}
