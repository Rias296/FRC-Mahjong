/**
 * Tester round (ranked-ladder UI landing): adversarial/independent coverage
 * for asTierBand, formatRankPoints, and tierLabel beyond the builder's own
 * frc.test.ts. See the Phase 4 ranked-ladder-UI tester task.
 */
import { describe, expect, it } from 'vitest';
import { asTierBand, formatMatchPoints, formatRankPoints, formatTai, tierLabel } from './frc';
import { DIVISION_RUNGS, LADDER, RP_DELTA_TABLE, type Band, type Division, type TierBand } from '../ranked/config';

const ALL_BANDS: readonly Band[] = ['bronze', 'silver', 'expert', 'platinum', 'gold'];
const ALL_TIER_BANDS: readonly TierBand[] = [...ALL_BANDS, 'apex'];
const ALL_DIVISIONS: readonly Division[] = [1, 2, 3];

describe('asTierBand', () => {
  it('round-trips every valid TierBand string unchanged', () => {
    for (const band of ALL_TIER_BANDS) {
      expect(asTierBand(band)).toBe(band);
    }
  });

  it('falls back to "bronze" for an unrecognized wire string (documented behavior)', () => {
    expect(asTierBand('nonsense')).toBe('bronze');
    expect(asTierBand('')).toBe('bronze');
  });

  it('is case-sensitive: a differently-cased valid band string is NOT recognized and falls back to bronze', () => {
    // Real wire values are always exact-lowercase per TierBand; a
    // version-skewed/malformed server response using different casing must
    // not silently match.
    expect(asTierBand('Bronze')).toBe('bronze');
    expect(asTierBand('APEX')).toBe('bronze');
    expect(asTierBand('Apex')).toBe('bronze');
  });

  it('falls back to bronze for a plausible-but-wrong future tier name (simulated version skew)', () => {
    // Simulates a server that has added a 7th tier band ('diamond') that this
    // client build does not know about yet — the single most realistic
    // version-skew scenario for this function.
    expect(asTierBand('diamond')).toBe('bronze');
  });

  it('falls back to bronze for whitespace-padded otherwise-valid strings (no implicit trim)', () => {
    expect(asTierBand(' apex')).toBe('bronze');
    expect(asTierBand('apex ')).toBe('bronze');
  });

  // --- Judgment call: is silently defaulting to 'bronze' actually safe? -----
  //
  // This test does not assert a "fix" (there is none to assert — the
  // fallback is the shipped, documented behavior) but PINS the concrete,
  // observable consequence so a reviewer can see exactly what "safe
  // degradation" looks like here: an unresolvable wire tier for a genuinely
  // high-ranked player (e.g. 'apex', corrupted/truncated/misspelled by a
  // version-skewed server, or any future tier name this client build
  // doesn't know about) renders as a fully plausible, non-error-looking
  // "Bronze 3" — visually indistinguishable from a real low-rank result.
  // There is no separate "unknown tier" affordance anywhere downstream
  // (rank-badge.tsx / match-standings.tsx both call tierLabel(asTierBand(x))
  // with no branch for "this was actually unresolvable").
  it('JUDGMENT CALL: an unresolvable tier for an actually-high-ranked player degrades to a visually-indistinguishable-from-real "Bronze 3" badge, not a visibly-broken/error state', () => {
    const wireValueFromSkewedServer = 'apex-grandmaster'; // plausible future/mismatched wire value
    const resolvedTier = asTierBand(wireValueFromSkewedServer);
    const badgeText = tierLabel(resolvedTier, 3);

    expect(resolvedTier).toBe('bronze');
    expect(badgeText).toBe('Bronze 3');
    // Nothing in the resolved tier or the label indicates a fallback
    // occurred — a reviewer/player has no signal this is degraded data.
  });
});

describe('formatRankPoints — independent re-derivation', () => {
  it('matches hand-computed ASCII grouped-thousands output for a spread of values not in the builder\'s own test', () => {
    const cases: ReadonlyArray<[number, string]> = [
      [7, '7 DP'],
      [42, '42 DP'],
      [300, '300 DP'],
      [2100, '2,100 DP'],
      [10000, '10,000 DP'],
      [1000000, '1,000,000 DP'],
      [-1, '-1 DP'],
      [-90, '-90 DP'],
      [-2400, '-2,400 DP'],
    ];
    for (const [input, expected] of cases) {
      expect(formatRankPoints(input)).toBe(expected);
    }
  });

  it('never coincides with formatMatchPoints or formatTai for a fresh, independently-chosen sample set', () => {
    const samples = [2, 7, 45, 55, 100, 300, 2100, 3900, -20, -60, -120, -150];
    for (const n of samples) {
      const rank = formatRankPoints(n);
      const points = formatMatchPoints(n);
      const tai = formatTai(n);
      expect(rank).not.toBe(points);
      expect(rank).not.toBe(tai);
      expect(points).not.toBe(tai);
    }
  });

  it('handles a delta of exactly 0 (Expert-band 3rd place, per docs/RANKED.md / RP_DELTA_TABLE)', () => {
    expect(RP_DELTA_TABLE.expert.third).toBe(0);
    expect(formatRankPoints(RP_DELTA_TABLE.expert.third)).toBe('0 DP');
    // Exactly 0 is neither "positive" (no leading +, that's the caller's job
    // per match-standings.tsx) nor negative (no leading "-").
    expect(formatRankPoints(0)).not.toMatch(/^-/);
    expect(formatRankPoints(0)).not.toMatch(/^\+/);
  });

  it('does NOT reintroduce the "-0" artifact bug for a negative-fractional input that truncates to zero magnitude', () => {
    // Same bug class as the historical formatMatchPoints "-0" bug (guarded
    // there via `magnitude !== 0 && points < 0`): formatRankPoints uses the
    // identical guard, so this pins that the fix pattern was correctly
    // reused rather than reintroducing the bug in the new sibling function.
    expect(formatRankPoints(-0.5)).toBe('0 DP');
    expect(formatRankPoints(-0.999)).toBe('0 DP');
    expect(formatRankPoints(-0)).toBe('0 DP');
  });

  it('every real RP_DELTA_TABLE value round-trips through formatRankPoints with correct sign and no coincidental collision with the other two formatters', () => {
    for (const band of ALL_TIER_BANDS) {
      const row = RP_DELTA_TABLE[band];
      for (const delta of [row.first, row.second, row.third, row.fourth]) {
        const rank = formatRankPoints(delta);
        expect(rank).not.toBe(formatMatchPoints(delta));
        expect(rank).not.toBe(formatTai(delta));
        if (delta > 0) expect(rank).not.toMatch(/^-/);
        if (delta < 0) expect(rank).toMatch(/^-/);
        if (delta === 0) expect(rank).toBe('0 DP');
      }
    }
  });
});

describe('tierLabel — exhaustive over every real ladder rung (not sampled)', () => {
  it('produces the exact expected string for all 15 numbered rungs, matching LADDER 1:1', () => {
    // DIVISION_RUNGS + rungLabel-equivalent expectations, cross-checked
    // against the already-locked LADDER export so this doesn't silently
    // drift from config.ts's own source of truth.
    const numberedLadderEntries = LADDER.slice(0, 15);
    expect(DIVISION_RUNGS.length).toBe(15);
    DIVISION_RUNGS.forEach((rung, i) => {
      const label = tierLabel(rung.band, rung.division);
      expect(label).toBe(numberedLadderEntries[i]);
    });
  });

  it('exhaustively covers all 6 bands x [1,2,3] divisions (18 combos) plus apex x null — zero undefined/crash/degenerate output', () => {
    const seen = new Set<string>();
    for (const band of ALL_BANDS) {
      for (const division of ALL_DIVISIONS) {
        const label = tierLabel(band, division);
        expect(label).not.toBe('undefined');
        expect(label).not.toContain('undefined');
        expect(label).not.toContain('NaN');
        expect(label.length).toBeGreaterThan(0);
        seen.add(label);
      }
    }
    const apexLabel = tierLabel('apex', null);
    expect(apexLabel).toBe('Apex Grandmaster');
    seen.add(apexLabel);

    // All 16 real rungs must be pairwise distinct strings.
    expect(seen.size).toBe(16);
  });

  it('apex ignores whatever division is passed (defensive: apex + a non-null division must still render "Apex Grandmaster", never leak the division)', () => {
    for (const division of ALL_DIVISIONS) {
      expect(tierLabel('apex', division)).toBe('Apex Grandmaster');
    }
    expect(tierLabel('apex', null)).toBe('Apex Grandmaster');
  });
});
