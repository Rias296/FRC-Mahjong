/**
 * Pure, presentation-only helpers for rendering tiles on the table view.
 * No React, no fetch, no side effects — deterministic transforms over
 * protocol/engine types only. See docs/DESIGN.md for the visual spec these
 * feed into (TileFace, PlayerRack, OpponentPanel, etc.).
 */

import { HAND_TILE_KINDS, kindKey, type TileKind } from '../../engine/tiles';
import { nextSeat, type Seat } from '../../engine/seats';
import type { ClientMeld, ClientTile } from '../protocol';

export type AccentKey =
  | 'wan'
  | 'tong'
  | 'tiao'
  | 'wind'
  | 'dragon-red'
  | 'dragon-green'
  | 'dragon-white'
  | 'flower';

export interface TileGlyph {
  readonly rank: string | null;
  readonly glyph: string;
  readonly accent: AccentKey;
}

const WIND_GLYPHS: Readonly<Record<'east' | 'south' | 'west' | 'north', string>> = {
  east: '東',
  south: '南',
  west: '西',
  north: '北',
};

const DRAGON_GLYPHS: Readonly<Record<'red' | 'green' | 'white', string>> = {
  red: '中',
  green: '發',
  white: '白',
};

const FLOWER_GLYPHS: Readonly<Record<1 | 2 | 3 | 4, string>> = {
  1: '梅',
  2: '蘭',
  3: '菊',
  4: '竹',
};

const SEASON_GLYPHS: Readonly<Record<1 | 2 | 3 | 4, string>> = {
  1: '春',
  2: '夏',
  3: '秋',
  4: '冬',
};

const SUIT_GLYPHS: Readonly<Record<'wan' | 'tong' | 'tiao', string>> = {
  wan: '萬',
  tong: '筒',
  tiao: '條',
};

/** Maps a TileKind to its display glyph, rank, and color accent. */
export function tileGlyph(kind: TileKind): TileGlyph {
  switch (kind.category) {
    case 'suit':
      return { rank: String(kind.rank), glyph: SUIT_GLYPHS[kind.suit], accent: kind.suit };
    case 'wind':
      return { rank: null, glyph: WIND_GLYPHS[kind.wind], accent: 'wind' };
    case 'dragon':
      return { rank: null, glyph: DRAGON_GLYPHS[kind.dragon], accent: `dragon-${kind.dragon}` };
    case 'flower':
      return {
        rank: null,
        glyph: kind.series === 'flower' ? FLOWER_GLYPHS[kind.number] : SEASON_GLYPHS[kind.number],
        accent: 'flower',
      };
  }
}

// --- Canonical display sort order -------------------------------------------

const HAND_KIND_ORDER = new Map<string, number>(HAND_TILE_KINDS.map((kind, index) => [kindKey(kind), index]));

/**
 * Flowers/seasons have no entry in HAND_TILE_KINDS (it's the 34 non-flower
 * kinds only); they sort after every honor tile, flowers before seasons,
 * each ordered by number.
 */
function flowerSortOffset(kind: Extract<TileKind, { category: 'flower' }>): number {
  const seriesOffset = kind.series === 'flower' ? 0 : 4;
  return HAND_TILE_KINDS.length + seriesOffset + (kind.number - 1);
}

function sortIndexFor(kind: TileKind): number {
  if (kind.category === 'flower') {
    return flowerSortOffset(kind);
  }
  return HAND_KIND_ORDER.get(kindKey(kind)) ?? HAND_TILE_KINDS.length;
}

/**
 * Sorts tiles into canonical HAND_TILE_KINDS order (flowers/seasons last).
 * Non-mutating; stable across tiles that share a kind (their relative input
 * order is preserved).
 */
export function sortTilesForDisplay(tiles: readonly ClientTile[]): ClientTile[] {
  return tiles
    .map((tile, index) => ({ tile, index }))
    .sort((a, b) => {
      const diff = sortIndexFor(a.tile.kind) - sortIndexFor(b.tile.kind);
      return diff !== 0 ? diff : a.index - b.index;
    })
    .map((entry) => entry.tile);
}

// --- Seat layout --------------------------------------------------------------

export type SeatPosition = 'bottom' | 'right' | 'top' | 'left';

/** The viewer is always bottom; nextSeat(viewer) is right, then top, then left. */
export function seatPositionFor(seat: Seat, viewerSeat: Seat): SeatPosition {
  if (seat === viewerSeat) return 'bottom';
  const right = nextSeat(viewerSeat);
  if (seat === right) return 'right';
  const top = nextSeat(right);
  if (seat === top) return 'top';
  return 'left';
}

// --- Meld masking ---------------------------------------------------------

/** True iff `meld` is a concealed kong belonging to someone other than the viewer. */
export function meldFaceDown(meld: ClientMeld, ownerIsViewer: boolean): boolean {
  return meld.concealed && meld.kind === 'kong' && !ownerIsViewer;
}
