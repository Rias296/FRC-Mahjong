import { describe, expect, it } from 'vitest';
import { APEX_THRESHOLD_RP } from './config';
import { progressWithinDivision, rankForRp, rpDeltaForPlacement, settleRp } from './ladder';

describe('rankForRp', () => {
  it('rankForRp(0, false) is Bronze 3', () => {
    expect(rankForRp(0, false)).toEqual({ tier: 'bronze', division: 3 });
  });

  it('boundary correctness: 299 is still Bronze 3, 300 becomes Bronze 2', () => {
    expect(rankForRp(299, false)).toEqual({ tier: 'bronze', division: 3 });
    expect(rankForRp(300, false)).toEqual({ tier: 'bronze', division: 2 });
  });

  it('boundary correctness: 899 is still Bronze 1, 900 becomes Silver 3', () => {
    expect(rankForRp(899, false)).toEqual({ tier: 'bronze', division: 1 });
    expect(rankForRp(900, false)).toEqual({ tier: 'silver', division: 3 });
  });

  it('boundary correctness: 4199 is still Gold 2, 4200 becomes Gold 1', () => {
    expect(rankForRp(4199, false)).toEqual({ tier: 'gold', division: 2 });
    expect(rankForRp(4200, false)).toEqual({ tier: 'gold', division: 1 });
  });

  it('apexAttained: true always returns Apex regardless of a low rp value (sticky)', () => {
    expect(rankForRp(0, true)).toEqual({ tier: 'apex' });
    expect(rankForRp(500, true)).toEqual({ tier: 'apex' });
  });

  it('rankForRp(4500, false) and above resolves to Apex', () => {
    expect(rankForRp(4500, false)).toEqual({ tier: 'apex' });
    expect(rankForRp(9000, false)).toEqual({ tier: 'apex' });
  });
});

describe('rpDeltaForPlacement', () => {
  it('looks up the correct delta for each placement in a band', () => {
    expect(rpDeltaForPlacement('bronze', 1)).toBe(120);
    expect(rpDeltaForPlacement('bronze', 2)).toBe(60);
    expect(rpDeltaForPlacement('bronze', 3)).toBe(15);
    expect(rpDeltaForPlacement('bronze', 4)).toBe(-30);
    expect(rpDeltaForPlacement('apex', 1)).toBe(70);
  });
});

describe('settleRp', () => {
  it('clamps a 4th-place result at the 0 floor — never negative, never below Bronze 3', () => {
    const result = settleRp({ rpBefore: 10, apexAttainedBefore: false, place: 4 });
    expect(result.rpAfter).toBe(0);
    expect(result.rpAfter).toBeGreaterThanOrEqual(0);
    expect(result.tierAfter).toBe('bronze');
    expect(result.divisionAfter).toBe(3);
  });

  it('promotes to Apex exactly when the floored result crosses 4500', () => {
    // rpBefore=4420, Gold 1 (+80 for 1st) => raw 4500, exactly crosses.
    const crossing = settleRp({ rpBefore: 4420, apexAttainedBefore: false, place: 1 });
    expect(crossing.rpAfter).toBe(APEX_THRESHOLD_RP);
    expect(crossing.promotedToApex).toBe(true);
    expect(crossing.tierAfter).toBe('apex');
    expect(crossing.divisionAfter).toBeNull();
  });

  it('promotedToApex is false when the result does not cross 4500', () => {
    // rpBefore=4400, Gold 1 (+80 for 1st) => raw 4480, does not cross.
    const notCrossing = settleRp({ rpBefore: 4400, apexAttainedBefore: false, place: 1 });
    expect(notCrossing.rpAfter).toBe(4480);
    expect(notCrossing.promotedToApex).toBe(false);
    expect(notCrossing.tierAfter).toBe('gold');
    expect(notCrossing.divisionAfter).toBe(1);
  });

  it('promotedToApex is false when the player was already Apex before this match', () => {
    const alreadyApex = settleRp({ rpBefore: 5000, apexAttainedBefore: true, place: 4 });
    expect(alreadyApex.promotedToApex).toBe(false);
    expect(alreadyApex.tierAfter).toBe('apex');
  });

  it('floors an already-Apex players rpAfter at 4500 even on a bad (4th place) result', () => {
    const result = settleRp({ rpBefore: 4500, apexAttainedBefore: true, place: 4 });
    expect(result.rpAfter).toBe(APEX_THRESHOLD_RP);
    expect(result.tierAfter).toBe('apex');
    expect(result.divisionAfter).toBeNull();
  });

  it('selects the delta row from the PRE-match tier: 4499 RP (Gold 1) winning 1st uses the Gold row, not Apex', () => {
    const result = settleRp({ rpBefore: 4499, apexAttainedBefore: false, place: 1 });
    // Gold 1st = +80 (not Apex 1st = +70).
    expect(result.rpDelta).toBe(80);
    expect(result.rpAfter).toBe(4579);
    // Confirms the promotion is correctly reflected in the result despite
    // the pre-match delta row being Gold's.
    expect(result.promotedToApex).toBe(true);
    expect(result.tierAfter).toBe('apex');
  });

  it('never returns a rpDelta or rpAfter that is JS -0', () => {
    // Expert 3rd-place 0-delta at a floor boundary.
    const result = settleRp({ rpBefore: 1800, apexAttainedBefore: false, place: 3 });
    expect(result.rpDelta).toBe(0);
    expect(Object.is(result.rpDelta, -0)).toBe(false);
    expect(Object.is(result.rpAfter, -0)).toBe(false);

    // Also probe the actual 0-floor clamp path.
    const floored = settleRp({ rpBefore: 0, apexAttainedBefore: false, place: 4 });
    expect(Object.is(floored.rpDelta, -0)).toBe(false);
    expect(Object.is(floored.rpAfter, -0)).toBe(false);
  });
});

describe('progressWithinDivision', () => {
  it("at a division's floor: fraction 0", () => {
    const result = progressWithinDivision(0);
    expect(result.current).toBe(0);
    expect(result.fraction).toBe(0);
    expect(result.span).toBe(300);
  });

  it('at a midpoint: fraction ~0.5', () => {
    const result = progressWithinDivision(150);
    expect(result.current).toBe(150);
    expect(result.fraction).toBeCloseTo(0.5);
  });

  it('just below the ceiling: fraction close to but under 1', () => {
    const result = progressWithinDivision(299);
    expect(result.current).toBe(299);
    expect(result.fraction).toBeLessThan(1);
    expect(result.fraction).toBeGreaterThan(0.99);
  });

  it('saturates at a full bar for Apex (rp >= APEX_THRESHOLD_RP)', () => {
    const result = progressWithinDivision(APEX_THRESHOLD_RP);
    expect(result.fraction).toBe(1);
    const result2 = progressWithinDivision(9000);
    expect(result2.fraction).toBe(1);
  });
});
