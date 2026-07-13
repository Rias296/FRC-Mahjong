/**
 * Scoring: the §12 tai-slot table, hand-tai summation, dealer-tai arithmetic
 * (§9), minimum-tai check (§11), and payment-leg computation (§11).
 *
 * Pure data types + pure functions only. Imports only from ./seats, ./rules-config.
 *
 * RULES.md §12 is an intentionally deferred sub-spec: only `selfDraw` and
 * `robKong` (the two config-driven slots) have real evaluators. The other 17
 * slots are structural placeholders — `() => 0` — until a follow-up spec
 * fills in their real detection logic. Do not implement them here.
 */

import type { Seat } from './seats';
import type { RulesConfig } from './rules-config';

export type WinType = 'self-draw' | 'discard' | 'robbed-kong';

export interface ScoringContext {
  readonly winType: WinType;
}

/**
 * The 19 canonical tai slot ids from RULES.md §12's table, in table order,
 * excluding the `dealer` row: dealer tai is a separate additive term computed
 * by `computeDealerTai` (§9/§11), never part of `handTai`, and so has no
 * member in this union or in `TAI_SLOT_IDS`.
 */
export type TaiSlotId =
  | 'pingHu'
  | 'selfDraw'
  | 'concealedHand'
  | 'allPungs'
  | 'halfFlush'
  | 'fullFlush'
  | 'allHonors'
  | 'flowers'
  | 'robKong'
  | 'kongReplacementWin'
  | 'lastTileDraw'
  | 'heavenlyHand'
  | 'earthlyHand'
  | 'littleThreeDragons'
  | 'bigThreeDragons'
  | 'littleFourWinds'
  | 'bigFourWinds'
  | 'singleWait'
  | 'concealedTriplets';

export const TAI_SLOT_IDS: readonly TaiSlotId[] = [
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

export type TaiEvaluator = (context: ScoringContext, rules: RulesConfig) => number;

export const TAI_EVALUATORS: Readonly<Record<TaiSlotId, TaiEvaluator>> = {
  pingHu: () => 0, // 平胡 — deferred to §12 sub-spec
  selfDraw: (context, rules) => (context.winType === 'self-draw' ? rules.selfDrawTai : 0),
  concealedHand: () => 0, // 門清 — deferred to §12 sub-spec
  allPungs: () => 0, // 對對胡 (碰碰胡) — deferred to §12 sub-spec
  halfFlush: () => 0, // 混一色 — deferred to §12 sub-spec
  fullFlush: () => 0, // 清一色 — deferred to §12 sub-spec
  allHonors: () => 0, // 字一色 — deferred to §12 sub-spec
  flowers: () => 0, // 花牌 / 正花 — deferred to §12 sub-spec
  robKong: (context, rules) => (context.winType === 'robbed-kong' ? rules.robKongTai : 0),
  kongReplacementWin: () => 0, // 槓上開花 — deferred to §12 sub-spec
  lastTileDraw: () => 0, // 海底撈月 — deferred to §12 sub-spec
  heavenlyHand: () => 0, // 天胡 — deferred to §12 sub-spec
  earthlyHand: () => 0, // 地胡 — deferred to §12 sub-spec
  littleThreeDragons: () => 0, // 小三元 — deferred to §12 sub-spec
  bigThreeDragons: () => 0, // 大三元 — deferred to §12 sub-spec
  littleFourWinds: () => 0, // 小四喜 — deferred to §12 sub-spec
  bigFourWinds: () => 0, // 大四喜 — deferred to §12 sub-spec
  singleWait: () => 0, // 獨聽 — deferred to §12 sub-spec
  concealedTriplets: () => 0, // 三暗刻 / 四暗刻 / 五暗刻 — deferred to §12 sub-spec
};

/**
 * The additive sum of every §12 tai slot for a winning hand (RULES.md §11:
 * "handTai ... never multiply"). Excludes dealer tai, which is a separate
 * additive term applied per payment leg by `computePaymentLegs`.
 */
export function computeHandTai(context: ScoringContext, rules: RulesConfig): number {
  return TAI_SLOT_IDS.reduce((sum, id) => sum + TAI_EVALUATORS[id](context, rules), 0);
}

/**
 * Dealer bonus tai (連N拉N), RULES.md §9:
 * `dealerBaseTai + dealerRepeatBonusTaiPerRepeat * repeatCount`.
 * Throws if `repeatCount` is not a non-negative integer.
 */
export function computeDealerTai(repeatCount: number, rules: RulesConfig): number {
  if (!(Number.isInteger(repeatCount) && repeatCount >= 0)) {
    throw new Error(`computeDealerTai: repeatCount must be a non-negative integer, got ${repeatCount}`);
  }
  return rules.dealerBaseTai + rules.dealerRepeatBonusTaiPerRepeat * repeatCount;
}

/** True iff `handTai` meets `rules.minTaiToWin` (RULES.md §11). */
export function meetsMinimumTai(handTai: number, rules: RulesConfig): boolean {
  return handTai >= rules.minTaiToWin;
}

export interface PaymentLeg {
  readonly payerSeat: Seat;
  readonly payeeSeat: Seat;
  readonly amount: number;
}

/**
 * Computes the payment leg(s) for a win (RULES.md §11).
 *
 * `winType` here is deliberately the payment-shape type ('self-draw' |
 * 'discard'), narrower than `WinType` ('self-draw' | 'discard' |
 * 'robbed-kong') used by `ScoringContext` for handTai's own winType-sensitive
 * evaluators (selfDraw, robKong). A robbed-kong win is payment-shaped exactly
 * like a discard win per RULES.md §7.2 ("the kong declarer is treated as the
 * discarder ... they alone pays") — the future GameState passes
 * `winType: 'discard'` with `payerSeats: [kongDeclarerSeat]` when scoring a
 * rob.
 */
export function computePaymentLegs(params: {
  winnerSeat: Seat;
  winType: 'self-draw' | 'discard';
  payerSeats: readonly Seat[];
  handTai: number;
  dealerSeat: Seat;
  repeatCount: number;
  rules: RulesConfig;
}): PaymentLeg[] {
  const { winnerSeat, winType, payerSeats, handTai, dealerSeat, repeatCount, rules } = params;

  if (winType === 'discard' && payerSeats.length !== 1) {
    throw new Error(
      `computePaymentLegs: winType 'discard' requires exactly 1 payerSeat, got ${payerSeats.length}`,
    );
  }
  if (winType === 'self-draw' && payerSeats.length !== 3) {
    throw new Error(
      `computePaymentLegs: winType 'self-draw' requires exactly 3 payerSeats, got ${payerSeats.length}`,
    );
  }
  if (payerSeats.includes(winnerSeat)) {
    throw new Error('computePaymentLegs: winnerSeat must not appear in payerSeats');
  }
  const seenSeats = new Set<Seat>();
  for (const seat of payerSeats) {
    if (seenSeats.has(seat)) {
      throw new Error(`computePaymentLegs: payerSeats contains duplicate seat ${seat}`);
    }
    seenSeats.add(seat);
  }

  // Fail-fast on a bad repeatCount even if the dealer ends up in no leg.
  const dealerTai = computeDealerTai(repeatCount, rules);

  const legs: PaymentLeg[] = [];
  for (const payerSeat of payerSeats) {
    const dealerInvolved = payerSeat === dealerSeat || winnerSeat === dealerSeat;
    const legTai = handTai + (dealerInvolved ? dealerTai : 0);
    const amount = rules.basePoints + legTai * rules.pointsPerTai;
    legs.push({ payerSeat, payeeSeat: winnerSeat, amount });
  }

  return legs;
}
