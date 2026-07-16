/**
 * Independent tester verification pass (Round 1, ranked-ladder): does NOT
 * reuse or trust the builder's own `ladder.test.ts` / `config.test.ts`
 * assertions. Every expected value here was hand-derived from
 * `docs/RANKED.md` and re-checked against the raw `config.ts` source by
 * eye, not copied from the builder's test files.
 *
 * Covers:
 *   1. Exhaustive boundary testing of all 15 division thresholds, both
 *      sides, plus a full integer sweep 0..4599 for gap/overlap detection.
 *   2. Independent re-verification of the locked LADDER order (exact
 *      indices, not just relative greater/less-than checks).
 *   3. Pre-match tier delta selection across every band-to-band promotion
 *      boundary (not just the builder's single Gold->Apex example), plus a
 *      band-to-band demotion boundary.
 *   4. Floor-vs-reported-delta correctness: rpDelta must be the ACTUAL
 *      (post-floor) delta, never the raw table value, when clamping occurs.
 *   5. Apex floor interactions, including a non-clamped apex case.
 *   6. promotedToApex exactness, including a data-integrity-anomaly probe
 *      (apexAttainedBefore=true with rpBefore far below 4500).
 *   7. -0 normalization across multiple arithmetic paths.
 */
import { describe, expect, it } from 'vitest';
import { APEX_THRESHOLD_RP, LADDER } from './config';
import { rankForRp, settleRp } from './ladder';

// -----------------------------------------------------------------------
// 1. Exhaustive boundary + full-range sweep for rankForRp
// -----------------------------------------------------------------------

// Hand-derived independently from docs/RANKED.md section 2 — NOT imported
// from config.ts, so this table cannot silently agree with a broken source.
const EXPECTED_RUNGS: ReadonlyArray<{ rp: number; band: string; division: 1 | 2 | 3 }> = [
  { rp: 0, band: 'bronze', division: 3 },
  { rp: 300, band: 'bronze', division: 2 },
  { rp: 600, band: 'bronze', division: 1 },
  { rp: 900, band: 'silver', division: 3 },
  { rp: 1200, band: 'silver', division: 2 },
  { rp: 1500, band: 'silver', division: 1 },
  { rp: 1800, band: 'expert', division: 3 },
  { rp: 2100, band: 'expert', division: 2 },
  { rp: 2400, band: 'expert', division: 1 },
  { rp: 2700, band: 'platinum', division: 3 },
  { rp: 3000, band: 'platinum', division: 2 },
  { rp: 3300, band: 'platinum', division: 1 },
  { rp: 3600, band: 'gold', division: 3 },
  { rp: 3900, band: 'gold', division: 2 },
  { rp: 4200, band: 'gold', division: 1 },
];

describe('rankForRp — exhaustive boundary coverage (all 15 division thresholds)', () => {
  it.each(EXPECTED_RUNGS.map((rung, i) => ({ i, rung })))(
    'boundary #%#: rp=threshold-1 is the PREVIOUS rung, rp=threshold is THIS rung ($rung.band $rung.division @ $rung.rp)',
    ({ i, rung }) => {
      expect(rankForRp(rung.rp, false)).toEqual({ tier: rung.band, division: rung.division });
      if (i > 0) {
        const prev = EXPECTED_RUNGS[i - 1];
        expect(rankForRp(rung.rp - 1, false)).toEqual({ tier: prev.band, division: prev.division });
      }
    },
  );

  it('the very bottom (rp=0) has no lower neighbor; defensively floors at Bronze 3 even for negative rp', () => {
    expect(rankForRp(0, false)).toEqual({ tier: 'bronze', division: 3 });
    expect(rankForRp(-1, false)).toEqual({ tier: 'bronze', division: 3 });
    expect(rankForRp(-9999, false)).toEqual({ tier: 'bronze', division: 3 });
  });

  it('the very top numbered rung (Gold 1 @ 4200): 4499 is still Gold 1, 4500 becomes Apex', () => {
    expect(rankForRp(4499, false)).toEqual({ tier: 'gold', division: 1 });
    expect(rankForRp(4500, false)).toEqual({ tier: 'apex' });
  });

  it('full integer sweep rp=0..4599: every value maps to exactly the rung predicted by floor(rp/300), no gaps or overlaps', () => {
    for (let rp = 0; rp < 4600; rp++) {
      const result = rankForRp(rp, false);
      if (rp >= APEX_THRESHOLD_RP) {
        expect(result).toEqual({ tier: 'apex' });
      } else {
        const idx = Math.floor(rp / 300);
        const expected = EXPECTED_RUNGS[idx];
        expect(result, `rp=${rp} expected ${expected.band} ${expected.division}`).toEqual({
          tier: expected.band,
          division: expected.division,
        });
      }
    }
  });
});

// -----------------------------------------------------------------------
// 2. LADDER order — exact index re-verification (raw array, not test names)
// -----------------------------------------------------------------------

describe('LADDER order — independent exact-index re-verification', () => {
  it('has the full 16-entry order exactly as specified in docs/RANKED.md section 1', () => {
    expect(LADDER).toEqual([
      'Bronze 3', 'Bronze 2', 'Bronze 1',
      'Silver 3', 'Silver 2', 'Silver 1',
      'Expert 3', 'Expert 2', 'Expert 1',
      'Platinum 3', 'Platinum 2', 'Platinum 1',
      'Gold 3', 'Gold 2', 'Gold 1',
      'Apex Grandmaster',
    ]);
  });

  it('every band occupies its own contiguous 3-slot block at the exact expected index', () => {
    // Bronze: 0-2, Silver: 3-5, Expert: 6-8, Platinum: 9-11, Gold: 12-14, Apex: 15
    expect(LADDER.indexOf('Bronze 3')).toBe(0);
    expect(LADDER.indexOf('Bronze 1')).toBe(2);
    expect(LADDER.indexOf('Silver 3')).toBe(3);
    expect(LADDER.indexOf('Silver 1')).toBe(5);
    expect(LADDER.indexOf('Expert 3')).toBe(6);
    expect(LADDER.indexOf('Expert 1')).toBe(8);
    // The load-bearing assertion: Platinum sits ABOVE Expert (index 9-11)
    // and BELOW Gold (index 12-14) — NOT in conventional Bronze/Silver/
    // Gold/Platinum/Diamond order, which would put Platinum after Gold.
    expect(LADDER.indexOf('Platinum 3')).toBe(9);
    expect(LADDER.indexOf('Platinum 1')).toBe(11);
    expect(LADDER.indexOf('Gold 3')).toBe(12);
    expect(LADDER.indexOf('Gold 1')).toBe(14);
    expect(LADDER.indexOf('Apex Grandmaster')).toBe(15);
    expect(LADDER.length).toBe(16);
  });
});

// -----------------------------------------------------------------------
// 3. Pre-match tier delta selection across EVERY band-to-band boundary
// -----------------------------------------------------------------------

describe('settleRp — pre-match tier band selects the delta row, verified at every band boundary', () => {
  it('Bronze 1 top (899) winning 1st crosses into Silver but still earns the BRONZE +120 row', () => {
    const result = settleRp({ rpBefore: 899, apexAttainedBefore: false, place: 1 });
    expect(result.rpDelta).toBe(120); // bronze first, not silver's +110
    expect(result.rpAfter).toBe(1019);
    expect(result.tierAfter).toBe('silver');
    expect(result.divisionAfter).toBe(3);
  });

  it('Silver 1 top (1799) winning 1st crosses into Expert but still earns the SILVER +110 row', () => {
    const result = settleRp({ rpBefore: 1799, apexAttainedBefore: false, place: 1 });
    expect(result.rpDelta).toBe(110); // silver first, not expert's +100
    expect(result.rpAfter).toBe(1909);
    expect(result.tierAfter).toBe('expert');
    expect(result.divisionAfter).toBe(3);
  });

  it('Expert 1 top (2699) winning 1st crosses into Platinum but still earns the EXPERT +100 row', () => {
    const result = settleRp({ rpBefore: 2699, apexAttainedBefore: false, place: 1 });
    expect(result.rpDelta).toBe(100); // expert first, not platinum's +90
    expect(result.rpAfter).toBe(2799);
    expect(result.tierAfter).toBe('platinum');
    expect(result.divisionAfter).toBe(3);
  });

  it('Platinum 1 top (3599) winning 1st crosses into Gold but still earns the PLATINUM +90 row', () => {
    const result = settleRp({ rpBefore: 3599, apexAttainedBefore: false, place: 1 });
    expect(result.rpDelta).toBe(90); // platinum first, not gold's +80
    expect(result.rpAfter).toBe(3689);
    expect(result.tierAfter).toBe('gold');
    expect(result.divisionAfter).toBe(3);
  });

  it('Gold 1 (4499) winning 1st crosses into Apex but still earns the GOLD +80 row (independent re-derivation of the builder-cited example)', () => {
    const result = settleRp({ rpBefore: 4499, apexAttainedBefore: false, place: 1 });
    expect(result.rpDelta).toBe(80); // gold first, not apex's +70
    expect(result.rpAfter).toBe(4579);
    expect(result.promotedToApex).toBe(true);
    expect(result.tierAfter).toBe('apex');
    expect(result.divisionAfter).toBeNull();
  });

  it('DEMOTION-adjacent case: Silver 3 bottom (905) losing 4th drops into Bronze but still eats the SILVER -60 row (not bronze -30)', () => {
    const result = settleRp({ rpBefore: 905, apexAttainedBefore: false, place: 4 });
    expect(result.rpDelta).toBe(-60); // silver fourth, not bronze's -30
    expect(result.rpAfter).toBe(845);
    expect(result.tierAfter).toBe('bronze');
    expect(result.divisionAfter).toBe(1);
  });
});

// -----------------------------------------------------------------------
// 4. Floor interaction: rpDelta must reflect the ACTUAL applied delta
// -----------------------------------------------------------------------

describe('settleRp — global 0 floor: rpDelta is the actual clamped delta, never the raw table value', () => {
  it('rpBefore=10, 4th place (raw -30 would go to -20): floors at 0, and rpDelta is -10, NOT -30', () => {
    const result = settleRp({ rpBefore: 10, apexAttainedBefore: false, place: 4 });
    expect(result.rpAfter).toBe(0);
    expect(result.rpDelta).toBe(-10); // actual delta applied, not the raw -30 table value
  });

  it('rpBefore=5, 4th place (raw -30 would go to -25): floors at 0, rpDelta is -5', () => {
    const result = settleRp({ rpBefore: 5, apexAttainedBefore: false, place: 4 });
    expect(result.rpAfter).toBe(0);
    expect(result.rpDelta).toBe(-5);
  });

  it('rpBefore=30, 4th place (raw -30 lands EXACTLY on 0, no distortion): rpDelta is the full -30', () => {
    const result = settleRp({ rpBefore: 30, apexAttainedBefore: false, place: 4 });
    expect(result.rpAfter).toBe(0);
    expect(result.rpDelta).toBe(-30); // no clamping needed here — exact landing
  });

  it('invariant holds under clamping: rpBefore + rpDelta === rpAfter always, even when floor clamps', () => {
    for (const rpBefore of [0, 1, 5, 10, 15, 20, 29, 30, 31]) {
      const result = settleRp({ rpBefore, apexAttainedBefore: false, place: 4 });
      expect(rpBefore + result.rpDelta).toBe(result.rpAfter);
    }
  });
});

// -----------------------------------------------------------------------
// 5. Apex floor interactions
// -----------------------------------------------------------------------

describe('settleRp — Apex floor (4500), including a non-clamped apex case', () => {
  it('already-Apex, exactly at floor (4500), 4th place: floors at 4500 exactly, rpDelta=0, promotedToApex=false', () => {
    const result = settleRp({ rpBefore: 4500, apexAttainedBefore: true, place: 4 });
    expect(result.rpAfter).toBe(APEX_THRESHOLD_RP);
    expect(result.rpDelta).toBe(0);
    expect(result.promotedToApex).toBe(false);
    expect(result.tierAfter).toBe('apex');
    expect(result.divisionAfter).toBeNull();
  });

  it('already-Apex, comfortably above floor (4700), 4th place (raw -180 lands at 4520, ABOVE the floor): no clamping occurs, rpDelta is the full -180', () => {
    const result = settleRp({ rpBefore: 4700, apexAttainedBefore: true, place: 4 });
    expect(result.rpAfter).toBe(4520);
    expect(result.rpDelta).toBe(-180); // not clamped — this is the un-clamped control case
    expect(result.promotedToApex).toBe(false);
  });

  it('already-Apex, close to floor (4550), 4th place (raw -180 would go to 4370, BELOW the floor): clamps to 4500, rpDelta is -50 not -180', () => {
    const result = settleRp({ rpBefore: 4550, apexAttainedBefore: true, place: 4 });
    expect(result.rpAfter).toBe(4500);
    expect(result.rpDelta).toBe(-50); // actual clamped delta, not raw -180
    expect(result.promotedToApex).toBe(false);
  });

  it('already-Apex has no ceiling: a good result raises rpAfter freely above 4500', () => {
    const result = settleRp({ rpBefore: 5000, apexAttainedBefore: true, place: 1 });
    expect(result.rpAfter).toBe(5070);
    expect(result.rpDelta).toBe(70);
  });
});

// -----------------------------------------------------------------------
// 6. promotedToApex exactness
// -----------------------------------------------------------------------

describe('settleRp — promotedToApex exactness', () => {
  it('real promotion: Gold 1 (4450) winning 1st (+80) crosses 4500 -> promotedToApex is true', () => {
    const result = settleRp({ rpBefore: 4450, apexAttainedBefore: false, place: 1 });
    expect(result.rpAfter).toBe(4530);
    expect(result.promotedToApex).toBe(true);
    expect(result.tierAfter).toBe('apex');
  });

  it('exact-crossing promotion: 4420 + Gold 1st (+80) = exactly 4500 -> promotedToApex is true', () => {
    const result = settleRp({ rpBefore: 4420, apexAttainedBefore: false, place: 1 });
    expect(result.rpAfter).toBe(4500);
    expect(result.promotedToApex).toBe(true);
  });

  it('near miss: 4400 + Gold 1st (+80) = 4480, does not cross -> promotedToApex is false', () => {
    const result = settleRp({ rpBefore: 4400, apexAttainedBefore: false, place: 1 });
    expect(result.rpAfter).toBe(4480);
    expect(result.promotedToApex).toBe(false);
    expect(result.tierAfter).toBe('gold');
    expect(result.divisionAfter).toBe(1);
  });

  it('already-Apex before the match (apexAttainedBefore=true): promotedToApex is always false regardless of placement, even on a big win', () => {
    const win = settleRp({ rpBefore: 5000, apexAttainedBefore: true, place: 1 });
    expect(win.promotedToApex).toBe(false);
    const loss = settleRp({ rpBefore: 5000, apexAttainedBefore: true, place: 4 });
    expect(loss.promotedToApex).toBe(false);
  });

  it('data-integrity anomaly probe: apexAttainedBefore=true but rpBefore far below 4500 (should not occur via normal settleRp chaining, but must not crash or report promotedToApex=true for an already-Apex player)', () => {
    // preRank here is 'apex' (sticky flag wins), delta row is apex's, floor
    // is the apex floor (4500) regardless of how low rpBefore was — the
    // implementation "self-heals" rpAfter up to 4500. Documenting actual
    // behavior; promotedToApex must stay false since apexAttainedBefore was
    // already true (this is not a NEW promotion).
    const result = settleRp({ rpBefore: 4000, apexAttainedBefore: true, place: 4 });
    expect(result.promotedToApex).toBe(false);
    expect(result.tierAfter).toBe('apex');
    expect(result.rpAfter).toBe(APEX_THRESHOLD_RP); // floor forces it back up to 4500
    expect(result.rpDelta).toBe(500); // 4000 -> 4500, NOT reflective of an actual 4th-place performance
  });

  it('rankForRp sanity for the same anomaly: apexAttained=true always wins over a low numeric rp (sticky), independent of settleRp', () => {
    expect(rankForRp(100, true)).toEqual({ tier: 'apex' });
    expect(rankForRp(4000, true)).toEqual({ tier: 'apex' });
  });
});

// -----------------------------------------------------------------------
// 7. -0 normalization across multiple arithmetic paths
// -----------------------------------------------------------------------

describe('settleRp — never returns JS -0, probed via several distinct arithmetic paths', () => {
  it('path A: a genuine 0-delta placement (Expert 3rd) away from any floor', () => {
    const result = settleRp({ rpBefore: 2050, apexAttainedBefore: false, place: 3 });
    expect(result.rpDelta).toBe(0);
    expect(Object.is(result.rpDelta, -0)).toBe(false);
    expect(Object.is(result.rpAfter, -0)).toBe(false);
  });

  it('path B: 0-floor clamp landing exactly at the floor (rpBefore=0, 4th place)', () => {
    const result = settleRp({ rpBefore: 0, apexAttainedBefore: false, place: 4 });
    expect(result.rpAfter).toBe(0);
    expect(Object.is(result.rpAfter, -0)).toBe(false);
    expect(Object.is(result.rpDelta, -0)).toBe(false);
  });

  it('path C: Apex floor clamp landing exactly at 4500 (already covered above but re-probed here specifically for -0)', () => {
    const result = settleRp({ rpBefore: 4680, apexAttainedBefore: true, place: 4 });
    expect(result.rpAfter).toBe(4500);
    expect(Object.is(result.rpAfter, -0)).toBe(false);
    expect(Object.is(result.rpDelta, -0)).toBe(false);
  });

  it('path D: exotic literal -0 passed in as rpBefore (JS numeric edge case, e.g. from JSON.parse("-0") or 0*-1 upstream) does not leak into the result', () => {
    const result = settleRp({ rpBefore: -0, apexAttainedBefore: false, place: 4 });
    expect(Object.is(result.rpAfter, -0)).toBe(false);
    expect(Object.is(result.rpDelta, -0)).toBe(false);
    expect(result.rpAfter).toBe(0);
  });
});
