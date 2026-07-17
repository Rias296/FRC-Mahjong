'use client';

import { useEffect, useState } from 'react';
import { remainingMs, ringFraction } from '@/lib/table/timer-display';
import { turnTimerAriaLabel } from '@/lib/i18n/table';
import { cn } from '@/lib/utils';

export interface TurnTimerRingProps {
  /** Epoch-ms deadline of the currently-open decision window; null renders nothing. */
  readonly turnDeadline: number | null;
  /** The server's epoch-ms clock at the moment `turnDeadline` was fetched (see ClientGameView doc comment). */
  readonly serverNow: number;
  readonly turnTimerSeconds: number | null;
  readonly className?: string;
}

const RADIUS = 15;
const STROKE_WIDTH = 3;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
/** Below this many ms remaining, the ring/numeral switch from gold to lacquer-red. */
const CRITICAL_MS = 5_000;
/** Reduced-motion tick cadence: once a second (a "static numeral"), not a smooth rAF sweep. */
const REDUCED_MOTION_TICK_MS = 1_000;

/**
 * Matches the same `prefers-reduced-motion` check convention as
 * animated-number.tsx: a plain synchronous browser-API read during render,
 * not stateful — safe because it only gates which effect/branch runs below,
 * it never itself needs to trigger a re-render.
 */
function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * SVG circular countdown ring + a VT323 HUD numeral, reflecting the
 * server-authoritative `turnDeadline`/`serverNow` (see `ClientGameView`'s
 * doc comment and `src/lib/table/timer-display.ts`). Pure display: the
 * server enforces timeouts (`src/server/turn-timer.ts`); this component
 * never fabricates a client-side auto-discard/auto-pass action, it just
 * renders a countdown that may sit at 0 for a moment before the next
 * poll/SSE tick delivers the server's actual timeout action.
 *
 * `clientNowAtReceipt` is captured internally (not a prop) the instant
 * `serverNow`/`turnDeadline` change, i.e. every time the surrounding view
 * refetches — so the clock-offset correction is re-derived fresh on every
 * prop change rather than accumulating client-side drift across refetches.
 */
export function TurnTimerRing({
  turnDeadline,
  serverNow,
  turnTimerSeconds,
  className,
}: TurnTimerRingProps): React.JSX.Element | null {
  const reduced = prefersReducedMotion();
  // Lazy initializers only run once, at mount, and are the one render-phase
  // exception React's purity rule allows for an impure read like Date.now()
  // — this gives the very first render a reasonable (if not yet
  // window-anchored) clock-offset pairing; the effect below re-anchors it
  // properly on this and every subsequent window/refetch.
  const [clientNowAtReceipt, setClientNowAtReceipt] = useState<number>(() => Date.now());
  const [now, setNow] = useState<number>(() => Date.now());

  // Re-anchors the clock-offset capture every time the server hands us a
  // fresh deadline/serverNow pair (a new window, or just a routine
  // poll/SSE refresh of the same window), then ticks `now` forward so the
  // countdown re-renders. Every setState call below is reachable only from
  // inside an rAF/interval callback — never called synchronously at the top
  // level of the effect body — so this is the "subscribe to an external
  // system (the wall clock), setState when it changes" pattern effects are
  // for, not the "mirror a prop into state" anti-pattern the
  // react-hooks/set-state-in-effect rule flags. (A synchronous first call
  // would also violate react-hooks/purity, since Date.now() is impure.)
  useEffect(() => {
    if (turnDeadline === null) return undefined;

    let cancelled = false;
    let frameId: number | undefined;
    let intervalId: number | undefined;

    function anchorAndStart(): void {
      if (cancelled) return;
      const receipt = Date.now();
      setClientNowAtReceipt(receipt);
      setNow(receipt);

      if (reduced) {
        intervalId = window.setInterval(() => setNow(Date.now()), REDUCED_MOTION_TICK_MS);
        return;
      }
      function tick(): void {
        setNow(Date.now());
        frameId = requestAnimationFrame(tick);
      }
      frameId = requestAnimationFrame(tick);
    }

    frameId = requestAnimationFrame(anchorAndStart);

    return () => {
      cancelled = true;
      if (frameId !== undefined) cancelAnimationFrame(frameId);
      if (intervalId !== undefined) window.clearInterval(intervalId);
    };
  }, [turnDeadline, serverNow, reduced]);

  if (turnDeadline === null) return null;

  const remaining = remainingMs(turnDeadline, serverNow, clientNowAtReceipt, now);
  const fraction = ringFraction(remaining, turnTimerSeconds);
  const seconds = Math.ceil(remaining / 1000);
  const critical = remaining < CRITICAL_MS;
  const offset = CIRCUMFERENCE * (1 - fraction);

  return (
    <div
      role="timer"
      aria-label={turnTimerAriaLabel(seconds)}
      className={cn('relative flex size-9 shrink-0 items-center justify-center', className)}
    >
      <svg viewBox="0 0 36 36" className="size-9 -rotate-90" aria-hidden="true">
        <circle cx="18" cy="18" r={RADIUS} fill="none" strokeWidth={STROKE_WIDTH} className="text-border" stroke="currentColor" />
        <circle
          cx="18"
          cy="18"
          r={RADIUS}
          fill="none"
          strokeWidth={STROKE_WIDTH}
          strokeLinecap="round"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={offset}
          stroke="currentColor"
          className={cn(
            critical ? 'text-lacquer-red' : 'text-accent',
            !reduced && 'transition-[stroke-dashoffset,color] duration-200 ease-linear',
          )}
        />
      </svg>
      <span
        className={cn(
          'font-hud absolute text-[11px] leading-none tabular-nums',
          critical ? 'text-lacquer-red' : 'text-accent',
        )}
      >
        {seconds}
      </span>
    </div>
  );
}
