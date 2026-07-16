/**
 * Ranked-ladder tier/threshold/RP-delta config. Pure data only — no imports
 * beyond this module's own types, no functions with logic (that lives in
 * `./ladder.ts`). Every numeric value here is owner-signed-off (see
 * `docs/DECISIONS.md`'s "ranked-ladder sign-off" entry) — do not adjust.
 *
 * Full normative spec: `docs/RANKED.md`.
 */

/** A rung's numbered division within a tier band. Apex has no division. */
export type Division = 1 | 2 | 3;

/** The 5 tier bands that have numbered divisions (3/2/1 each). */
export type Band = 'bronze' | 'silver' | 'expert' | 'platinum' | 'gold';

/**
 * All 6 bands used for RP-delta lookup, `apex` included as its own band
 * (Apex Grandmaster is a single terminal state, not a numbered division, but
 * it still has its own placement-delta row).
 */
export type TierBand = Band | 'apex';

/** One of the 15 numbered rungs (band + division), with its RP threshold. */
export interface DivisionRung {
  readonly band: Band;
  readonly division: Division;
  /** RP at which this rung begins (inclusive lower bound). */
  readonly rpThreshold: number;
}

/** RP width of every division. */
export const RP_PER_DIVISION = 300;

/**
 * The 15 numbered rungs in locked ladder order (Bronze 3 lowest → Gold 1
 * highest numbered rung). Platinum intentionally sits above Expert and below
 * Gold — this is an owner-approved, locked ordering, not a bug to "fix".
 */
export const DIVISION_RUNGS: readonly DivisionRung[] = [
  { band: 'bronze', division: 3, rpThreshold: 0 },
  { band: 'bronze', division: 2, rpThreshold: 300 },
  { band: 'bronze', division: 1, rpThreshold: 600 },
  { band: 'silver', division: 3, rpThreshold: 900 },
  { band: 'silver', division: 2, rpThreshold: 1200 },
  { band: 'silver', division: 1, rpThreshold: 1500 },
  { band: 'expert', division: 3, rpThreshold: 1800 },
  { band: 'expert', division: 2, rpThreshold: 2100 },
  { band: 'expert', division: 1, rpThreshold: 2400 },
  { band: 'platinum', division: 3, rpThreshold: 2700 },
  { band: 'platinum', division: 2, rpThreshold: 3000 },
  { band: 'platinum', division: 1, rpThreshold: 3300 },
  { band: 'gold', division: 3, rpThreshold: 3600 },
  { band: 'gold', division: 2, rpThreshold: 3900 },
  { band: 'gold', division: 1, rpThreshold: 4200 },
] as const;

/** Display label for a division rung, e.g. "Bronze 3". */
function rungLabel(rung: DivisionRung): string {
  const capitalized = rung.band.charAt(0).toUpperCase() + rung.band.slice(1);
  return `${capitalized} ${rung.division}`;
}

/**
 * The full locked 16-rung ladder order, as display labels: the 15 numbered
 * division rungs followed by Apex Grandmaster as a distinct terminal state
 * (not a numbered division). This exact order is owner-approved — do not
 * alphabetize or otherwise "correct" it.
 */
export const LADDER: readonly string[] = [...DIVISION_RUNGS.map(rungLabel), 'Apex Grandmaster'] as const;

/**
 * RP at which a player becomes Apex Grandmaster — equal to Gold 1's ceiling
 * (Gold 1 begins at 4200 and spans one more RP_PER_DIVISION to 4500).
 */
export const APEX_THRESHOLD_RP = 4500;

/** RP delta for each of the 4 placements. */
export interface PlacementDeltas {
  readonly first: number;
  readonly second: number;
  readonly third: number;
  readonly fourth: number;
}

/**
 * RP-delta-by-placement table, keyed by tier band. All 3 divisions within a
 * band (e.g. Bronze 3/2/1) share the same delta row — deltas only vary by
 * band, never by division within a band.
 */
export const RP_DELTA_TABLE: Readonly<Record<TierBand, PlacementDeltas>> = {
  bronze: { first: 120, second: 60, third: 15, fourth: -30 },
  silver: { first: 110, second: 55, third: 5, fourth: -60 },
  expert: { first: 100, second: 50, third: 0, fourth: -90 },
  platinum: { first: 90, second: 45, third: -10, fourth: -120 },
  gold: { first: 80, second: 40, third: -20, fourth: -150 },
  apex: { first: 70, second: 35, third: -30, fourth: -180 },
};

/**
 * RP penalty for an abandoned/forfeited match. Defaults to 0 and is not
 * wired to anything this phase — this codebase has no abandonment/forfeit
 * detection yet, so a nonzero default would punish innocent players (e.g. a
 * disconnected opponent, not the player who actually left). This is a config
 * hook for a future forfeit feature, owner-approved as unused-but-present
 * this round.
 */
export const ABANDONED_MATCH_RP_PENALTY = 0;
