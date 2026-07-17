import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES, normalizeRules, type RulesConfig } from './rules-config';

describe('DEFAULT_RULES', () => {
  it('matches every default value specified in RULES.md §13', () => {
    const expected: RulesConfig = {
      deadWallReserve: 16,
      minTaiToWin: 0,
      basePoints: 3,
      pointsPerTai: 1,
      selfDrawTai: 1,
      robKongTai: 1,
      robKong: { enabled: true, robConcealedKong: false },
      sacredDiscard: { enabled: true, scope: 'until-next-self-discard' },
      multipleWinners: false,
      dealerRepeatsOnDraw: true,
      dealerBaseTai: 1,
      dealerRepeatBonusTaiPerRepeat: 2,
      points: { startingPoints: 100000, basePoints: 3000, perTai: 1000 },
      turnTimerSeconds: 15,
    };

    expect(DEFAULT_RULES).toEqual(expected);
  });

  it('turnTimerSeconds defaults to 15', () => {
    expect(DEFAULT_RULES.turnTimerSeconds).toBe(15);
  });

  it('points is the 100000/3000/1000 starting-pool default and is frozen', () => {
    expect(DEFAULT_RULES.points).toEqual({ startingPoints: 100000, basePoints: 3000, perTai: 1000 });
    expect(Object.isFrozen(DEFAULT_RULES.points)).toBe(true);
  });
});

describe('normalizeRules', () => {
  it('injects DEFAULT_RULES.points into a stored config lacking it entirely', () => {
    const stored: Partial<RulesConfig> = { deadWallReserve: 20 };
    const normalized = normalizeRules(stored);
    expect(normalized.points).toEqual(DEFAULT_RULES.points);
    expect(normalized.deadWallReserve).toBe(20);
  });

  it('deep-merges a partial points override, filling missing sub-fields from defaults', () => {
    // Simulates a stored/wire config carrying only a partial `points` override
    // (e.g. an older persisted row) — cast needed since `Partial<RulesConfig>`
    // only makes top-level fields optional, not nested ones.
    const stored = { points: { startingPoints: 3000 } } as Partial<RulesConfig>;
    const normalized = normalizeRules(stored);
    expect(normalized.points).toEqual({
      startingPoints: 3000,
      basePoints: DEFAULT_RULES.points.basePoints,
      perTai: DEFAULT_RULES.points.perTai,
    });
  });

  it('preserves explicit stored values and unrelated fields', () => {
    // `robKong: { enabled: false }` is deliberately partial (see cast note
    // above) to also exercise robKong's own nesting-merge alongside points'.
    const stored = {
      minTaiToWin: 2,
      points: { startingPoints: 50000, basePoints: 500, perTai: 200 },
      robKong: { enabled: false },
    } as Partial<RulesConfig>;
    const normalized = normalizeRules(stored);
    expect(normalized.minTaiToWin).toBe(2);
    expect(normalized.points).toEqual({ startingPoints: 50000, basePoints: 500, perTai: 200 });
    expect(normalized.robKong).toEqual({ enabled: false, robConcealedKong: DEFAULT_RULES.robKong.robConcealedKong });
  });

  it('normalizeRules(DEFAULT_RULES) is deep-equal to DEFAULT_RULES', () => {
    expect(normalizeRules(DEFAULT_RULES)).toEqual(DEFAULT_RULES);
  });

  it('back-fills turnTimerSeconds on a legacy stored config missing the field entirely', () => {
    const legacyStored: Partial<RulesConfig> = { deadWallReserve: 20 };
    const normalized = normalizeRules(legacyStored);
    expect(normalized.turnTimerSeconds).toBe(DEFAULT_RULES.turnTimerSeconds);
  });

  it('preserves an explicit turnTimerSeconds override, including a disabling <= 0 value', () => {
    expect(normalizeRules({ turnTimerSeconds: 30 }).turnTimerSeconds).toBe(30);
    expect(normalizeRules({ turnTimerSeconds: 0 }).turnTimerSeconds).toBe(0);
    expect(normalizeRules({ turnTimerSeconds: -1 }).turnTimerSeconds).toBe(-1);
  });

  it('treats a stored config with points entirely absent, points: undefined, and points: {} identically', () => {
    const withoutKey: Partial<RulesConfig> = { deadWallReserve: 20 };
    const withUndefined = { deadWallReserve: 20, points: undefined } as Partial<RulesConfig>;
    const withEmptyObject = { deadWallReserve: 20, points: {} } as Partial<RulesConfig>;

    const a = normalizeRules(withoutKey);
    const b = normalizeRules(withUndefined);
    const c = normalizeRules(withEmptyObject);

    expect(a.points).toEqual(DEFAULT_RULES.points);
    expect(b.points).toEqual(DEFAULT_RULES.points);
    expect(c.points).toEqual(DEFAULT_RULES.points);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });

  it('preserves a fully-specified custom points override exactly, reverting no field to default', () => {
    const stored: Partial<RulesConfig> = {
      points: { startingPoints: 12345, basePoints: 678, perTai: 91 },
    };
    const normalized = normalizeRules(stored);
    expect(normalized.points).toEqual({ startingPoints: 12345, basePoints: 678, perTai: 91 });
    // None of the three fields silently fell back to DEFAULT_RULES.points.
    expect(normalized.points.startingPoints).not.toBe(DEFAULT_RULES.points.startingPoints);
    expect(normalized.points.basePoints).not.toBe(DEFAULT_RULES.points.basePoints);
    expect(normalized.points.perTai).not.toBe(DEFAULT_RULES.points.perTai);
  });

  it('does not mutate its input stored object (top-level or nested points)', () => {
    const stored = { points: { startingPoints: 7 } } as Partial<RulesConfig>;
    const storedSnapshot = JSON.parse(JSON.stringify(stored));
    normalizeRules(stored);
    expect(stored).toEqual(storedSnapshot);
  });

  it('does not mutate DEFAULT_RULES (already frozen) when merging a partial points override', () => {
    const beforeSnapshot = JSON.parse(JSON.stringify(DEFAULT_RULES));
    normalizeRules({ points: { startingPoints: 999 } } as Partial<RulesConfig>);
    normalizeRules({ deadWallReserve: 99 });
    expect(DEFAULT_RULES).toEqual(beforeSnapshot);
    expect(Object.isFrozen(DEFAULT_RULES)).toBe(true);
    expect(Object.isFrozen(DEFAULT_RULES.points)).toBe(true);
  });

  it('the object returned by normalizeRules is a distinct object from DEFAULT_RULES and its nested points (no aliasing)', () => {
    const normalized = normalizeRules({});
    expect(normalized).not.toBe(DEFAULT_RULES);
    expect(normalized.points).not.toBe(DEFAULT_RULES.points);
    expect(normalized.robKong).not.toBe(DEFAULT_RULES.robKong);
    expect(normalized.sacredDiscard).not.toBe(DEFAULT_RULES.sacredDiscard);
  });
});
