import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Source-inspection regression guard for turn-timer-ring.tsx's critical-color
 * threshold. There is no React DOM testing harness in this repo (see
 * table-presentation-guards.test.ts's doc comment — no @testing-library/react
 * / jsdom, and vitest.config.ts's `include` only picks up `*.test.ts`, not
 * `.tsx`), so the gold->lacquer-red boundary at CRITICAL_MS can't be rendered
 * and asserted on directly. This guard instead pins down the exact constant
 * value and comparison operator so a future edit can't silently:
 *  - change the 5000ms threshold without anyone noticing, or
 *  - flip `<` to `<=` (which would move the boundary: at exactly 5000ms
 *    remaining, the ring would switch from gold-until-4999ms to
 *    gold-until-4000ms's neighbor, i.e. turn red one tick earlier than
 *    documented), or
 *  - stop applying the same `critical` boolean to both the ring stroke and
 *    the numeral text color (a partial edit that colors one but not the
 *    other would be a visible inconsistency).
 */

const SOURCE = readFileSync(resolve(__dirname, 'turn-timer-ring.tsx'), 'utf-8');

describe('turn-timer-ring.tsx — CRITICAL_MS threshold', () => {
  it('is defined as exactly 5000ms', () => {
    const match = /const CRITICAL_MS = ([\d_]+);/.exec(SOURCE);
    expect(match, 'CRITICAL_MS constant not found — source shape changed').not.toBeNull();
    expect(Number(match![1].replace(/_/g, ''))).toBe(5_000);
  });

  it('uses a strict less-than comparison against CRITICAL_MS (5000ms remaining itself is still gold, not red)', () => {
    const match = /const critical = remaining (<=?) CRITICAL_MS;/.exec(SOURCE);
    expect(match, 'critical boolean computation not found in the expected shape — source shape changed').not.toBeNull();
    expect(match![1]).toBe('<');
  });

  it('applies the same `critical` boolean to both the ring stroke color and the numeral text color', () => {
    const occurrences = SOURCE.match(/critical \? 'text-lacquer-red' : 'text-accent'/g) ?? [];
    expect(occurrences.length).toBe(2);
  });
});

describe('turn-timer-ring.tsx — accessibility + i18n discipline', () => {
  it('exposes role="timer" with an aria-label routed through turnTimerAriaLabel (no hardcoded label string)', () => {
    expect(SOURCE).toContain('role="timer"');
    expect(SOURCE).toContain('aria-label={turnTimerAriaLabel(seconds)}');
  });

  it('imports turnTimerAriaLabel from the shared i18n module rather than defining its own string', () => {
    expect(SOURCE).toContain("import { turnTimerAriaLabel } from '@/lib/i18n/table';");
  });

  it('the numeral/decorative SVG do not carry their own duplicate accessible name (aria-hidden on the SVG)', () => {
    expect(SOURCE).toContain('aria-hidden="true"');
  });
});

describe('turn-timer-ring.tsx — null-render contract', () => {
  it('renders null when turnDeadline is null, before any hook-derived values are used in JSX', () => {
    expect(SOURCE).toContain('if (turnDeadline === null) return null;');
  });
});
