'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { CheckIcon, CopyIcon } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { ClientGameView } from '@/lib/protocol';
import type { Seat } from '@/engine/seats';
import { SEATS } from '@/engine/seats';
import { seatLabel } from '@/lib/theme/frc';
import { LOBBY_STRINGS } from '@/lib/i18n/lobby';

export interface WaitingRoomProps {
  readonly view: ClientGameView;
  readonly viewerSeat: Seat;
}

export function WaitingRoom({ view, viewerSeat }: WaitingRoomProps): React.JSX.Element {
  const [copied, setCopied] = useState(false);

  async function handleCopy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(view.roomCode);
      setCopied(true);
      toast.success(LOBBY_STRINGS.copySuccessToast);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error(LOBBY_STRINGS.copyFailureToast);
    }
  }

  const playerBySeat = new Map(view.players.map((p) => [p.seat, p]));

  return (
    <div className="flex w-full max-w-md flex-col gap-6">
      <Card className="glass">
        <CardHeader className="items-center text-center">
          <CardTitle className="text-sm text-muted-foreground">{LOBBY_STRINGS.roomCodeLabel}</CardTitle>
          <div className="flex items-center gap-3">
            <span className="font-display text-3xl tracking-widest text-foreground">{view.roomCode}</span>
            <Button type="button" variant="outline" size="icon-sm" onClick={handleCopy} aria-label={LOBBY_STRINGS.copyCodeButton}>
              {copied ? <CheckIcon data-icon="inline-start" /> : <CopyIcon data-icon="inline-start" />}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <p className="text-center text-sm text-muted-foreground">{LOBBY_STRINGS.waitingForPlayers}</p>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {SEATS.map((seat) => {
          const player = playerBySeat.get(seat);
          const occupied = player?.occupied ?? false;
          const isViewerSeat = seat === viewerSeat;

          return (
            <Card
              key={seat}
              className={cn('glass', isViewerSeat && 'ring-2 ring-primary')}
            >
              <CardContent className="flex items-center justify-between gap-2">
                <div className="flex flex-col gap-0.5">
                  <span className="text-xs text-muted-foreground">{seatLabel(seat)}</span>
                  <span className={cn('font-medium', !occupied && 'text-muted-foreground italic')}>
                    {occupied ? player?.displayName : LOBBY_STRINGS.waitingForPlayerPlaceholder}
                  </span>
                </div>
                {isViewerSeat && <Badge>{LOBBY_STRINGS.youBadge}</Badge>}
              </CardContent>
            </Card>
          );
        })}
      </div>

      <p className="text-center text-xs text-muted-foreground">{LOBBY_STRINGS.tableViewComingSoon}</p>
    </div>
  );
}
