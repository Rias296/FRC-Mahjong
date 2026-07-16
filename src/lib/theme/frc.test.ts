import { describe, expect, it } from 'vitest';
import {
  actionLabel,
  divisionLabel,
  formatMatchPoints,
  formatRankPoints,
  formatTai,
  seatLabel,
  seatWindLabel,
  statusLabel,
  tierLabel,
  tileKindLabel,
  type ActionKey,
  type GameStatusKey,
} from './frc';
import { DIVISION_RUNGS, type TierBand } from '../ranked/config';
import type { Seat } from '../../engine/seats';
import type { TileKind } from '../../engine/tiles';

describe('actionLabel', () => {
  it('returns a distinct non-empty label for every ActionKey', () => {
    const keys: readonly ActionKey[] = ['draw', 'discard', 'hu', 'pung', 'kong', 'chow', 'pass', 'rob'];
    const labels = keys.map(actionLabel);
    for (const label of labels) {
      expect(label.length).toBeGreaterThan(0);
    }
    expect(new Set(labels).size).toBe(keys.length);
  });
});

describe('seatLabel', () => {
  it('maps all four seats to Station 1-4 with correct winds', () => {
    expect(seatLabel(0)).toBe('Station 1 · East');
    expect(seatLabel(1)).toBe('Station 2 · South');
    expect(seatLabel(2)).toBe('Station 3 · West');
    expect(seatLabel(3)).toBe('Station 4 · North');
  });

  it('seatWindLabel maps seats to plain wind names', () => {
    const seats: readonly Seat[] = [0, 1, 2, 3];
    expect(seats.map(seatWindLabel)).toEqual(['East', 'South', 'West', 'North']);
  });
});

describe('tileKindLabel', () => {
  it('names suit tiles as "<rank> <suit>"', () => {
    const tong5: TileKind = { category: 'suit', suit: 'tong', rank: 5 };
    expect(tileKindLabel(tong5)).toBe('5 Dots');
    const wan1: TileKind = { category: 'suit', suit: 'wan', rank: 1 };
    expect(tileKindLabel(wan1)).toBe('1 Characters');
    const tiao9: TileKind = { category: 'suit', suit: 'tiao', rank: 9 };
    expect(tileKindLabel(tiao9)).toBe('9 Bamboo');
  });

  it('names winds, dragons, flowers, and seasons (disambiguating flower vs season)', () => {
    expect(tileKindLabel({ category: 'wind', wind: 'east' })).toBe('East Wind');
    expect(tileKindLabel({ category: 'dragon', dragon: 'red' })).toBe('Red Dragon');
    // Flower series number 4 ("Bamboo Flower") must be distinguishable from the
    // suit name "Bamboo" (tiao) used above.
    expect(tileKindLabel({ category: 'flower', series: 'flower', number: 4 })).toBe('Bamboo Flower');
    expect(tileKindLabel({ category: 'flower', series: 'season', number: 1 })).toBe('Spring');
  });
});

describe('statusLabel', () => {
  it('covers all three game statuses', () => {
    const statuses: readonly GameStatusKey[] = ['waiting-for-players', 'in-progress', 'finished'];
    expect(statuses.map(statusLabel)).toEqual(['Match Staging', 'Match In Progress', 'Match Complete']);
  });
});

describe('formatTai', () => {
  it('renders "<n> RP" and never says "tai"', () => {
    expect(formatTai(3)).toBe('3 RP');
    expect(formatTai(0)).toBe('0 RP');
    expect(formatTai(3).toLowerCase()).not.toContain('tai');
  });
});

describe('formatMatchPoints', () => {
  it('groups thousands with ASCII commas, no locale-dependent separators', () => {
    expect(formatMatchPoints(100000)).toBe('100,000');
    expect(formatMatchPoints(0)).toBe('0');
    expect(formatMatchPoints(999)).toBe('999');
    expect(formatMatchPoints(1000)).toBe('1,000');
    expect(formatMatchPoints(1234567)).toBe('1,234,567');
  });

  it('renders negative totals with a leading ASCII minus sign', () => {
    expect(formatMatchPoints(-5000)).toBe('-5,000');
    expect(formatMatchPoints(-999)).toBe('-999');
  });

  it('produces output visibly distinct from formatTai for the same numeral (guards against the RP/points mislabel bug)', () => {
    const points = formatMatchPoints(5000);
    const tai = formatTai(5000);
    expect(points).not.toBe(tai);
    expect(points.toLowerCase()).not.toContain('rp');
  });

  // Tester round 4 (match-points HUD): independently re-derive both
  // formatters for a spread of sample values (not just the builder's own
  // regression value of 5000) to confirm formatMatchPoints and formatTai
  // never coincidentally produce the same string for the same input.
  it('never coincides with formatTai across a spread of sample values', () => {
    const samples = [0, 1, 3, 999, 1000, 3000, 5000, 8000, 100000, -5000, -100000];
    for (const n of samples) {
      expect(formatMatchPoints(n)).not.toBe(formatTai(n));
    }
  });

  it('handles very large totals (beyond a single match-points pool) with correct thousands grouping', () => {
    expect(formatMatchPoints(10000000)).toBe('10,000,000');
    expect(formatMatchPoints(1234567890)).toBe('1,234,567,890');
    expect(formatMatchPoints(-1234567890)).toBe('-1,234,567,890');
  });

  it('truncates (not rounds) a stray non-integer amount toward zero, silently dropping the fractional part', () => {
    // PaymentLeg.amount / SeatTotals entries should always be integers in
    // practice (basePoints/perTai/startingPoints are all whole numbers in
    // DEFAULT_RULES), but RulesConfig's `points` fields are typed `number`,
    // not an integer brand — nothing at the type level stops a future rules
    // bug from producing a fractional amount. This pins the CURRENT (silent
    // truncation) behavior so a future change to rounding semantics is a
    // deliberate, visible diff rather than an accidental one.
    expect(formatMatchPoints(5000.7)).toBe('5,000');
    expect(formatMatchPoints(-1000.5)).toBe('-1,000');
  });

  it('BUG: renders a bare "-0" (not "0") for a negative fractional value that truncates to zero', () => {
    // formatMatchPoints computes `sign = points < 0 ? '-' : ''` BEFORE
    // truncating — so any value in (-1, 0) sets sign to '-' and then
    // truncates its magnitude to 0, producing the string "-0". Real
    // PaymentLeg amounts are always integers today so this path is not
    // reachable in production yet, but the formatter itself does not guard
    // against it, and the function is exported/reusable. A numeral
    // formatter should never render a bare negative zero.
    // See src/lib/theme/frc.ts formatMatchPoints (sign computed off the
    // pre-truncation value).
    expect(formatMatchPoints(-0.5)).toBe('0');
    expect(formatMatchPoints(-0.999)).toBe('0');
  });

  it('does not render "-0" for exact negative zero (sanity: -0 < 0 is false in JS)', () => {
    expect(formatMatchPoints(-0)).toBe('0');
  });
});

describe('formatRankPoints', () => {
  it('groups thousands with ASCII commas and a trailing "DP" unit', () => {
    expect(formatRankPoints(0)).toBe('0 DP');
    expect(formatRankPoints(120)).toBe('120 DP');
    expect(formatRankPoints(4500)).toBe('4,500 DP');
    expect(formatRankPoints(-180)).toBe('-180 DP');
  });

  it('never coincides with formatMatchPoints or formatTai across a spread of sample values (3-way distinctness)', () => {
    const samples = [0, 1, 3, 15, 60, 120, 999, 1000, 3000, 4500, 5000, -30, -180, -5000];
    for (const n of samples) {
      const rank = formatRankPoints(n);
      const points = formatMatchPoints(n);
      const tai = formatTai(n);
      expect(rank).not.toBe(points);
      expect(rank).not.toBe(tai);
      expect(points).not.toBe(tai);
      // Sanity: the three formatters really do use different unit tokens.
      expect(rank.toLowerCase()).toContain('dp');
      expect(rank.toLowerCase()).not.toContain('rp');
      expect(points.toLowerCase()).not.toContain('dp');
      expect(points.toLowerCase()).not.toContain('rp');
    }
  });
});

describe('tierLabel / divisionLabel', () => {
  const ALL_TIER_BANDS: readonly TierBand[] = ['bronze', 'silver', 'expert', 'platinum', 'gold', 'apex'];

  it('renders every numbered rung as "<Band> <division>" with no crash/undefined', () => {
    for (const rung of DIVISION_RUNGS) {
      const label = tierLabel(rung.band, rung.division);
      expect(label).toBeTruthy();
      expect(label).not.toContain('undefined');
      expect(label.charAt(0)).toBe(label.charAt(0).toUpperCase());
    }
  });

  it('renders Apex Grandmaster with no numbered-division suffix, regardless of the division argument', () => {
    expect(tierLabel('apex', null)).toBe('Apex Grandmaster');
    // Apex never actually carries a division, but the function must not crash
    // or leak a stray suffix if ever called with one.
    expect(tierLabel('apex', 1)).toBe('Apex Grandmaster');
  });

  it('divisionLabel covers every division and the null (Apex) case with no crash/undefined', () => {
    expect(divisionLabel(1)).toBe('Division 1');
    expect(divisionLabel(2)).toBe('Division 2');
    expect(divisionLabel(3)).toBe('Division 3');
    expect(divisionLabel(null)).toBe('');
  });

  it('is total over every TierBand value (no undefined/crash for any valid tier)', () => {
    for (const band of ALL_TIER_BANDS) {
      const division = band === 'apex' ? null : 1;
      expect(() => tierLabel(band, division)).not.toThrow();
      expect(tierLabel(band, division)).toBeTruthy();
    }
  });
});
