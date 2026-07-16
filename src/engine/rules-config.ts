export interface RulesConfig {
  /** Tiles that must remain undrawn; hand draws when wallRemaining ≤ this. §10 */
  deadWallReserve: number;                    // default 16

  /** Minimum handTai required to declare hu. §11 */
  minTaiToWin: number;                        // default 0

  /**
   * 底 — base points per payment leg. §11
   * @deprecated Retained for stored-config/wire compatibility only — the
   * engine reads `points.basePoints`/`points.perTai` instead. Do not remove
   * or rename; existing persisted `rules_config` rows and
   * `isValidRulesOverride` still accept these flat keys.
   */
  basePoints: number;                         // default 3

  /**
   * 台 — points per tai. §11
   * @deprecated Retained for stored-config/wire compatibility only — the
   * engine reads `points.basePoints`/`points.perTai` instead. Do not remove
   * or rename; existing persisted `rules_config` rows and
   * `isValidRulesOverride` still accept these flat keys.
   */
  pointsPerTai: number;                       // default 1

  /** 自摸 tai added on self-drawn wins. §11 */
  selfDrawTai: number;                        // default 1

  /** 搶槓 tai added on a successful rob. §7.3 */
  robKongTai: number;                         // default 1

  /** Robbing the kong. §7 */
  robKong: {
    enabled: boolean;                         // default true
    robConcealedKong: boolean;                // default false
  };

  /** 過水 sacred discard. §8 */
  sacredDiscard: {
    enabled: boolean;                         // default true
    scope: 'until-next-self-discard' | 'entire-hand'; // default 'until-next-self-discard'
  };

  /** 一炮多響 — allow multiple simultaneous winners on one discard/rob. §6.1, §7.2 */
  multipleWinners: boolean;                   // default false

  /** 連莊 on exhaustive draw. §9 */
  dealerRepeatsOnDraw: boolean;               // default true

  /** 莊家台 — dealer bonus tai on dealer-involved legs. §9 */
  dealerBaseTai: number;                      // default 1

  /** 連N拉N — extra tai per consecutive dealer repeat. §9 */
  dealerRepeatBonusTaiPerRepeat: number;      // default 2

  /**
   * Pool-scale match-points model, Mahjong-Soul-style. §11, §13. The engine
   * reads these fields for payment-leg amounts; the flat `basePoints` /
   * `pointsPerTai` fields above are vestigial (wire/stored-config
   * compatibility only).
   */
  points: {
    /** Starting points pool per seat. §13 */
    startingPoints: number;                   // default 100000

    /** 底 — pool-scale base points per payment leg. §11 */
    basePoints: number;                       // default 3000

    /** 台 — pool-scale points per tai. §11 */
    perTai: number;                           // default 1000
  };
}

export const DEFAULT_RULES: RulesConfig = Object.freeze({
  deadWallReserve: 16,
  minTaiToWin: 0,
  basePoints: 3,
  pointsPerTai: 1,
  selfDrawTai: 1,
  robKongTai: 1,
  robKong: Object.freeze({ enabled: true, robConcealedKong: false }),
  sacredDiscard: Object.freeze({ enabled: true, scope: 'until-next-self-discard' }),
  multipleWinners: false,
  dealerRepeatsOnDraw: true,
  dealerBaseTai: 1,
  dealerRepeatBonusTaiPerRepeat: 2,
  points: Object.freeze({ startingPoints: 100000, basePoints: 3000, perTai: 1000 }),
});

/**
 * Deep-merges a partial/stored `RulesConfig` with `DEFAULT_RULES`, filling in
 * any missing top-level field and any missing nested field within
 * `robKong`/`sacredDiscard`/`points` from the corresponding default. Mirrors
 * `src/server/games.ts`'s `mergeRules` nesting-merge pattern so a stored
 * config missing `points` entirely (pre-existing persisted rows) or carrying
 * only a partial `points` override both normalize to a fully-populated
 * `RulesConfig`.
 */
export function normalizeRules(stored: Partial<RulesConfig>): RulesConfig {
  return {
    ...DEFAULT_RULES,
    ...stored,
    robKong: { ...DEFAULT_RULES.robKong, ...stored.robKong },
    sacredDiscard: { ...DEFAULT_RULES.sacredDiscard, ...stored.sacredDiscard },
    points: { ...DEFAULT_RULES.points, ...stored.points },
  };
}
