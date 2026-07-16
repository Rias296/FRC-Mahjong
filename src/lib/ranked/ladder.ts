/**
 * Pure ranked-ladder math: RP → tier/division lookup, per-placement RP
 * deltas, and match settlement. Same purity discipline as `src/engine/` — no
 * React/fetch/env access, no side effects, state in → state out.
 *
 * Full normative spec: `docs/RANKED.md`.
 */
import {
  APEX_THRESHOLD_RP,
  DIVISION_RUNGS,
  RP_DELTA_TABLE,
  RP_PER_DIVISION,
  type Band,
  type Division,
  type DivisionRung,
  type TierBand,
} from './config';

/** A rank result for one of the 15 numbered rungs. */
export interface NumberedRank {
  readonly tier: Band;
  readonly division: Division;
}

/** A rank result for the single terminal Apex Grandmaster state. */
export interface ApexRank {
  readonly tier: 'apex';
}

export type RankResult = NumberedRank | ApexRank;

/**
 * Maps an RP value (plus whether Apex has already been attained) to its
 * tier/division. Apex is sticky: once `apexAttained` is true, this always
 * returns Apex regardless of the numeric `rp` value. Otherwise, RP at or
 * above `APEX_THRESHOLD_RP` also resolves to Apex — this is the
 * promotion-crossing case, evaluated before the caller has persisted
 * `apexAttained = true`.
 */
export function rankForRp(rp: number, apexAttained: boolean): RankResult {
  if (apexAttained || rp >= APEX_THRESHOLD_RP) {
    return { tier: 'apex' };
  }

  // DIVISION_RUNGS is ascending by rpThreshold; pick the highest rung whose
  // threshold is <= rp. rp below 0 (should not happen post-settleRp's floor,
  // but handled defensively here) resolves to the lowest rung, Bronze 3.
  let current: DivisionRung = DIVISION_RUNGS[0];
  for (const rung of DIVISION_RUNGS) {
    if (rp >= rung.rpThreshold) {
      current = rung;
    } else {
      break;
    }
  }
  return { tier: current.band, division: current.division };
}

/**
 * Looks up the RP delta for a placement within a tier band. Takes a full
 * `TierBand` (one of the 6 bands, including `'apex'`) rather than a
 * tier/division pair — the delta table only varies by band, never by
 * division within a band.
 */
export function rpDeltaForPlacement(tierBand: TierBand, place: 1 | 2 | 3 | 4): number {
  const deltas = RP_DELTA_TABLE[tierBand];
  switch (place) {
    case 1:
      return deltas.first;
    case 2:
      return deltas.second;
    case 3:
      return deltas.third;
    case 4:
      return deltas.fourth;
  }
}

/** Normalizes a JS `-0` arithmetic artifact to `0`; see `settleRp` below. */
function normalizeZero(n: number): number {
  return Object.is(n, -0) ? 0 : n;
}

export interface SettleRpParams {
  readonly rpBefore: number;
  readonly apexAttainedBefore: boolean;
  readonly place: 1 | 2 | 3 | 4;
}

export interface SettleRpResult {
  readonly rpAfter: number;
  readonly rpDelta: number;
  readonly tierAfter: TierBand;
  readonly divisionAfter: Division | null;
  readonly promotedToApex: boolean;
}

/**
 * Settles one match's RP change for one player.
 *
 * 1. The delta row is chosen by the player's PRE-match tier band
 *    (`rankForRp(rpBefore, apexAttainedBefore)`), per the owner-approved
 *    spec — not by the tier they end up in.
 * 2. Applies the placement delta to `rpBefore`.
 * 3. Floors the result: an already-Apex player never drops below the Apex
 *    floor (`APEX_THRESHOLD_RP`); everyone else never drops below the global
 *    floor of 0 (never demoted below Bronze 3).
 * 4. Detects a fresh promotion to Apex (crossing `APEX_THRESHOLD_RP` for the
 *    first time this call).
 * 5. Re-derives the post-match tier/division from the floored RP and the
 *    (possibly newly-true) Apex status.
 */
export function settleRp(params: SettleRpParams): SettleRpResult {
  const { rpBefore, apexAttainedBefore, place } = params;

  const preRank = rankForRp(rpBefore, apexAttainedBefore);
  const preBand: TierBand = preRank.tier;

  const rawDelta = rpDeltaForPlacement(preBand, place);
  const rawRpAfter = rpBefore + rawDelta;

  const floor = apexAttainedBefore ? APEX_THRESHOLD_RP : 0;
  const rpAfter = Math.max(rawRpAfter, floor);

  const promotedToApex = !apexAttainedBefore && rpAfter >= APEX_THRESHOLD_RP;
  const apexAttainedAfter = apexAttainedBefore || promotedToApex;

  const postRank = rankForRp(rpAfter, apexAttainedAfter);
  const tierAfter: TierBand = postRank.tier;
  const divisionAfter: Division | null = 'division' in postRank ? postRank.division : null;

  return {
    rpAfter: normalizeZero(rpAfter),
    rpDelta: normalizeZero(rpAfter - rpBefore),
    tierAfter,
    divisionAfter,
    promotedToApex,
  };
}

export interface DivisionProgress {
  /** RP into the current division, 0..span. */
  readonly current: number;
  /** Width of the current division (always RP_PER_DIVISION, except Apex). */
  readonly span: number;
  /** 0..1 fraction of the current division filled. */
  readonly fraction: number;
}

/**
 * How far into the current 300-wide division the given RP sits, for a UI
 * progress bar. For Apex Grandmaster (rp >= APEX_THRESHOLD_RP) there is no
 * numbered division to progress through, so this saturates at a full bar
 * (`fraction: 1`) rather than returning a meaningless partial value.
 */
export function progressWithinDivision(rp: number): DivisionProgress {
  if (rp >= APEX_THRESHOLD_RP) {
    return { current: RP_PER_DIVISION, span: RP_PER_DIVISION, fraction: 1 };
  }
  const clamped = Math.max(rp, 0);
  const current = clamped % RP_PER_DIVISION;
  return { current, span: RP_PER_DIVISION, fraction: current / RP_PER_DIVISION };
}
