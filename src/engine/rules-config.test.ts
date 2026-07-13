import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES, type RulesConfig } from './rules-config';

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
    };

    expect(DEFAULT_RULES).toEqual(expected);
  });
});
