import { describe, expect, it } from 'vitest';
import { ABANDONED_MATCH_RP_PENALTY, APEX_THRESHOLD_RP, DIVISION_RUNGS, LADDER, RP_DELTA_TABLE, RP_PER_DIVISION } from './config';

describe('LADDER', () => {
  it('has exactly 16 entries in the exact locked order', () => {
    expect(LADDER).toEqual([
      'Bronze 3',
      'Bronze 2',
      'Bronze 1',
      'Silver 3',
      'Silver 2',
      'Silver 1',
      'Expert 3',
      'Expert 2',
      'Expert 1',
      'Platinum 3',
      'Platinum 2',
      'Platinum 1',
      'Gold 3',
      'Gold 2',
      'Gold 1',
      'Apex Grandmaster',
    ]);
  });

  it('places Platinum above Expert and below Gold (owner-locked, not a bug)', () => {
    const expertIdx = LADDER.indexOf('Expert 1');
    const platinumIdx = LADDER.indexOf('Platinum 3');
    const goldIdx = LADDER.indexOf('Gold 3');
    expect(platinumIdx).toBeGreaterThan(expertIdx);
    expect(platinumIdx).toBeLessThan(goldIdx);
  });
});

describe('DIVISION_RUNGS thresholds', () => {
  it('are contiguous, non-overlapping, each exactly 300 wide, starting at 0', () => {
    expect(DIVISION_RUNGS.length).toBe(15);
    expect(DIVISION_RUNGS[0].rpThreshold).toBe(0);
    for (let i = 0; i < DIVISION_RUNGS.length; i++) {
      expect(DIVISION_RUNGS[i].rpThreshold).toBe(i * RP_PER_DIVISION);
    }
  });

  it('matches the exact owner-approved cumulative thresholds', () => {
    expect(DIVISION_RUNGS.map((r) => r.rpThreshold)).toEqual([
      0, 300, 600, 900, 1200, 1500, 1800, 2100, 2400, 2700, 3000, 3300, 3600, 3900, 4200,
    ]);
  });

  it('APEX_THRESHOLD_RP is Gold 1s ceiling (4200 + RP_PER_DIVISION)', () => {
    const gold1 = DIVISION_RUNGS.find((r) => r.band === 'gold' && r.division === 1);
    expect(gold1?.rpThreshold).toBe(4200);
    expect(APEX_THRESHOLD_RP).toBe(4500);
    expect(APEX_THRESHOLD_RP).toBe((gold1?.rpThreshold ?? 0) + RP_PER_DIVISION);
  });
});

describe('RP_DELTA_TABLE', () => {
  it('has all 4 placements defined for all 6 tier bands', () => {
    const bands: (keyof typeof RP_DELTA_TABLE)[] = ['bronze', 'silver', 'expert', 'platinum', 'gold', 'apex'];
    for (const band of bands) {
      const row = RP_DELTA_TABLE[band];
      expect(row).toBeDefined();
      expect(typeof row.first).toBe('number');
      expect(typeof row.second).toBe('number');
      expect(typeof row.third).toBe('number');
      expect(typeof row.fourth).toBe('number');
    }
  });

  it("Bronze's row is exactly +120/+60/+15/-30", () => {
    expect(RP_DELTA_TABLE.bronze).toEqual({ first: 120, second: 60, third: 15, fourth: -30 });
  });

  it('for 1st place, the reward is non-increasing as tier rises', () => {
    const order = [
      RP_DELTA_TABLE.bronze.first,
      RP_DELTA_TABLE.silver.first,
      RP_DELTA_TABLE.expert.first,
      RP_DELTA_TABLE.platinum.first,
      RP_DELTA_TABLE.gold.first,
      RP_DELTA_TABLE.apex.first,
    ];
    for (let i = 1; i < order.length; i++) {
      expect(order[i]).toBeLessThanOrEqual(order[i - 1]);
    }
  });

  it('for 4th place, the penalty is non-decreasing in magnitude (strictly more negative or equal) as tier rises', () => {
    const order = [
      RP_DELTA_TABLE.bronze.fourth,
      RP_DELTA_TABLE.silver.fourth,
      RP_DELTA_TABLE.expert.fourth,
      RP_DELTA_TABLE.platinum.fourth,
      RP_DELTA_TABLE.gold.fourth,
      RP_DELTA_TABLE.apex.fourth,
    ];
    for (let i = 1; i < order.length; i++) {
      expect(order[i]).toBeLessThanOrEqual(order[i - 1]);
    }
  });
});

describe('ABANDONED_MATCH_RP_PENALTY', () => {
  it('defaults to 0 and is not wired to anything this phase', () => {
    expect(ABANDONED_MATCH_RP_PENALTY).toBe(0);
  });
});
