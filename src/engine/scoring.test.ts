import { describe, expect, it } from 'vitest';
import {
  computeDealerTai,
  computeHandTai,
  computePaymentLegs,
  computeStandings,
  findBustedSeats,
  initialSeatTotals,
  meetsMinimumTai,
  sumPaymentLegs,
  TAI_EVALUATORS,
  TAI_SLOT_IDS,
  type PaymentLeg,
  type ScoringContext,
  type SeatTotals,
  type TaiSlotId,
  type WinType,
} from './scoring';
import { DEFAULT_RULES, type RulesConfig } from './rules-config';
import type { Seat } from './seats';

const WIN_TYPES: readonly WinType[] = ['self-draw', 'discard', 'robbed-kong'];

describe('TAI_SLOT_IDS / TAI_EVALUATORS', () => {
  it('contains exactly the 19 §12 slot ids in table order and excludes "dealer"', () => {
    const expected: TaiSlotId[] = [
      'pingHu',
      'selfDraw',
      'concealedHand',
      'allPungs',
      'halfFlush',
      'fullFlush',
      'allHonors',
      'flowers',
      'robKong',
      'kongReplacementWin',
      'lastTileDraw',
      'heavenlyHand',
      'earthlyHand',
      'littleThreeDragons',
      'bigThreeDragons',
      'littleFourWinds',
      'bigFourWinds',
      'singleWait',
      'concealedTriplets',
    ];
    expect(TAI_SLOT_IDS).toEqual(expected);
    expect(TAI_SLOT_IDS.length).toBe(19);
    expect(TAI_SLOT_IDS).not.toContain('dealer');
  });

  it('every slot except selfDraw and robKong evaluates to 0 for all three winTypes', () => {
    for (const id of TAI_SLOT_IDS) {
      if (id === 'selfDraw' || id === 'robKong') continue;
      for (const winType of WIN_TYPES) {
        const context: ScoringContext = { winType };
        expect(TAI_EVALUATORS[id](context, DEFAULT_RULES)).toBe(0);
      }
    }
  });

  it('selfDraw evaluator returns selfDrawTai only when winType is "self-draw"', () => {
    for (const winType of WIN_TYPES) {
      const context: ScoringContext = { winType };
      const expected = winType === 'self-draw' ? DEFAULT_RULES.selfDrawTai : 0;
      expect(TAI_EVALUATORS.selfDraw(context, DEFAULT_RULES)).toBe(expected);
    }
  });

  it('robKong evaluator returns robKongTai only when winType is "robbed-kong"', () => {
    for (const winType of WIN_TYPES) {
      const context: ScoringContext = { winType };
      const expected = winType === 'robbed-kong' ? DEFAULT_RULES.robKongTai : 0;
      expect(TAI_EVALUATORS.robKong(context, DEFAULT_RULES)).toBe(expected);
    }
  });
});

describe('computeHandTai', () => {
  it('returns selfDrawTai for a self-drawn win under default rules (= 1)', () => {
    expect(computeHandTai({ winType: 'self-draw' }, DEFAULT_RULES)).toBe(1);
  });

  it('returns robKongTai for a robbed-kong win under default rules (= 1)', () => {
    expect(computeHandTai({ winType: 'robbed-kong' }, DEFAULT_RULES)).toBe(1);
  });

  it('returns 0 for a win off a discard', () => {
    expect(computeHandTai({ winType: 'discard' }, DEFAULT_RULES)).toBe(0);
  });

  it('sums using custom selfDrawTai and robKongTai config values', () => {
    const rules: RulesConfig = { ...DEFAULT_RULES, selfDrawTai: 4, robKongTai: 7 };
    expect(computeHandTai({ winType: 'self-draw' }, rules)).toBe(4);
    expect(computeHandTai({ winType: 'robbed-kong' }, rules)).toBe(7);
  });
});

describe('computeDealerTai', () => {
  it('returns dealerBaseTai when repeatCount is 0 (= 1 default)', () => {
    expect(computeDealerTai(0, DEFAULT_RULES)).toBe(1);
  });

  it('computes exact escalation for repeatCount 1, 2, and 5 under default rules (3, 5, 11)', () => {
    expect(computeDealerTai(1, DEFAULT_RULES)).toBe(3);
    expect(computeDealerTai(2, DEFAULT_RULES)).toBe(5);
    expect(computeDealerTai(5, DEFAULT_RULES)).toBe(11);
  });

  it('computes escalation with custom dealerBaseTai and dealerRepeatBonusTaiPerRepeat', () => {
    const rules: RulesConfig = { ...DEFAULT_RULES, dealerBaseTai: 2, dealerRepeatBonusTaiPerRepeat: 3 };
    expect(computeDealerTai(0, rules)).toBe(2);
    expect(computeDealerTai(1, rules)).toBe(5);
    expect(computeDealerTai(4, rules)).toBe(14);
  });

  it('throws on negative repeatCount', () => {
    expect(() => computeDealerTai(-1, DEFAULT_RULES)).toThrow();
  });

  it('throws on non-integer repeatCount (fraction and NaN)', () => {
    expect(() => computeDealerTai(1.5, DEFAULT_RULES)).toThrow();
    expect(() => computeDealerTai(NaN, DEFAULT_RULES)).toThrow();
  });
});

describe('meetsMinimumTai', () => {
  it('returns true when handTai equals minTaiToWin', () => {
    const rules: RulesConfig = { ...DEFAULT_RULES, minTaiToWin: 3 };
    expect(meetsMinimumTai(3, rules)).toBe(true);
  });

  it('returns false when handTai is one below minTaiToWin', () => {
    const rules: RulesConfig = { ...DEFAULT_RULES, minTaiToWin: 3 };
    expect(meetsMinimumTai(2, rules)).toBe(false);
  });

  it('returns true when handTai is one above minTaiToWin', () => {
    const rules: RulesConfig = { ...DEFAULT_RULES, minTaiToWin: 3 };
    expect(meetsMinimumTai(4, rules)).toBe(true);
  });

  it('returns true for zero handTai when minTaiToWin is 0', () => {
    expect(meetsMinimumTai(0, DEFAULT_RULES)).toBe(true);
  });
});

describe('computePaymentLegs — discard shape', () => {
  it('discard win with dealer uninvolved produces one leg of points.basePoints + handTai * points.perTai', () => {
    // Dealer is seat 0; winner seat 1, payer seat 2 — neither is the dealer.
    const legs = computePaymentLegs({
      winnerSeat: 1,
      winType: 'discard',
      payerSeats: [2],
      handTai: 4,
      dealerSeat: 0,
      repeatCount: 0,
      rules: DEFAULT_RULES,
    });
    expect(legs).toEqual([
      { payerSeat: 2, payeeSeat: 1, amount: DEFAULT_RULES.points.basePoints + 4 * DEFAULT_RULES.points.perTai },
    ]);
  });

  it('discard win uses pool-scale points.basePoints/points.perTai for an exact amount (3000 + 2*1000 = 5000)', () => {
    expect(DEFAULT_RULES.points.basePoints).toBe(3000);
    expect(DEFAULT_RULES.points.perTai).toBe(1000);
    // Dealer is seat 3; winner seat 0, payer seat 1 — neither is the dealer.
    const legs = computePaymentLegs({
      winnerSeat: 0,
      winType: 'discard',
      payerSeats: [1],
      handTai: 2,
      dealerSeat: 3,
      repeatCount: 0,
      rules: DEFAULT_RULES,
    });
    expect(legs).toEqual([{ payerSeat: 1, payeeSeat: 0, amount: 5000 }]);
  });

  it('discard win where the winner is the dealer adds dealer tai to the single leg', () => {
    const dealerTai = computeDealerTai(0, DEFAULT_RULES);
    const legs = computePaymentLegs({
      winnerSeat: 0,
      winType: 'discard',
      payerSeats: [2],
      handTai: 4,
      dealerSeat: 0,
      repeatCount: 0,
      rules: DEFAULT_RULES,
    });
    const expectedAmount = DEFAULT_RULES.points.basePoints + (4 + dealerTai) * DEFAULT_RULES.points.perTai;
    expect(legs).toEqual([{ payerSeat: 2, payeeSeat: 0, amount: expectedAmount }]);
  });

  it('discard win where the payer is the dealer adds dealer tai to the single leg', () => {
    const dealerTai = computeDealerTai(0, DEFAULT_RULES);
    const legs = computePaymentLegs({
      winnerSeat: 1,
      winType: 'discard',
      payerSeats: [0],
      handTai: 4,
      dealerSeat: 0,
      repeatCount: 0,
      rules: DEFAULT_RULES,
    });
    const expectedAmount = DEFAULT_RULES.points.basePoints + (4 + dealerTai) * DEFAULT_RULES.points.perTai;
    expect(legs).toEqual([{ payerSeat: 0, payeeSeat: 1, amount: expectedAmount }]);
  });

  it('discard win reflects repeatCount escalation in the dealer-involved leg (repeatCount 2 -> +5 with defaults)', () => {
    const dealerTai = computeDealerTai(2, DEFAULT_RULES);
    expect(dealerTai).toBe(5);
    const legs = computePaymentLegs({
      winnerSeat: 0,
      winType: 'discard',
      payerSeats: [2],
      handTai: 1,
      dealerSeat: 0,
      repeatCount: 2,
      rules: DEFAULT_RULES,
    });
    const expectedAmount = DEFAULT_RULES.points.basePoints + (1 + 5) * DEFAULT_RULES.points.perTai;
    expect(legs[0].amount).toBe(expectedAmount);
  });

  it('robbed-kong payment leg (discard-shaped, kong declarer sole payer) uses pool-scale amounts', () => {
    // Per RULES.md §7.2: the kong declarer is treated as the discarder for
    // payment purposes, so a robbed kong is scored via winType: 'discard'
    // with payerSeats: [kongDeclarerSeat].
    const kongDeclarerSeat = 2;
    const robberSeat = 0;
    const legs = computePaymentLegs({
      winnerSeat: robberSeat,
      winType: 'discard',
      payerSeats: [kongDeclarerSeat],
      handTai: 1, // robKongTai contribution, already summed into handTai upstream
      dealerSeat: 3,
      repeatCount: 0,
      rules: DEFAULT_RULES,
    });
    expect(legs).toEqual([
      { payerSeat: kongDeclarerSeat, payeeSeat: robberSeat, amount: DEFAULT_RULES.points.basePoints + 1 * DEFAULT_RULES.points.perTai },
    ]);
  });
});

describe('computePaymentLegs — self-draw shape', () => {
  it('self-drawn win by the dealer adds dealer tai to all three legs, at pool-scale amounts', () => {
    const dealerTai = computeDealerTai(0, DEFAULT_RULES);
    const legs = computePaymentLegs({
      winnerSeat: 0,
      winType: 'self-draw',
      payerSeats: [1, 2, 3],
      handTai: 2,
      dealerSeat: 0,
      repeatCount: 0,
      rules: DEFAULT_RULES,
    });
    const expectedAmount = DEFAULT_RULES.points.basePoints + (2 + dealerTai) * DEFAULT_RULES.points.perTai;
    for (const leg of legs) {
      expect(leg.amount).toBe(expectedAmount);
      expect(leg.payeeSeat).toBe(0);
    }
  });

  it('self-drawn win by a non-dealer adds dealer tai only to the dealer\'s payer leg, at pool-scale amounts', () => {
    const dealerTai = computeDealerTai(0, DEFAULT_RULES);
    const legs = computePaymentLegs({
      winnerSeat: 1,
      winType: 'self-draw',
      payerSeats: [0, 2, 3],
      handTai: 2,
      dealerSeat: 0,
      repeatCount: 0,
      rules: DEFAULT_RULES,
    });
    const dealerLeg = legs.find((l) => l.payerSeat === 0);
    const otherLegs = legs.filter((l) => l.payerSeat !== 0);

    expect(dealerLeg?.amount).toBe(DEFAULT_RULES.points.basePoints + (2 + dealerTai) * DEFAULT_RULES.points.perTai);
    expect(otherLegs).toHaveLength(2);
    for (const leg of otherLegs) {
      expect(leg.amount).toBe(DEFAULT_RULES.points.basePoints + 2 * DEFAULT_RULES.points.perTai);
    }
  });

  it('self-drawn legs preserve payerSeats order and all name the winner as payeeSeat', () => {
    const payerSeats: readonly Seat[] = [3, 1, 2];
    const legs = computePaymentLegs({
      winnerSeat: 0,
      winType: 'self-draw',
      payerSeats,
      handTai: 1,
      dealerSeat: 0,
      repeatCount: 0,
      rules: DEFAULT_RULES,
    });
    expect(legs.map((l) => l.payerSeat)).toEqual([3, 1, 2]);
    expect(legs.every((l) => l.payeeSeat === 0)).toBe(true);
  });
});

describe('computePaymentLegs — validation', () => {
  it('throws when winType is "discard" and payerSeats length is not 1', () => {
    expect(() =>
      computePaymentLegs({
        winnerSeat: 0,
        winType: 'discard',
        payerSeats: [1, 2],
        handTai: 1,
        dealerSeat: 0,
        repeatCount: 0,
        rules: DEFAULT_RULES,
      }),
    ).toThrow();
  });

  it('throws when winType is "self-draw" and payerSeats length is not 3', () => {
    expect(() =>
      computePaymentLegs({
        winnerSeat: 0,
        winType: 'self-draw',
        payerSeats: [1, 2],
        handTai: 1,
        dealerSeat: 0,
        repeatCount: 0,
        rules: DEFAULT_RULES,
      }),
    ).toThrow();
  });

  it('throws when winnerSeat appears in payerSeats', () => {
    expect(() =>
      computePaymentLegs({
        winnerSeat: 1,
        winType: 'discard',
        payerSeats: [1],
        handTai: 1,
        dealerSeat: 0,
        repeatCount: 0,
        rules: DEFAULT_RULES,
      }),
    ).toThrow();
  });

  it('throws when payerSeats contains duplicate seats', () => {
    expect(() =>
      computePaymentLegs({
        winnerSeat: 0,
        winType: 'self-draw',
        payerSeats: [1, 1, 2],
        handTai: 1,
        dealerSeat: 0,
        repeatCount: 0,
        rules: DEFAULT_RULES,
      }),
    ).toThrow();
  });

  it('throws on invalid repeatCount even when the dealer is in no leg', () => {
    expect(() =>
      computePaymentLegs({
        winnerSeat: 1,
        winType: 'discard',
        payerSeats: [2],
        handTai: 1,
        dealerSeat: 3,
        repeatCount: -1,
        rules: DEFAULT_RULES,
      }),
    ).toThrow();
  });

  it('does not mutate the payerSeats input array', () => {
    const payerSeats: readonly Seat[] = [1, 2, 3];
    const original = [...payerSeats];
    computePaymentLegs({
      winnerSeat: 0,
      winType: 'self-draw',
      payerSeats,
      handTai: 1,
      dealerSeat: 0,
      repeatCount: 0,
      rules: DEFAULT_RULES,
    });
    expect(payerSeats).toEqual(original);
  });
});

describe('sumPaymentLegs', () => {
  it('returns all zeros for an empty leg list', () => {
    expect(sumPaymentLegs([])).toEqual([0, 0, 0, 0]);
  });

  it('credits the payee and debits the payer for a single discard leg', () => {
    const legs: PaymentLeg[] = [{ payerSeat: 2, payeeSeat: 1, amount: 10 }];
    expect(sumPaymentLegs(legs)).toEqual([0, 10, -10, 0]);
  });

  it('sums three self-draw legs into one winner gain and three payer losses', () => {
    const legs: PaymentLeg[] = [
      { payerSeat: 1, payeeSeat: 0, amount: 8 },
      { payerSeat: 2, payeeSeat: 0, amount: 8 },
      { payerSeat: 3, payeeSeat: 0, amount: 8 },
    ];
    expect(sumPaymentLegs(legs)).toEqual([24, -8, -8, -8]);
  });

  it("folds multiple winners' legs against a single discarder", () => {
    // A multipleWinners (一炮多響) scenario: seats 1 and 2 both win off seat 0's discard.
    const legs: PaymentLeg[] = [
      { payerSeat: 0, payeeSeat: 1, amount: 6 },
      { payerSeat: 0, payeeSeat: 2, amount: 9 },
    ];
    expect(sumPaymentLegs(legs)).toEqual([-15, 6, 9, 0]);
  });

  it('accumulates on top of a non-zero initial SeatTotals', () => {
    const initial: SeatTotals = [5, -5, 10, -10];
    const legs: PaymentLeg[] = [{ payerSeat: 2, payeeSeat: 3, amount: 4 }];
    expect(sumPaymentLegs(legs, initial)).toEqual([5, -5, 6, -6]);
  });

  it('totals always sum to zero across arbitrary leg sets', () => {
    const legSets: readonly (readonly PaymentLeg[])[] = [
      [],
      [{ payerSeat: 0, payeeSeat: 1, amount: 1 }],
      [
        { payerSeat: 1, payeeSeat: 0, amount: 8 },
        { payerSeat: 2, payeeSeat: 0, amount: 8 },
        { payerSeat: 3, payeeSeat: 0, amount: 8 },
      ],
      [
        { payerSeat: 0, payeeSeat: 1, amount: 6 },
        { payerSeat: 0, payeeSeat: 2, amount: 9 },
        { payerSeat: 3, payeeSeat: 2, amount: 2 },
      ],
      [
        { payerSeat: 3, payeeSeat: 1, amount: 7 },
        { payerSeat: 2, payeeSeat: 0, amount: 3 },
      ],
    ];
    for (const legs of legSets) {
      const totals = sumPaymentLegs(legs);
      expect(totals.reduce((a, b) => a + b, 0)).toBe(0);
    }
  });

  it('computes the correct signed per-seat delta for a robbed-kong win (payment-shaped as a single-payer discard, matching game-state.ts resolveRobKong)', () => {
    // Mirrors exactly how game-state.ts's resolveRobKong builds legs:
    // handTai = computeHandTai({ winType: 'robbed-kong' }, rules) (folds in
    // rules.robKongTai via the robKong evaluator), then computePaymentLegs
    // with winType 'discard' and a single payerSeat (the kong declarer).
    const rules: RulesConfig = DEFAULT_RULES;
    const declarerSeat: Seat = 2;
    const winnerSeat: Seat = 0;
    const handTai = computeHandTai({ winType: 'robbed-kong' }, rules);
    expect(handTai).toBe(rules.robKongTai); // sanity: only the robKong slot is non-zero here

    const legs = computePaymentLegs({
      winnerSeat,
      winType: 'discard',
      payerSeats: [declarerSeat],
      handTai,
      dealerSeat: 1, // neither declarer nor winner is dealer — no dealerTai folded in
      repeatCount: 0,
      rules,
    });

    expect(legs).toEqual([
      { payerSeat: declarerSeat, payeeSeat: winnerSeat, amount: rules.points.basePoints + handTai * rules.points.perTai },
    ]);

    // The delta shown per seat in HandOverPanel is exactly sumPaymentLegs(result.legs) —
    // cross-check it independently here rather than trusting the component's plumbing.
    const deltas = sumPaymentLegs(legs);
    const amount = rules.points.basePoints + handTai * rules.points.perTai;
    expect(deltas).toEqual([amount, 0, -amount, 0]);
    expect(deltas[winnerSeat]).toBe(amount);
    expect(deltas[declarerSeat]).toBe(-amount);
  });

  it('a robbed-kong win where the winner IS the dealer folds dealerTai into the single payer leg (delta cross-check)', () => {
    const rules: RulesConfig = DEFAULT_RULES;
    const declarerSeat: Seat = 1;
    const winnerSeat: Seat = 0; // dealer
    const handTai = computeHandTai({ winType: 'robbed-kong' }, rules);
    const repeatCount = 2;

    const legs = computePaymentLegs({
      winnerSeat,
      winType: 'discard',
      payerSeats: [declarerSeat],
      handTai,
      dealerSeat: 0,
      repeatCount,
      rules,
    });

    const dealerTai = computeDealerTai(repeatCount, rules);
    const expectedAmount = rules.points.basePoints + (handTai + dealerTai) * rules.points.perTai;
    expect(legs).toEqual([{ payerSeat: declarerSeat, payeeSeat: winnerSeat, amount: expectedAmount }]);

    const deltas = sumPaymentLegs(legs);
    expect(deltas).toEqual([expectedAmount, -expectedAmount, 0, 0]);
  });

  it('starting from initialSeatTotals preserves the 4*startingPoints zero-sum invariant after applying legs', () => {
    const initial = initialSeatTotals(DEFAULT_RULES);
    const legs: PaymentLeg[] = [
      { payerSeat: 1, payeeSeat: 0, amount: 8000 },
      { payerSeat: 2, payeeSeat: 0, amount: 8000 },
      { payerSeat: 3, payeeSeat: 0, amount: 8000 },
    ];
    const totals = sumPaymentLegs(legs, initial);
    const expectedSum = 4 * DEFAULT_RULES.points.startingPoints;
    expect(totals.reduce((a, b) => a + b, 0)).toBe(expectedSum);
    expect(totals).toEqual([
      DEFAULT_RULES.points.startingPoints + 24000,
      DEFAULT_RULES.points.startingPoints - 8000,
      DEFAULT_RULES.points.startingPoints - 8000,
      DEFAULT_RULES.points.startingPoints - 8000,
    ]);
  });
});

describe('initialSeatTotals', () => {
  it('returns startingPoints for all four seats', () => {
    expect(initialSeatTotals(DEFAULT_RULES)).toEqual([100000, 100000, 100000, 100000]);
  });

  it('reflects a custom startingPoints override', () => {
    const rules: RulesConfig = { ...DEFAULT_RULES, points: { ...DEFAULT_RULES.points, startingPoints: 25000 } };
    expect(initialSeatTotals(rules)).toEqual([25000, 25000, 25000, 25000]);
  });
});

describe('findBustedSeats', () => {
  it('returns an empty array when all seats are positive', () => {
    const totals: SeatTotals = [100, 200, 300, 400];
    expect(findBustedSeats(totals)).toEqual([]);
  });

  it('includes a seat at exactly zero', () => {
    const totals: SeatTotals = [100, 0, 300, 400];
    expect(findBustedSeats(totals)).toEqual([1]);
  });

  it('returns multiple busted seats, in seat order, including negative totals', () => {
    const totals: SeatTotals = [-50, 100, 0, -1];
    expect(findBustedSeats(totals)).toEqual([0, 2, 3]);
  });
});

describe('computeStandings', () => {
  it('ranks by points descending with distinct places 1-4', () => {
    const totals: SeatTotals = [100000, 130000, 90000, 80000];
    const standings = computeStandings(totals);
    expect(standings).toEqual([
      { seat: 1, points: 130000, place: 1 },
      { seat: 0, points: 100000, place: 2 },
      { seat: 2, points: 90000, place: 3 },
      { seat: 3, points: 80000, place: 4 },
    ]);
  });

  it('breaks ties by lower seat index placing higher (East-most wins ties)', () => {
    const totals: SeatTotals = [50000, 50000, 100000, 50000];
    const standings = computeStandings(totals);
    expect(standings).toEqual([
      { seat: 2, points: 100000, place: 1 },
      { seat: 0, points: 50000, place: 2 },
      { seat: 1, points: 50000, place: 3 },
      { seat: 3, points: 50000, place: 4 },
    ]);
  });

  it('handles negative totals correctly', () => {
    const totals: SeatTotals = [-10000, 5000, -20000, 0];
    const standings = computeStandings(totals);
    expect(standings).toEqual([
      { seat: 1, points: 5000, place: 1 },
      { seat: 3, points: 0, place: 2 },
      { seat: 0, points: -10000, place: 3 },
      { seat: 2, points: -20000, place: 4 },
    ]);
  });
});
