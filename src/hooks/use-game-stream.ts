'use client';

import { useEffect, useRef, useState } from 'react';
import { gameStreamUrl } from '@/lib/api-client';

export interface UseGameStreamOptions {
  readonly roomCode: string;
  readonly playerToken: string;
  readonly initialSeq?: number;
  readonly enabled?: boolean;
  readonly onSeq: (seq: number) => void;
}

export interface UseGameStreamResult {
  readonly latestSeq: number;
  readonly connected: boolean;
}

function isChangeEventPayload(value: unknown): value is { readonly seq: number } {
  return typeof value === 'object' && value !== null && typeof (value as { seq?: unknown }).seq === 'number';
}

/**
 * Subscribes to a game's SSE change feed and signals the caller when a new
 * seq arrives. This hook never fetches game state itself — it only tracks
 * the latest seq it has seen and connection status; consumers call
 * api-client's `getState` themselves in response to `onSeq`.
 */
export function useGameStream(options: UseGameStreamOptions): UseGameStreamResult {
  const { roomCode, playerToken, initialSeq = 0, enabled = true } = options;

  const [latestSeq, setLatestSeq] = useState(initialSeq);
  const [connected, setConnected] = useState(false);

  const seqRef = useRef(initialSeq);
  // Latest-callback pattern: onSeq is read via a ref, kept current by a
  // render-scoped effect below, so its identity never forces a
  // resubscription of the subscribing effect further down.
  const onSeqRef = useRef(options.onSeq);
  useEffect(() => {
    onSeqRef.current = options.onSeq;
  });

  useEffect(() => {
    if (!enabled) return;

    const source = new EventSource(gameStreamUrl(roomCode, playerToken, seqRef.current));

    source.onopen = () => {
      setConnected(true);
    };

    source.onerror = () => {
      if (source.readyState === EventSource.CLOSED) {
        source.close();
      }
      // Whether closed-for-good or a transient drop with native retry in
      // flight, the connection is not currently up.
      setConnected(false);
    };

    source.addEventListener('change', (event: MessageEvent<string>) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!isChangeEventPayload(parsed)) return;

      if (parsed.seq > seqRef.current) {
        seqRef.current = parsed.seq;
        setLatestSeq(parsed.seq);
        onSeqRef.current(parsed.seq);
      }
    });

    return () => {
      source.close();
      setConnected(false);
    };
  }, [roomCode, playerToken, enabled]);

  return { latestSeq, connected };
}
