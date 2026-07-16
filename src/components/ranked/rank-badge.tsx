import { rankBadgeAriaLabel } from '@/lib/i18n/ranked';
import { tierLabel } from '@/lib/theme/frc';
import { cn } from '@/lib/utils';
import type { Division, TierBand } from '@/lib/ranked/config';

export interface RankBadgeProps {
  readonly tier: TierBand;
  readonly division: Division | null;
  readonly size?: 'sm' | 'md';
  readonly className?: string;
}

/**
 * In-repo SVG-free seal-stamp badge for a tier/division — no external image
 * assets (see docs/ASSETS.md: nothing licensed exists for this, none was
 * sourced). Same rotated-square lacquer-seal motif as
 * match-standings.tsx's pre-existing champion stamp, but tier-colored via the
 * `--tier-*` custom-property tokens declared in globals.css's `@theme`
 * block — every color here comes from a Tailwind utility generated from
 * those tokens (`border-tier-*`/`text-tier-*`/`bg-tier-*`), never a
 * hardcoded hex in this file, so this passes theme-guard.test.ts unmodified.
 *
 * The tier→className map is a static, fully-literal Record (not a
 * template-interpolated class string) because Tailwind's build-time class
 * scanner only picks up class names it can see as literal text in source.
 */
const TIER_BADGE_CLASSES: Readonly<Record<TierBand, string>> = {
  bronze: 'border-tier-bronze text-tier-bronze bg-tier-bronze/10',
  silver: 'border-tier-silver text-tier-silver bg-tier-silver/10',
  expert: 'border-tier-expert text-tier-expert bg-tier-expert/10',
  platinum: 'border-tier-platinum text-tier-platinum bg-tier-platinum/10',
  gold: 'border-tier-gold text-tier-gold bg-tier-gold/10',
  apex: 'border-tier-apex text-tier-apex bg-tier-apex/10',
};

const BAND_INITIAL: Readonly<Record<Exclude<TierBand, 'apex'>, string>> = {
  bronze: 'B',
  silver: 'S',
  expert: 'E',
  platinum: 'P',
  gold: 'G',
};

/** Compact glyph shown inside the small badge itself — full spoken text lives in the aria-label. */
function shortTierGlyph(tier: TierBand, division: Division | null): string {
  if (tier === 'apex') return 'GM';
  return `${BAND_INITIAL[tier]}${division ?? ''}`;
}

const SIZE_CLASSES: Readonly<Record<'sm' | 'md', string>> = {
  sm: 'px-1.5 py-0.5 text-[10px]',
  md: 'px-2.5 py-1 text-sm',
};

/**
 * Apex Grandmaster is the most prestigious/distinct tier (per the plan): it
 * gets an extra jade inner ring on top of its own gold-toned border, rather
 * than a new hex token — reuses the existing `--color-jade` utility already
 * shipped for the discard-pool wash.
 */
export function RankBadge({ tier, division, size = 'sm', className }: RankBadgeProps): React.JSX.Element {
  const label = tierLabel(tier, division);
  return (
    <span
      role="img"
      aria-label={rankBadgeAriaLabel(label)}
      className={cn(
        '-rotate-6 inline-flex items-center justify-center rounded-sm border-2 font-serif font-semibold tracking-wide uppercase',
        SIZE_CLASSES[size],
        TIER_BADGE_CLASSES[tier],
        tier === 'apex' && 'ring-2 ring-jade ring-offset-1 ring-offset-background',
        className,
      )}
    >
      {shortTierGlyph(tier, division)}
    </span>
  );
}
