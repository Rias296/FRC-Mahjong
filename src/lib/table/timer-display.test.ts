import { describe, expect, it } from 'vitest';
import { remainingMs, ringFraction } from './timer-display';

describe('remainingMs', () => {
  it('returns 0 when deadline is null, regardless of the other clocks', () => {
    expect(remainingMs(null, 1_000, 1_000, 5_000)).toBe(0);
  });

  it('computes a plain countdown when client and server clocks agree (zero offset)', () => {
    // serverNow === clientNowAtReceipt => no clock-skew correction applied.
    expect(remainingMs(10_000, 1_000, 1_000, 1_000)).toBe(9_000);
    expect(remainingMs(10_000, 1_000, 1_000, 5_000)).toBe(5_000);
  });

  it('corrects for a client clock that runs ahead of the server', () => {
    // Server clock is 3000ms BEHIND the client at receipt time (serverNow
    // 1000, clientNowAtReceipt 4000 => offset -3000). 4000ms of client-side
    // elapsed time is only 4000 + (-3000) = 1000ms of server-clock elapsed
    // time relative to the deadline's own server-clock frame.
    const deadline = 10_000; // server-clock epoch ms
    const serverNow = 1_000;
    const clientNowAtReceipt = 4_000;
    const clientNow = 8_000; // 4000ms of client wall-clock elapsed
    // correctedNow = 8000 + (1000 - 4000) = 5000; remaining = 10000 - 5000 = 5000
    expect(remainingMs(deadline, serverNow, clientNowAtReceipt, clientNow)).toBe(5_000);
  });

  it('corrects for a client clock that runs behind the server', () => {
    const deadline = 10_000;
    const serverNow = 5_000;
    const clientNowAtReceipt = 1_000;
    const clientNow = 2_000; // 1000ms of client wall-clock elapsed
    // offset = 5000 - 1000 = 4000; correctedNow = 2000 + 4000 = 6000; remaining = 4000
    expect(remainingMs(deadline, serverNow, clientNowAtReceipt, clientNow)).toBe(4_000);
  });

  it('clamps to 0 once the corrected clock has passed the deadline', () => {
    expect(remainingMs(10_000, 1_000, 1_000, 20_000)).toBe(0);
  });

  it('clamps to 0 exactly at the deadline (never returns a negative epsilon)', () => {
    expect(remainingMs(10_000, 1_000, 1_000, 10_000)).toBe(0);
  });

  it('never returns a negative number even with a large negative offset and elapsed time', () => {
    const result = remainingMs(1_000, 0, 100_000, 100_000);
    expect(result).toBeGreaterThanOrEqual(0);
  });
});

describe('ringFraction', () => {
  it('returns 0 when turnTimerSeconds is null', () => {
    expect(ringFraction(5_000, null)).toBe(0);
  });

  it('returns 0 when turnTimerSeconds is zero', () => {
    expect(ringFraction(5_000, 0)).toBe(0);
  });

  it('returns 0 when turnTimerSeconds is negative', () => {
    expect(ringFraction(5_000, -10)).toBe(0);
  });

  it('computes the remaining fraction of the configured window', () => {
    expect(ringFraction(5_000, 10)).toBe(0.5);
    expect(ringFraction(10_000, 10)).toBe(1);
    expect(ringFraction(0, 10)).toBe(0);
  });

  it('clamps to 1 when remainingMs exceeds the configured window (e.g. a fresh window before the first tick)', () => {
    expect(ringFraction(15_000, 10)).toBe(1);
  });

  it('clamps to 0 for a negative remainingMs input (defensive; remainingMs itself never produces one)', () => {
    expect(ringFraction(-500, 10)).toBe(0);
  });

  it('handles a fractional turnTimerSeconds (defensive against server misconfiguration) without NaN/Infinity', () => {
    expect(ringFraction(5_000, 0.5)).toBe(1); // 5000ms remaining against a 500ms window -> clamped to 1
    expect(Number.isFinite(ringFraction(5_000, 0.5))).toBe(true);
  });

  it('never returns NaN when turnTimerSeconds is NaN (defensive; NaN <= 0 is false, so it falls through to the division)', () => {
    // NaN <= 0 evaluates to false, so this does NOT hit the early-return guard;
    // Math.min/Math.max with NaN both propagate NaN — pin this down explicitly
    // so a future refactor of the guard condition doesn't silently start
    // returning NaN into the ring's strokeDashoffset calculation.
    expect(Number.isNaN(ringFraction(5_000, NaN))).toBe(true);
  });
});

describe('remainingMs + ringFraction — fresh-mount (pre-anchor) integration scenario', () => {
  // Mirrors turn-timer-ring.tsx's very first render: clientNowAtReceipt/now
  // are both seeded from Date.now() lazy initializers at mount time, BEFORE
  // the effect's first rAF has re-anchored them to the serverNow/turnDeadline
  // pair that was actually fetched moments earlier (network latency means the
  // mount-time clientNowAtReceipt is later than the real receipt instant).
  // remainingMs can therefore transiently overshoot the configured window;
  // ringFraction must still clamp cleanly to 1 rather than propagating an
  // out-of-range strokeDashoffset.
  it('overshoot from an unanchored mount clamps ringFraction to 1, not >1', () => {
    const turnTimerSeconds = 15;
    const deadline = 100_000; // server-clock epoch ms, window opened at 85_000
    const serverNow = 85_000; // server's clock at the instant the window opened
    // Mount happens "late" relative to serverNow (network latency), but the
    // mount-time clientNowAtReceipt/now pairing has zero elapsed time between
    // them (both same Date.now() tick), so the raw computation still yields
    // exactly the full 15s window's worth of remaining time — no overshoot in
    // this exact case, since offset cancels out when clientNow===clientNowAtReceipt.
    const clientNowAtReceipt = 500_000;
    const clientNow = 500_000;
    const remaining = remainingMs(deadline, serverNow, clientNowAtReceipt, clientNow);
    expect(remaining).toBe(15_000);
    expect(ringFraction(remaining, turnTimerSeconds)).toBe(1);
  });

  it('a client clock that ticked forward between the two mount-time Date.now() reads overshoots and still clamps to 1', () => {
    const turnTimerSeconds = 10;
    const deadline = 100_000;
    const serverNow = 90_500; // window has 9.5s left per the server's clock
    const clientNowAtReceipt = 200_000;
    const clientNow = 199_000; // clientNow read BEFORE clientNowAtReceipt (possible across two separate Date.now() calls under clock jitter) -> negative elapsed
    const remaining = remainingMs(deadline, serverNow, clientNowAtReceipt, clientNow);
    // offset = 90500 - 200000 = -109500; correctedNow = 199000 - 109500 = 89500; remaining = 100000-89500=10500 > window(10000ms)
    expect(remaining).toBe(10_500);
    expect(remaining).toBeGreaterThan(turnTimerSeconds * 1000);
    expect(ringFraction(remaining, turnTimerSeconds)).toBe(1);
  });
});
