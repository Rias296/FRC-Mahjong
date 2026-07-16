'use client';

import { useEffect, useRef, useState } from 'react';
import { formatMatchPoints } from '@/lib/theme/frc';
import { cn } from '@/lib/utils';

export interface AnimatedNumberProps {
  /** The final value to land on. */
  readonly value: number;
  /** The change this animation represents; the animation starts at `value - delta`. */
  readonly delta: number;
  readonly durationMs?: number;
  readonly className?: string;
}

const DEFAULT_DURATION_MS = 800;

/**
 * Matches the same `prefers-reduced-motion` check convention used elsewhere
 * in this app (globals.css's `@media (prefers-reduced-motion: reduce)` block
 * disables the CSS-keyframe buzzer/points-pop animations declaratively; this
 * is the JS-driven equivalent for a requestAnimationFrame loop, which a CSS
 * media query alone cannot gate).
 */
function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * A small reusable count-up numeral. Animates from `value - delta` to
 * `value` over `durationMs` using requestAnimationFrame. Respects
 * `prefers-reduced-motion`: renders the final `value` immediately with no
 * animation when set. Numerals are rendered via `formatMatchPoints`.
 */
export function AnimatedNumber({
  value,
  delta,
  durationMs = DEFAULT_DURATION_MS,
  className,
}: AnimatedNumberProps): React.JSX.Element {
  // Read directly during render (a plain browser API check, not stateful) so
  // the reduced-motion case can render `value` immediately below without
  // ever needing a synchronous setState-in-effect call.
  const reduced = prefersReducedMotion();
  const [display, setDisplay] = useState<number>(reduced ? value : value - delta);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    if (reduced) return;

    const startValue = value - delta;
    const start = performance.now();

    function tick(now: number): void {
      const elapsed = now - start;
      const t = Math.min(1, elapsed / durationMs);
      setDisplay(Math.round(startValue + (value - startValue) * t));
      if (t < 1) {
        frameRef.current = requestAnimationFrame(tick);
      }
    }

    frameRef.current = requestAnimationFrame(tick);
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    };
  }, [value, delta, durationMs, reduced]);

  return <span className={cn('font-hud tabular-nums', className)}>{formatMatchPoints(reduced ? value : display)}</span>;
}
