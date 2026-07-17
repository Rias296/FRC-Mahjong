/**
 * Pure, presentation-only helpers for the turn-timer countdown ring. No
 * React, no fetch, no side effects — mirrors tile-display.ts's conventions.
 * See src/components/table/turn-timer-ring.tsx for the consumer. The server
 * is the sole enforcement authority for turn timeouts (see
 * src/server/turn-timer.ts); everything in this file is DISPLAY ONLY.
 */

/**
 * Clock-offset-corrected countdown, in milliseconds remaining until
 * `deadline` (server epoch-ms, from `ClientGameView.turnDeadline`). The
 * server and client clocks are never assumed to agree; `serverNow`
 * (captured from the same response as `deadline`) and `clientNowAtReceipt`
 * (the client's own clock reading at that same instant) together define the
 * offset `serverNow - clientNowAtReceipt`, which is applied to `clientNow`
 * to translate it into server-clock terms before subtracting from
 * `deadline`. Always clamped to `[0, Infinity)` — never negative, and never
 * fabricates a "past the deadline" countdown as a negative number. Returns
 * `0` immediately when `deadline` is `null` (no window open).
 */
export function remainingMs(
  deadline: number | null,
  serverNow: number,
  clientNowAtReceipt: number,
  clientNow: number,
): number {
  if (deadline === null) return 0;
  const offset = serverNow - clientNowAtReceipt;
  const correctedNow = clientNow + offset;
  return Math.max(0, deadline - correctedNow);
}

/**
 * The fraction (0..1) of the configured turn-timer window still remaining,
 * for driving the countdown ring's sweep. `0` when `turnTimerSeconds` is
 * `null` or non-positive (timer disabled or genuinely unknown — there is no
 * meaningful window length to measure a fraction against).
 */
export function ringFraction(remainingMs: number, turnTimerSeconds: number | null): number {
  if (turnTimerSeconds === null || turnTimerSeconds <= 0) return 0;
  const fraction = remainingMs / (turnTimerSeconds * 1000);
  return Math.min(1, Math.max(0, fraction));
}
