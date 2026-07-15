'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { JoinRoomForm } from '@/components/lobby/join-room-form';
import { getState } from '@/lib/api-client';
import { clearSession, loadSession, type GameSession } from '@/lib/session';
import { useGameStream } from '@/hooks/use-game-stream';
import { LOBBY_STRINGS } from '@/lib/i18n/lobby';
import type { ClientGameView } from '@/lib/protocol';
import { GameTable } from '@/components/table/game-table';
import { WaitingRoom } from './waiting-room';

type Mode = 'checking' | 'need-join' | 'loading' | 'view' | 'not-found' | 'fetch-error';

const WAITING_POLL_INTERVAL_MS = 3000;

export interface RoomClientProps {
  readonly code: string;
}

function countOccupied(view: ClientGameView): number {
  return view.players.filter((p) => p.occupied).length;
}

export function RoomClient({ code }: RoomClientProps): React.JSX.Element {
  const [session, setSession] = useState<GameSession | null>(null);
  const [mode, setMode] = useState<Mode>('checking');
  const [view, setView] = useState<ClientGameView | null>(null);
  const [errorKind, setErrorKind] = useState<'network-error' | 'server-error' | null>(null);

  /**
   * Replaces the current view iff `next` is strictly newer, OR ties on seq
   * AND is at least as "joined" as the current view. Guards against an
   * out-of-order poll response transiently "un-joining" a player: every
   * waiting-phase view reports seq=0 (see state route.ts), so seq alone
   * can't order two waiting-phase reads relative to each other.
   */
  const applyView = useCallback((next: ClientGameView) => {
    setView((current) => {
      if (current === null) return next;
      if (next.seq > current.seq) return next;
      if (next.seq === current.seq && countOccupied(next) >= countOccupied(current)) return next;
      return current;
    });
    setMode('view');
    setErrorKind(null);
  }, []);

  const fetchState = useCallback(
    async (currentSession: GameSession) => {
      const result = await getState(code, currentSession.playerToken);
      if (result.ok) {
        applyView(result.data);
        return;
      }
      switch (result.error.kind) {
        case 'unauthorized':
          clearSession();
          setSession(null);
          setMode('need-join');
          break;
        case 'not-found':
          // Only clear the stored session if it's the dead one for THIS room.
          if (currentSession.roomCode === code) clearSession();
          setMode('not-found');
          break;
        case 'network-error':
          setErrorKind('network-error');
          setMode('fetch-error');
          toast.error(LOBBY_STRINGS.errorNetwork);
          break;
        default:
          setErrorKind('server-error');
          setMode('fetch-error');
          toast.error(LOBBY_STRINGS.errorServer);
          break;
      }
    },
    [code, applyView],
  );

  // Initial session check + first fetch, once per room code. localStorage is
  // browser-only, so this must be a post-mount effect (not computed during
  // render) to avoid an SSR hydration mismatch — a one-shot read of
  // already-persisted session state, not an external-store subscription.
  useEffect(() => {
    const stored = loadSession();
    if (stored === null || stored.roomCode !== code) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSession(null);
      setMode('need-join');
      return;
    }
    setSession(stored);
    setMode('loading');
    void fetchState(stored);
  }, [code, fetchState]);

  function handleJoined(newSession: GameSession): void {
    setSession(newSession);
    setMode('loading');
    void fetchState(newSession);
  }

  function handleRetry(): void {
    if (session === null) return;
    setMode('loading');
    void fetchState(session);
  }

  const fatalError = mode === 'not-found';
  const hasValidSession = session !== null;

  const { connected } = useGameStream({
    roomCode: code,
    playerToken: session?.playerToken ?? '',
    initialSeq: view?.seq ?? 0,
    enabled: hasValidSession && !fatalError,
    onSeq: () => {
      if (session !== null) void fetchState(session);
    },
  });

  // Joins for seats 1-3 append no action-log row and never trigger an SSE
  // `change` event (only the 4th join's start-hand append does) — poll while
  // waiting for the table to fill so newly-joined seats still show up live.
  useEffect(() => {
    if (view?.status !== 'waiting-for-players' || session === null) return;
    const interval = setInterval(() => {
      void fetchState(session);
    }, WAITING_POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [view?.status, session, fetchState]);

  // Mobile browsers suspend EventSource in the background — refetch once
  // when the tab becomes visible again so a backgrounded player doesn't
  // return to a stale view.
  useEffect(() => {
    if (session === null) return;
    function handleVisibilityChange(): void {
      if (document.visibilityState === 'visible' && session !== null) {
        void fetchState(session);
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [session, fetchState]);

  if (mode === 'need-join') {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-6 px-4 py-12">
        <Card className="glass w-full max-w-md">
          <CardHeader>
            <CardTitle>{LOBBY_STRINGS.joinThisMatchHeading}</CardTitle>
          </CardHeader>
          <CardContent>
            <JoinRoomForm initialCode={code} lockCode onJoined={handleJoined} />
          </CardContent>
        </Card>
      </div>
    );
  }

  if (mode === 'not-found') {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 px-4 py-12 text-center">
        <h1 className="font-display text-2xl text-foreground">{LOBBY_STRINGS.matchNotFoundHeading}</h1>
        <p className="max-w-md text-muted-foreground">{LOBBY_STRINGS.matchNotFoundBody}</p>
        <Button render={<Link href="/" />}>{LOBBY_STRINGS.backToHomeButton}</Button>
      </div>
    );
  }

  if (mode === 'checking' || mode === 'loading' || mode === 'fetch-error') {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 px-4 py-12">
        <div className="flex w-full max-w-md flex-col gap-3">
          <Skeleton className="h-28 w-full rounded-xl" />
          <Skeleton className="h-16 w-full rounded-xl" />
          <Skeleton className="h-16 w-full rounded-xl" />
        </div>
        {mode === 'fetch-error' && (
          <div className="flex flex-col items-center gap-2">
            <p className="text-sm text-muted-foreground">
              {errorKind === 'network-error' ? LOBBY_STRINGS.errorNetwork : LOBBY_STRINGS.errorServer}
            </p>
            <Button onClick={handleRetry}>{LOBBY_STRINGS.retryButton}</Button>
          </div>
        )}
      </div>
    );
  }

  // mode === 'view' — reached only via applyView, which always sets a non-null view.
  if (view === null || session === null) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-4 py-12">
        <Skeleton className="h-28 w-full max-w-md rounded-xl" />
      </div>
    );
  }

  if (view.status === 'waiting-for-players') {
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-4 py-12">
        <WaitingRoom view={view} viewerSeat={session.seat} />
      </div>
    );
  }

  return (
    <GameTable
      view={view}
      connected={connected}
      code={code}
      playerToken={session.playerToken}
      onViewUpdate={applyView}
      onResync={() => void fetchState(session)}
    />
  );
}
