'use client';

import { Progress } from '@/components/ui/progress';
import { RankBadge } from './rank-badge';
import { rankProgressAriaLabel, rpToNextDivisionNarration } from '@/lib/i18n/ranked';
import { formatRankPoints, tierLabel } from '@/lib/theme/frc';
import { progressWithinDivision } from '@/lib/ranked/ladder';
import type { Division, TierBand } from '@/lib/ranked/config';

export interface RankProgressProps {
  /**
   * The exact RP total. This component is ONLY ever fed the VIEWER'S OWN
   * `ProfileMeResponse` data — exact RP totals are private-to-owner
   * everywhere else in this app (the Apex leaderboard is the one deliberate
   * public exception, and that surface uses formatRankPoints directly, not
   * this component). Never wire another player's RP into this prop.
   */
  readonly rankPoints: number;
  readonly tier: TierBand;
  readonly division: Division | null;
}

/**
 * A division progress bar for the viewer's own ranked profile. Fraction math
 * comes entirely from `progressWithinDivision` (src/lib/ranked/ladder.ts) —
 * never recomputed here. ASCII RP numerals render in `font-hud` (VT323 — per
 * docs/DESIGN.md's font-role convention: short ASCII numeral strings only,
 * never CJK).
 */
export function RankProgress({ rankPoints, tier, division }: RankProgressProps): React.JSX.Element {
  const progress = progressWithinDivision(rankPoints);
  const label = tierLabel(tier, division);
  const isApex = tier === 'apex';
  const remaining = progress.span - progress.current;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <RankBadge tier={tier} division={division} size="md" />
          <span className="font-display text-sm text-foreground">{label}</span>
        </div>
        <span className="font-hud text-accent">{formatRankPoints(rankPoints)}</span>
      </div>
      <Progress value={isApex ? 100 : progress.fraction * 100} aria-label={rankProgressAriaLabel(label)} />
      {!isApex && <span className="text-xs text-muted-foreground">{rpToNextDivisionNarration(formatRankPoints(remaining))}</span>}
    </div>
  );
}
