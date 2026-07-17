import { cn } from '@/lib/utils';

/**
 * Shared oriental "material layer" chrome primitive (Phase 2, Round 1):
 * a wood-lacquer frame (`frame-wood`, see globals.css) with four gold
 * corner-bracket ornaments, wrapping a `bg-popover` content well. Used by
 * resting-state chrome (seat panels, scoreboard) — deliberately NOT used on
 * tile-face.tsx/discard-pool.tsx (tile readability must stay unornamented,
 * see src/lib/theme/material-guard.test.ts).
 *
 * Pure presentational: no state, no engine imports, no fetch — safe as a
 * server component (no `'use client'` needed).
 */
export interface OrnateFrameProps extends React.ComponentProps<'div'> {
  readonly size?: 'sm' | 'md';
  readonly contentClassName?: string;
}

const FRAME_PADDING: Readonly<Record<'sm' | 'md', string>> = {
  sm: 'p-[3px]',
  md: 'p-1',
};

export function OrnateFrame({
  size = 'md',
  className,
  contentClassName,
  children,
  ...props
}: OrnateFrameProps): React.JSX.Element {
  return (
    <div className={cn('frame-wood relative rounded-lg', FRAME_PADDING[size], className)} {...props}>
      <CornerBracket size={size} className="absolute top-0 left-0" />
      <CornerBracket size={size} className="absolute top-0 right-0 rotate-90" />
      <CornerBracket size={size} className="absolute bottom-0 left-0 -rotate-90" />
      <CornerBracket size={size} className="absolute bottom-0 right-0 rotate-180" />
      <div className={cn('rounded-[calc(var(--radius-md)-2px)] bg-popover ring-1 ring-inset ring-accent/15', contentClassName)}>
        {children}
      </div>
    </div>
  );
}

export interface CornerBracketProps {
  readonly size?: 'sm' | 'md';
  readonly className?: string;
}

const BRACKET_SIZE: Readonly<Record<'sm' | 'md', string>> = {
  sm: 'size-3',
  md: 'size-5',
};

/**
 * Original gold corner-ornament artwork (not sliced from any reference
 * image) — a bracket motif echoing traditional Chinese furniture hardware.
 * Decorative only: `aria-hidden` + `pointer-events-none` so it never
 * intercepts taps/clicks or gets announced by screen readers.
 */
export function CornerBracket({ size = 'md', className }: CornerBracketProps): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={cn(BRACKET_SIZE[size], 'pointer-events-none text-accent/80', className)}
    >
      <path d="M23 2H7a5 5 0 0 0-5 5v16" stroke="currentColor" strokeWidth="2.5" />
      <path d="M23 6.5H10a3.5 3.5 0 0 0-3.5 3.5v13" stroke="currentColor" strokeWidth="1.25" opacity="0.55" />
      <circle cx="6.5" cy="6.5" r="1.4" fill="currentColor" opacity="0.9" />
    </svg>
  );
}
