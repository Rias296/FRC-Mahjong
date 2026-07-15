import { Hexagon } from 'lucide-react';
import { tileGlyph, type AccentKey } from '@/lib/table/tile-display';
import { TILE_ART_MODE, tileBackSpriteStyle, tileSpriteStyle } from '@/lib/table/tile-sprites';
import { tileKindLabel } from '@/lib/theme/frc';
import { cn } from '@/lib/utils';
import type { ClientTile } from '@/lib/protocol';

const ACCENT_TEXT_CLASSES: Readonly<Record<AccentKey, string>> = {
  wan: 'text-destructive',
  'dragon-red': 'text-destructive',
  tiao: 'text-success',
  'dragon-green': 'text-success',
  tong: 'text-frc-blue-text',
  wind: 'text-frc-blue-text',
  'dragon-white': 'text-frc-blue-text',
  flower: 'text-accent',
};

const TILE_SIZE_CLASSES = 'h-14 w-10 sm:h-[66px] sm:w-12';

export interface TileFaceProps {
  readonly tile: ClientTile;
  readonly className?: string;
}

export function TileFace({ tile, className }: TileFaceProps): React.JSX.Element {
  const label = tileKindLabel(tile.kind);

  if (TILE_ART_MODE === 'sprite') {
    const sprite = tileSpriteStyle(tile.kind);
    if (sprite !== null) {
      return (
        <div
          role="img"
          title={label}
          aria-label={label}
          style={sprite}
          className={cn(TILE_SIZE_CLASSES, 'pixelated flex-shrink-0 bg-no-repeat', className)}
        />
      );
    }
  }

  const glyph = tileGlyph(tile.kind);
  const accentClass = ACCENT_TEXT_CLASSES[glyph.accent];

  return (
    <div
      role="img"
      title={label}
      aria-label={label}
      className={cn(
        TILE_SIZE_CLASSES,
        'flex flex-shrink-0 flex-col items-center justify-center gap-0.5 rounded-md bg-tile-face shadow-sm ring-1 ring-black/10',
        className,
      )}
    >
      {glyph.rank !== null && <span className={cn('text-xs leading-none font-semibold', accentClass)}>{glyph.rank}</span>}
      <span className={cn('text-lg leading-none font-display', accentClass)}>{glyph.glyph}</span>
    </div>
  );
}

export interface FaceDownTileProps {
  readonly className?: string;
}

export function FaceDownTile({ className }: FaceDownTileProps): React.JSX.Element {
  if (TILE_ART_MODE === 'sprite') {
    return (
      <div
        role="img"
        aria-hidden="true"
        style={tileBackSpriteStyle()}
        className={cn(TILE_SIZE_CLASSES, 'pixelated flex-shrink-0 bg-no-repeat', className)}
      />
    );
  }

  return (
    <div
      role="img"
      aria-hidden="true"
      className={cn(
        TILE_SIZE_CLASSES,
        'flex flex-shrink-0 items-center justify-center rounded-md bg-primary-deep ring-1 ring-black/20',
        className,
      )}
    >
      <Hexagon className="size-4 text-tile-face-muted" strokeWidth={1.5} />
    </div>
  );
}
