/**
 * Targeted adversarial tests for src/engine/scoring.ts, beyond the builder's
 * scoring.test.ts (30 tests), per the tester's mandatory scoring checklist
 * (CLAUDE.md) and docs/RULES.md §9 (dealer repeat, one of the three
 * highest-risk areas), §11 (scoring/payments) and §12 (tai table).
 *
 * Every expected value below was derived by hand from the §9/§11 formulas
 * and cross-checked against the actual implementation output before being
 * locked in — none are guessed.
 *
 * This file is verification-only: it must never import anything that would
 * let it silently pass by re-implementing the logic under test.
 */
import { describe, expect, it } from 'vitest';
import {
  computeDealerTai,
  computeHandTai,
  computePaymentLegs,
  meetsMinimumTai,
  TAI_EVALUATORS,
  TAI_SLOT_IDS,
  type PaymentLeg,
  type ScoringContext,
  type WinType,
} from './scoring';
import { DEFAULT_RULES, type RulesConfig } from './rules-config';
import { SEATS, type Seat } from './seats';

const WIN_TYPES: readonly WinType[] = ['self-draw', 'discard', 'robbed-kong'];

// ---------------------------------------------------------------------------
// 4. TAI_EVALUATORS iteration integrity
// ---------------------------------------------------------------------------
describe('TAI_EVALUATORS / TAI_SLOT_IDS set integrity', () => {
  it('Object.keys(TAI_EVALUATORS) is exactly the TAI_SLOT_IDS set (no extra, no missing)', () => {
    const evaluatorKeys = Object.keys(TAI_EVALUATORS).sort();
    const slotIds = [...TAI_SLOT_IDS].sort();
    expect(evaluatorKeys).toEqual(slotIds);
  });

  it('every TAI_SLOT_IDS entry has a callable evaluator (no undefined lookups)', () => {
    for (const id of TAI_SLOT_IDS) {
      expect(typeof TAI_EVALUATORS[id]).toBe('function');
    }
  });

  it('computeHandTai never throws for any winType (would surface a slot/evaluator mismatch)', () => {
    for (const winType of WIN_TYPES) {
      expect(() => computeHandTai({ winType }, DEFAULT_RULES)).not.toThrow();
    }
  });

  it('has no duplicate ids within TAI_SLOT_IDS', () => {
    expect(new Set(TAI_SLOT_IDS).size).toBe(TAI_SLOT_IDS.length);
  });
});

// ---------------------------------------------------------------------------
// 2. computeDealerTai extreme/boundary repeatCount
// ---------------------------------------------------------------------------
describe('computeDealerTai — boundary repeatCount', () => {
  it('large repeatCount (20) computes exact linear escalation under default rules', () => {
    // 1 + 2*20 = 41
    expect(computeDealerTai(20, DEFAULT_RULES)).toBe(41);
  });

  it('very large repeatCount (1000) does not overflow or misbehave', () => {
    expect(computeDealerTai(1000, DEFAULT_RULES)).toBe(1 + 2 * 1000);
    expect(Number.isFinite(computeDealerTai(1000, DEFAULT_RULES))).toBe(true);
  });

  it('repeatCount 0 with escalation disabled (dealerRepeatBonusTaiPerRepeat = 0) returns exactly dealerBaseTai for any repeatCount', () => {
    const rules: RulesConfig = { ...DEFAULT_RULES, dealerRepeatBonusTaiPerRepeat: 0, dealerBaseTai: 4 };
    for (const repeatCount of [0, 1, 5, 20, 100]) {
      expect(computeDealerTai(repeatCount, rules)).toBe(4);
    }
  });

  it('repeatCount 0 always returns dealerBaseTai regardless of dealerRepeatBonusTaiPerRepeat', () => {
    const rules: RulesConfig = { ...DEFAULT_RULES, dealerRepeatBonusTaiPerRepeat: 99, dealerBaseTai: 7 };
    expect(computeDealerTai(0, rules)).toBe(7);
  });

  it('throws on -0 edge case is not applicable; 0 itself is accepted (not mistaken for falsy-invalid)', () => {
    expect(() => computeDealerTai(0, DEFAULT_RULES)).not.toThrow();
    expect(computeDealerTai(0, DEFAULT_RULES)).toBe(DEFAULT_RULES.dealerBaseTai);
  });

  it('throws on Infinity repeatCount', () => {
    expect(() => computeDealerTai(Infinity, DEFAULT_RULES)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 3. computeHandTai + computePaymentLegs integration (robbed-kong is
//    payment-shaped as 'discard')
// ---------------------------------------------------------------------------
describe('robbed-kong handTai + discard-shaped payment integration', () => {
  it('a robbed-kong ScoringContext yields selfDraw contributing 0 (mutual exclusivity with self-draw)', () => {
    const context: ScoringContext = { winType: 'robbed-kong' };
    expect(TAI_EVALUATORS.selfDraw(context, DEFAULT_RULES)).toBe(0);
    expect(TAI_EVALUATORS.robKong(context, DEFAULT_RULES)).toBe(DEFAULT_RULES.robKongTai);
  });

  it('end-to-end: robbed-kong handTai computed, then payment legs computed with winType "discard" and payerSeats=[kongDeclarerSeat], produces sane numbers', () => {
    // Robber is seat 2 (dealer). Kong declarer (payer) is seat 1. repeatCount 1 -> dealerTai = 1 + 2*1 = 3.
    const handTai = computeHandTai({ winType: 'robbed-kong' }, DEFAULT_RULES);
    expect(handTai).toBe(DEFAULT_RULES.robKongTai); // = 1

    const legs = computePaymentLegs({
      winnerSeat: 2,
      winType: 'discard', // rob pays exactly like a discard, per RULES.md §7.2
      payerSeats: [1],
      handTai,
      dealerSeat: 2, // robber is also the dealer
      repeatCount: 1,
      rules: DEFAULT_RULES,
    });

    const dealerTai = computeDealerTai(1, DEFAULT_RULES); // 3
    const expectedAmount = DEFAULT_RULES.basePoints + (handTai + dealerTai) * DEFAULT_RULES.pointsPerTai;
    expect(legs).toEqual([{ payerSeat: 1, payeeSeat: 2, amount: expectedAmount }]);
    // Sanity: amount must be a finite positive number.
    expect(Number.isFinite(legs[0].amount)).toBe(true);
    expect(legs[0].amount).toBeGreaterThan(0);
  });

  it('robbed-kong win where neither robber nor kong declarer is the dealer omits dealer tai entirely', () => {
    const handTai = computeHandTai({ winType: 'robbed-kong' }, DEFAULT_RULES);
    const legs = computePaymentLegs({
      winnerSeat: 1,
      winType: 'discard',
      payerSeats: [2],
      handTai,
      dealerSeat: 0,
      repeatCount: 3,
      rules: DEFAULT_RULES,
    });
    const expectedAmount = DEFAULT_RULES.basePoints + handTai * DEFAULT_RULES.pointsPerTai;
    expect(legs).toEqual([{ payerSeat: 2, payeeSeat: 1, amount: expectedAmount }]);
  });
});

// ---------------------------------------------------------------------------
// 1. Dealer-involvement matrix — exhaustive across all four seats as dealer
// ---------------------------------------------------------------------------
describe('computePaymentLegs — exhaustive dealer-involvement matrix (discard shape)', () => {
  for (const dealerSeat of SEATS) {
    const others = SEATS.filter((s) => s !== dealerSeat);

    it(`dealerSeat=${dealerSeat}: dealer is the winner -> dealer tai applied`, () => {
      const payerSeat = others[0];
      const dealerTai = computeDealerTai(0, DEFAULT_RULES);
      const legs = computePaymentLegs({
        winnerSeat: dealerSeat,
        winType: 'discard',
        payerSeats: [payerSeat],
        handTai: 2,
        dealerSeat,
        repeatCount: 0,
        rules: DEFAULT_RULES,
      });
      expect(legs[0].amount).toBe(DEFAULT_RULES.basePoints + (2 + dealerTai) * DEFAULT_RULES.pointsPerTai);
    });

    it(`dealerSeat=${dealerSeat}: dealer is the payer -> dealer tai applied`, () => {
      const winnerSeat = others[0];
      const dealerTai = computeDealerTai(0, DEFAULT_RULES);
      const legs = computePaymentLegs({
        winnerSeat,
        winType: 'discard',
        payerSeats: [dealerSeat],
        handTai: 2,
        dealerSeat,
        repeatCount: 0,
        rules: DEFAULT_RULES,
      });
      expect(legs[0].amount).toBe(DEFAULT_RULES.basePoints + (2 + dealerTai) * DEFAULT_RULES.pointsPerTai);
    });

    it(`dealerSeat=${dealerSeat}: dealer is neither winner nor payer -> no dealer tai`, () => {
      const winnerSeat = others[0];
      const payerSeat = others[1];
      const legs = computePaymentLegs({
        winnerSeat,
        winType: 'discard',
        payerSeats: [payerSeat],
        handTai: 2,
        dealerSeat,
        repeatCount: 5, // large repeatCount to prove it's genuinely excluded, not just zeroed
        rules: DEFAULT_RULES,
      });
      expect(legs[0].amount).toBe(DEFAULT_RULES.basePoints + 2 * DEFAULT_RULES.pointsPerTai);
    });
  }
});

describe('computePaymentLegs — exhaustive dealer-involvement matrix (self-draw shape)', () => {
  for (const dealerSeat of SEATS) {
    const others = SEATS.filter((s) => s !== dealerSeat);

    it(`dealerSeat=${dealerSeat}: dealer is the winner -> dealer tai applied to all 3 legs`, () => {
      const dealerTai = computeDealerTai(1, DEFAULT_RULES);
      const legs = computePaymentLegs({
        winnerSeat: dealerSeat,
        winType: 'self-draw',
        payerSeats: others,
        handTai: 2,
        dealerSeat,
        repeatCount: 1,
        rules: DEFAULT_RULES,
      });
      expect(legs).toHaveLength(3);
      for (const leg of legs) {
        expect(leg.amount).toBe(DEFAULT_RULES.basePoints + (2 + dealerTai) * DEFAULT_RULES.pointsPerTai);
        expect(leg.payeeSeat).toBe(dealerSeat);
      }
    });

    it(`dealerSeat=${dealerSeat}: dealer is one of the three payers -> dealer tai on exactly that leg`, () => {
      const winnerSeat = others[0];
      const payerSeats = SEATS.filter((s) => s !== winnerSeat); // includes dealerSeat
      expect(payerSeats).toContain(dealerSeat);
      const dealerTai = computeDealerTai(0, DEFAULT_RULES);
      const legs = computePaymentLegs({
        winnerSeat,
        winType: 'self-draw',
        payerSeats,
        handTai: 2,
        dealerSeat,
        repeatCount: 0,
        rules: DEFAULT_RULES,
      });
      const dealerLeg = legs.find((l) => l.payerSeat === dealerSeat);
      const otherLegs = legs.filter((l) => l.payerSeat !== dealerSeat);
      expect(dealerLeg?.amount).toBe(DEFAULT_RULES.basePoints + (2 + dealerTai) * DEFAULT_RULES.pointsPerTai);
      expect(otherLegs).toHaveLength(2);
      for (const leg of otherLegs) {
        expect(leg.amount).toBe(DEFAULT_RULES.basePoints + 2 * DEFAULT_RULES.pointsPerTai);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// 6. Self-draw "no uninvolved case" structural invariant
// ---------------------------------------------------------------------------
describe('self-draw structurally always involves the dealer (property confirmation)', () => {
  it('for every possible dealer seat and every possible winner seat, the dealer is either the winner or in the 3-payer complement set', () => {
    for (const dealerSeat of SEATS) {
      for (const winnerSeat of SEATS) {
        const payerSeats = SEATS.filter((s) => s !== winnerSeat);
        const dealerIsWinner = winnerSeat === dealerSeat;
        const dealerIsPayer = payerSeats.includes(dealerSeat);
        // Exactly one of these must be true — dealer can never be "neither" in self-draw.
        expect(dealerIsWinner || dealerIsPayer).toBe(true);
        expect(dealerIsWinner && dealerIsPayer).toBe(false);
      }
    }
  });

  it('computePaymentLegs never produces a self-draw payment set with zero dealer-involved legs, for any dealer/winner combination', () => {
    const dealerTai = computeDealerTai(0, DEFAULT_RULES);
    for (const dealerSeat of SEATS) {
      for (const winnerSeat of SEATS) {
        const payerSeats = SEATS.filter((s) => s !== winnerSeat);
        const legs = computePaymentLegs({
          winnerSeat,
          winType: 'self-draw',
          payerSeats,
          handTai: 1,
          dealerSeat,
          repeatCount: 0,
          rules: DEFAULT_RULES,
        });
        const involvedLegs = legs.filter(
          (l) => l.payerSeat === dealerSeat || l.payeeSeat === dealerSeat,
        );
        expect(involvedLegs.length).toBeGreaterThan(0);
        // All involved legs must actually carry the dealer tai premium.
        for (const leg of involvedLegs) {
          expect(leg.amount).toBe(DEFAULT_RULES.basePoints + (1 + dealerTai) * DEFAULT_RULES.pointsPerTai);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 5. computePaymentLegs amount arithmetic under non-default configs
// ---------------------------------------------------------------------------
describe('computePaymentLegs — non-default config arithmetic', () => {
  it('basePoints=0, pointsPerTai=0 collapses every leg amount to 0 regardless of handTai/dealer involvement', () => {
    const rules: RulesConfig = { ...DEFAULT_RULES, basePoints: 0, pointsPerTai: 0 };
    const legs = computePaymentLegs({
      winnerSeat: 0,
      winType: 'self-draw',
      payerSeats: [1, 2, 3],
      handTai: 10,
      dealerSeat: 0,
      repeatCount: 5,
      rules,
    });
    for (const leg of legs) {
      expect(leg.amount).toBe(0);
    }
  });

  it('basePoints=0 with nonzero pointsPerTai still scales purely by tai', () => {
    const rules: RulesConfig = { ...DEFAULT_RULES, basePoints: 0, pointsPerTai: 2 };
    const legs = computePaymentLegs({
      winnerSeat: 1,
      winType: 'discard',
      payerSeats: [0], // dealer is payer
      handTai: 3,
      dealerSeat: 0,
      repeatCount: 0,
      rules,
    });
    const dealerTai = computeDealerTai(0, rules);
    expect(legs[0].amount).toBe(0 + (3 + dealerTai) * 2);
  });

  it('handTai=0 is a valid input to computePaymentLegs even under a nonzero minTaiToWin (minTaiToWin is not validated here — that is meetsMinimumTai\'s job)', () => {
    const rules: RulesConfig = { ...DEFAULT_RULES, minTaiToWin: 5 };
    expect(meetsMinimumTai(0, rules)).toBe(false); // would be rejected upstream...
    // ...but computePaymentLegs itself performs no such check:
    expect(() =>
      computePaymentLegs({
        winnerSeat: 1,
        winType: 'discard',
        payerSeats: [2],
        handTai: 0,
        dealerSeat: 0,
        repeatCount: 0,
        rules,
      }),
    ).not.toThrow();
    const legs = computePaymentLegs({
      winnerSeat: 1,
      winType: 'discard',
      payerSeats: [2],
      handTai: 0,
      dealerSeat: 0,
      repeatCount: 0,
      rules,
    });
    expect(legs).toEqual([{ payerSeat: 2, payeeSeat: 1, amount: rules.basePoints }]);
  });

  it('negative handTai (not structurally prevented by the type) still computes arithmetically rather than clamping — documents current behavior', () => {
    // handTai should never be negative in practice (sum of non-negative slot values),
    // but the function signature accepts any number; verify it does not silently clamp,
    // so a caller bug upstream (e.g. accidental negation) would be visible rather than masked.
    const legs = computePaymentLegs({
      winnerSeat: 1,
      winType: 'discard',
      payerSeats: [2],
      handTai: -3,
      dealerSeat: 0,
      repeatCount: 0,
      rules: DEFAULT_RULES,
    });
    expect(legs[0].amount).toBe(DEFAULT_RULES.basePoints + -3 * DEFAULT_RULES.pointsPerTai);
  });
});

// ---------------------------------------------------------------------------
// 7. Immutability — distinct PaymentLeg object identity
// ---------------------------------------------------------------------------
describe('computePaymentLegs — returned leg object independence', () => {
  it('every returned PaymentLeg is a distinct object reference (no aliasing)', () => {
    const legs = computePaymentLegs({
      winnerSeat: 0,
      winType: 'self-draw',
      payerSeats: [1, 2, 3],
      handTai: 2,
      dealerSeat: 0,
      repeatCount: 0,
      rules: DEFAULT_RULES,
    });
    expect(legs).toHaveLength(3);
    expect(legs[0]).not.toBe(legs[1]);
    expect(legs[0]).not.toBe(legs[2]);
    expect(legs[1]).not.toBe(legs[2]);
  });

  it('mutating one returned leg at the JS runtime level does not affect sibling legs', () => {
    const legs = computePaymentLegs({
      winnerSeat: 0,
      winType: 'self-draw',
      payerSeats: [1, 2, 3],
      handTai: 2,
      dealerSeat: 0,
      repeatCount: 0,
      rules: DEFAULT_RULES,
    }) as PaymentLeg[];
    const originalSecondAmount = legs[1].amount;
    const originalThirdAmount = legs[2].amount;
    // TS `readonly` is compile-time only; cast through unknown to mutate at runtime.
    (legs[0] as unknown as { amount: number }).amount = 999999;
    expect(legs[1].amount).toBe(originalSecondAmount);
    expect(legs[2].amount).toBe(originalThirdAmount);
    expect(legs[1].amount).not.toBe(999999);
  });

  it('calling computePaymentLegs twice with identical params returns two independent arrays/objects', () => {
    const params = {
      winnerSeat: 0 as Seat,
      winType: 'discard' as const,
      payerSeats: [1 as Seat],
      handTai: 2,
      dealerSeat: 0 as Seat,
      repeatCount: 0,
      rules: DEFAULT_RULES,
    };
    const legsA = computePaymentLegs(params);
    const legsB = computePaymentLegs(params);
    expect(legsA).not.toBe(legsB);
    expect(legsA[0]).not.toBe(legsB[0]);
    expect(legsA).toEqual(legsB); // same values, different identity
  });
});
