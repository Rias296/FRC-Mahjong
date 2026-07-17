/**
 * Closing-verification pass for `isValidGameAction` (see the fix's rationale
 * comment in protocol.ts itself, and the route-level regression coverage in
 * src/app/api/games/[code]/actions/route-crash.test.ts).
 *
 * This file tests the guard in isolation (pure function, no DB, no route) at
 * two levels:
 *   1. Every one of the 8 GameAction union variants (11 counting each of
 *      `claim`'s 4 sub-types separately) gets ONE well-formed, realistic
 *      example — pulled from real shapes used elsewhere in the codebase
 *      (src/server/*.test.ts, engine tests) — and must be ACCEPTED. This is
 *      the "does the new guard introduce false rejections" check.
 *   2. A light fuzz pass of adjacent-malformed shapes (wrong-typed seat,
 *      out-of-range seat, null/array actions, invalid claim.type, wrong
 *      tileIds shape, etc.) must all be REJECTED.
 */
import { describe, expect, it } from 'vitest';
import { isValidGameAction, isValidRulesOverride } from './protocol';

describe('isValidGameAction: accepts every legitimate GameAction shape', () => {
  it('draw', () => {
    expect(isValidGameAction({ type: 'draw', seat: 0 })).toBe(true);
  });

  it('discard', () => {
    expect(isValidGameAction({ type: 'discard', seat: 1, tileId: 'wan-5-1' })).toBe(true);
  });

  it('declare-hu', () => {
    expect(isValidGameAction({ type: 'declare-hu', seat: 2 })).toBe(true);
  });

  it('claim: hu', () => {
    expect(isValidGameAction({ type: 'claim', seat: 2, claim: { type: 'hu' } })).toBe(true);
  });

  it('claim: pung', () => {
    expect(isValidGameAction({ type: 'claim', seat: 1, claim: { type: 'pung' } })).toBe(true);
  });

  it('claim: kong', () => {
    expect(isValidGameAction({ type: 'claim', seat: 3, claim: { type: 'kong' } })).toBe(true);
  });

  it('claim: chow with a 2-element string tileIds tuple', () => {
    expect(
      isValidGameAction({
        type: 'claim',
        seat: 1,
        claim: { type: 'chow', tileIds: ['wan-4-2', 'wan-6-1'] },
      }),
    ).toBe(true);
  });

  it('pass', () => {
    expect(isValidGameAction({ type: 'pass', seat: 3 })).toBe(true);
  });

  it('declare-added-kong', () => {
    expect(isValidGameAction({ type: 'declare-added-kong', seat: 0, tileId: 'dragon-red-3' })).toBe(true);
  });

  it('declare-concealed-kong', () => {
    expect(
      isValidGameAction({
        type: 'declare-concealed-kong',
        seat: 0,
        kind: { category: 'suit', suit: 'wan', rank: 5 },
      }),
    ).toBe(true);
  });

  it('declare-concealed-kong: kind is only shallow-checked (non-null object), not deep-validated — matches the documented scope', () => {
    // Deliberately a structurally-wrong-but-object-shaped kind; the guard's own
    // doc comment says this is intentionally NOT rejected here (canConcealedKong
    // rejects it downstream with a proper RuleError instead).
    expect(isValidGameAction({ type: 'declare-concealed-kong', seat: 0, kind: { bogus: true } })).toBe(true);
  });

  it('declare-rob', () => {
    expect(isValidGameAction({ type: 'declare-rob', seat: 1 })).toBe(true);
  });

  it('accepts every valid seat 0-3 for a simple action', () => {
    for (const seat of [0, 1, 2, 3]) {
      expect(isValidGameAction({ type: 'pass', seat })).toBe(true);
    }
  });
});

describe('isValidGameAction: rejects a wire-forged timedOut tag', () => {
  it('rejects an otherwise-valid action carrying timedOut: true', () => {
    expect(isValidGameAction({ type: 'draw', seat: 0, timedOut: true })).toBe(false);
    expect(isValidGameAction({ type: 'discard', seat: 1, tileId: 'wan-5-1', timedOut: true })).toBe(false);
    expect(isValidGameAction({ type: 'pass', seat: 3, timedOut: true })).toBe(false);
  });

  it('rejects timedOut regardless of its value (any presence of the key is forbidden)', () => {
    expect(isValidGameAction({ type: 'pass', seat: 3, timedOut: false })).toBe(false);
    expect(isValidGameAction({ type: 'pass', seat: 3, timedOut: 'yes' })).toBe(false);
  });
});

describe('isValidGameAction: light fuzz pass — adjacent-malformed shapes are all rejected', () => {
  it('rejects null', () => {
    expect(isValidGameAction(null)).toBe(false);
  });

  it('rejects undefined', () => {
    expect(isValidGameAction(undefined)).toBe(false);
  });

  it('rejects an array', () => {
    expect(isValidGameAction([{ type: 'draw', seat: 0 }])).toBe(false);
  });

  it('rejects a bare string/number/boolean', () => {
    expect(isValidGameAction('draw')).toBe(false);
    expect(isValidGameAction(42)).toBe(false);
    expect(isValidGameAction(true)).toBe(false);
  });

  it('rejects seat as a string instead of number', () => {
    expect(isValidGameAction({ type: 'draw', seat: '0' })).toBe(false);
  });

  it('rejects seat out of range: 4', () => {
    expect(isValidGameAction({ type: 'draw', seat: 4 })).toBe(false);
  });

  it('rejects seat out of range: -1', () => {
    expect(isValidGameAction({ type: 'draw', seat: -1 })).toBe(false);
  });

  it('rejects seat as a float (non-integer, though numerically in [0,3])', () => {
    // Not explicitly required to reject, but documents current guard behavior:
    // VALID_SEATS.includes(1.5) is false, so this is correctly rejected.
    expect(isValidGameAction({ type: 'draw', seat: 1.5 })).toBe(false);
  });

  it('rejects an unknown action.type', () => {
    expect(isValidGameAction({ type: 'not-a-real-action', seat: 0 })).toBe(false);
  });

  it('rejects claim.type as an invalid string', () => {
    expect(isValidGameAction({ type: 'claim', seat: 0, claim: { type: 'bogus' } })).toBe(false);
  });

  it('rejects a claim action missing the claim sub-object entirely', () => {
    expect(isValidGameAction({ type: 'claim', seat: 0 })).toBe(false);
  });

  it('rejects a claim action whose claim is not an object', () => {
    expect(isValidGameAction({ type: 'claim', seat: 0, claim: 'hu' })).toBe(false);
  });

  it('rejects a chow claim whose tileIds is a single string instead of a 2-array', () => {
    expect(
      isValidGameAction({ type: 'claim', seat: 0, claim: { type: 'chow', tileIds: 'wan-4-2' } }),
    ).toBe(false);
  });

  it('rejects a chow claim whose tileIds array has the wrong length', () => {
    expect(
      isValidGameAction({ type: 'claim', seat: 0, claim: { type: 'chow', tileIds: ['wan-4-2'] } }),
    ).toBe(false);
    expect(
      isValidGameAction({
        type: 'claim',
        seat: 0,
        claim: { type: 'chow', tileIds: ['wan-4-2', 'wan-5-1', 'wan-6-1'] },
      }),
    ).toBe(false);
  });

  it('rejects a chow claim whose tileIds contains non-string elements', () => {
    expect(
      isValidGameAction({ type: 'claim', seat: 0, claim: { type: 'chow', tileIds: [1, 2] } }),
    ).toBe(false);
  });

  it('rejects discard missing tileId', () => {
    expect(isValidGameAction({ type: 'discard', seat: 0 })).toBe(false);
  });

  it('rejects discard with a non-string tileId', () => {
    expect(isValidGameAction({ type: 'discard', seat: 0, tileId: 123 })).toBe(false);
  });

  it('rejects declare-added-kong missing tileId', () => {
    expect(isValidGameAction({ type: 'declare-added-kong', seat: 0 })).toBe(false);
  });

  it('rejects declare-concealed-kong with kind as a string instead of an object', () => {
    expect(isValidGameAction({ type: 'declare-concealed-kong', seat: 0, kind: 'wan-5' })).toBe(false);
  });

  it('rejects declare-concealed-kong with kind as null', () => {
    expect(isValidGameAction({ type: 'declare-concealed-kong', seat: 0, kind: null })).toBe(false);
  });

  it('rejects declare-concealed-kong missing kind entirely', () => {
    expect(isValidGameAction({ type: 'declare-concealed-kong', seat: 0 })).toBe(false);
  });

  it('rejects an action with no type field at all', () => {
    expect(isValidGameAction({ seat: 0 })).toBe(false);
  });

  it('rejects an action with no seat field at all', () => {
    expect(isValidGameAction({ type: 'draw' })).toBe(false);
  });

  it('rejects an empty object', () => {
    expect(isValidGameAction({})).toBe(false);
  });
});

describe('isValidRulesOverride', () => {
  it('accepts undefined (no override supplied)', () => {
    expect(isValidRulesOverride(undefined)).toBe(true);
  });

  it('accepts an empty object', () => {
    expect(isValidRulesOverride({})).toBe(true);
  });

  it('accepts a genuinely valid partial override', () => {
    expect(
      isValidRulesOverride({
        deadWallReserve: 20,
        minTaiToWin: 1,
        multipleWinners: true,
        robKong: { enabled: false },
        sacredDiscard: { scope: 'entire-hand' },
      }),
    ).toBe(true);
  });

  it('accepts a full, all-fields override', () => {
    expect(
      isValidRulesOverride({
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
      }),
    ).toBe(true);
  });

  it('rejects null, an array, and non-object primitives', () => {
    expect(isValidRulesOverride(null)).toBe(false);
    expect(isValidRulesOverride([])).toBe(false);
    expect(isValidRulesOverride('rules')).toBe(false);
    expect(isValidRulesOverride(42)).toBe(false);
  });

  it('rejects an unknown extra key', () => {
    expect(isValidRulesOverride({ notARealField: 1 })).toBe(false);
  });

  it.each([
    'deadWallReserve',
    'minTaiToWin',
    'basePoints',
    'pointsPerTai',
    'selfDrawTai',
    'robKongTai',
    'dealerBaseTai',
    'dealerRepeatBonusTaiPerRepeat',
    'turnTimerSeconds',
  ] as const)('rejects %s as a non-numeric value', (key) => {
    expect(isValidRulesOverride({ [key]: 'banana' })).toBe(false);
    expect(isValidRulesOverride({ [key]: Number.NaN })).toBe(false);
    expect(isValidRulesOverride({ [key]: Number.POSITIVE_INFINITY })).toBe(false);
  });

  it('accepts a finite turnTimerSeconds override, including a disabling <= 0 value', () => {
    expect(isValidRulesOverride({ turnTimerSeconds: 30 })).toBe(true);
    expect(isValidRulesOverride({ turnTimerSeconds: 0 })).toBe(true);
    expect(isValidRulesOverride({ turnTimerSeconds: -1 })).toBe(true);
  });

  it.each(['multipleWinners', 'dealerRepeatsOnDraw'] as const)(
    'rejects %s as a non-boolean value',
    (key) => {
      expect(isValidRulesOverride({ [key]: 'yes' })).toBe(false);
      expect(isValidRulesOverride({ [key]: 1 })).toBe(false);
    },
  );

  it('rejects robKong as a non-object', () => {
    expect(isValidRulesOverride({ robKong: 'yes' })).toBe(false);
    expect(isValidRulesOverride({ robKong: null })).toBe(false);
  });

  it('rejects robKong.enabled / robKong.robConcealedKong as non-boolean', () => {
    expect(isValidRulesOverride({ robKong: { enabled: 'yes' } })).toBe(false);
    expect(isValidRulesOverride({ robKong: { robConcealedKong: 'no' } })).toBe(false);
  });

  it('rejects an unknown key nested inside robKong', () => {
    expect(isValidRulesOverride({ robKong: { bogus: true } })).toBe(false);
  });

  it('rejects sacredDiscard as a non-object', () => {
    expect(isValidRulesOverride({ sacredDiscard: 'yes' })).toBe(false);
    expect(isValidRulesOverride({ sacredDiscard: null })).toBe(false);
  });

  it('rejects sacredDiscard.enabled as non-boolean', () => {
    expect(isValidRulesOverride({ sacredDiscard: { enabled: 'yes' } })).toBe(false);
  });

  it('rejects sacredDiscard.scope as an invalid string', () => {
    expect(isValidRulesOverride({ sacredDiscard: { scope: 'not-a-real-scope' } })).toBe(false);
  });

  it('accepts each valid sacredDiscard.scope value', () => {
    expect(isValidRulesOverride({ sacredDiscard: { scope: 'until-next-self-discard' } })).toBe(true);
    expect(isValidRulesOverride({ sacredDiscard: { scope: 'entire-hand' } })).toBe(true);
  });

  it('rejects an unknown key nested inside sacredDiscard', () => {
    expect(isValidRulesOverride({ sacredDiscard: { bogus: true } })).toBe(false);
  });

  it('accepts a full points sub-object', () => {
    expect(
      isValidRulesOverride({ points: { startingPoints: 100000, basePoints: 3000, perTai: 1000 } }),
    ).toBe(true);
  });

  it('accepts a partial points sub-object', () => {
    expect(isValidRulesOverride({ points: { startingPoints: 50000 } })).toBe(true);
    expect(isValidRulesOverride({ points: {} })).toBe(true);
  });

  it('rejects an unknown key nested inside points', () => {
    expect(isValidRulesOverride({ points: { bogus: true } })).toBe(false);
  });

  it('rejects non-finite/non-numeric points values', () => {
    expect(isValidRulesOverride({ points: { startingPoints: 'banana' } })).toBe(false);
    expect(isValidRulesOverride({ points: { basePoints: Number.NaN } })).toBe(false);
    expect(isValidRulesOverride({ points: { perTai: Number.POSITIVE_INFINITY } })).toBe(false);
  });

  it('rejects an array as points', () => {
    expect(isValidRulesOverride({ points: [] })).toBe(false);
  });

  it('rejects points as a non-object', () => {
    expect(isValidRulesOverride({ points: 'yes' })).toBe(false);
    expect(isValidRulesOverride({ points: null })).toBe(false);
  });

  it('still accepts legacy flat basePoints/pointsPerTai keys', () => {
    expect(isValidRulesOverride({ basePoints: 3, pointsPerTai: 1 })).toBe(true);
  });

  it('accepts a points override combined with legacy flat basePoints/pointsPerTai keys in the same request', () => {
    // The plan says both forms may coexist on the wire; the validator must
    // not reject the combination just because both the legacy flat fields
    // and the new nested `points` sub-object are present simultaneously.
    expect(
      isValidRulesOverride({
        basePoints: 3,
        pointsPerTai: 1,
        points: { startingPoints: 50000, basePoints: 500, perTai: 200 },
      }),
    ).toBe(true);
  });

  it('rejects a nested array as a points numeric field value', () => {
    expect(isValidRulesOverride({ points: { startingPoints: [1, 2, 3] } })).toBe(false);
    expect(isValidRulesOverride({ points: { basePoints: [] } })).toBe(false);
  });

  it('rejects null as a points numeric field value', () => {
    expect(isValidRulesOverride({ points: { startingPoints: null } })).toBe(false);
    expect(isValidRulesOverride({ points: { perTai: null } })).toBe(false);
  });

  it('rejects a points object with an unknown key mixed in alongside otherwise-valid keys', () => {
    expect(
      isValidRulesOverride({ points: { startingPoints: 50000, bogus: 'x' } }),
    ).toBe(false);
  });

  it('rejects NaN and -Infinity for every points numeric field individually', () => {
    for (const key of ['startingPoints', 'basePoints', 'perTai'] as const) {
      expect(isValidRulesOverride({ points: { [key]: Number.NaN } })).toBe(false);
      expect(isValidRulesOverride({ points: { [key]: Number.NEGATIVE_INFINITY } })).toBe(false);
      expect(isValidRulesOverride({ points: { [key]: Number.POSITIVE_INFINITY } })).toBe(false);
    }
  });

  it('accepts negative and zero finite numbers for points fields (range is not validated here — only finiteness/type)', () => {
    // Documents current guard behavior: isValidRulesOverride is a structural/
    // finiteness check only, not a business-rule (>0) check.
    expect(isValidRulesOverride({ points: { startingPoints: 0 } })).toBe(true);
    expect(isValidRulesOverride({ points: { basePoints: -100 } })).toBe(true);
  });

  it('rejects a points override containing a nested object where a number is expected', () => {
    expect(isValidRulesOverride({ points: { startingPoints: { nested: true } } })).toBe(false);
  });
});
