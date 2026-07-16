/**
 * Ranked-ladder user-facing strings (English) — leaderboard page copy, rank
 * progress/promotion copy, the unranked-match notice, and ARIA labels for the
 * rank badge/progress bar. Same convention as src/lib/i18n/table.ts and
 * lobby.ts: game-domain vocabulary (tier/division labels, DP numeral
 * formatting) lives in src/lib/theme/frc.ts, not here — this file is strictly
 * ranked-ladder UI chrome copy. i18n-ready: keep every user-facing string
 * here, none inline in components.
 */

export const RANKED_STRINGS = {
  // Profile card (home page)
  profileCardHeading: 'District Rank',

  /**
   * Fallback display name used by `ensureProfile` (api-client.ts) when
   * lazily creating a profile with no display name yet available (e.g. on
   * first home-page load, before the player has typed a name into the
   * create/join form). Suffixed with a random 4-digit number at call time to
   * keep fresh profiles distinguishable on the Apex leaderboard.
   */
  defaultDisplayNamePrefix: 'Rookie Pilot',

  // Leaderboard page
  leaderboardHeading: 'Apex Grandmaster Leaderboard',
  foundingOrderHeading: 'Founding Order',
  rpOrderHeading: 'Current RP',
  leaderboardEmptyState: 'No Apex Grandmasters yet.',
  leaderboardRankColumn: '#',
  leaderboardNameColumn: 'Pilot',
  leaderboardPointsColumn: 'DP',

  // Promotion / settlement
  promotedToApexAnnouncement: 'Promoted to Apex Grandmaster!',

  // Unranked/pending match notices (match-standings)
  unrankedMatchNotice: 'This was an unranked match.',
  pendingRankedMatchNotice: 'Ranked results are still settling…',
} as const;

/** "{remainingDp} to next division" — `remainingDp` should already be display-formatted via frc.ts's `formatRankPoints`. */
export function rpToNextDivisionNarration(remainingDp: string): string {
  return `${remainingDp} to next division`;
}

/** ARIA label for a RankBadge, e.g. "Rank: Bronze 3". `tierText` should already be tierLabel(...)-formatted. */
export function rankBadgeAriaLabel(tierText: string): string {
  return `Rank: ${tierText}`;
}

/** ARIA label for the RankProgress bar, e.g. "Bronze 3 division progress". `tierText` should already be tierLabel(...)-formatted. */
export function rankProgressAriaLabel(tierText: string): string {
  return `${tierText} division progress`;
}
