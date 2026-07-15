/**
 * Pure, presentation-only mapping from tile kinds to pixel-art sprite-sheet
 * coordinates and CSS background styles. No React, no fetch, no side
 * effects — deterministic transforms over engine types only, mirroring the
 * sibling `tile-display.ts` module (glyph fallback lives there).
 *
 * Sprite sheets and their geometry are documented in docs/ASSETS.md.
 */

import { HAND_TILE_KINDS, kindKey, type TileKind } from '../../engine/tiles';

export type DeckVariant = 'light' | 'light-indexed' | 'dark' | 'dark-indexed';

export const DEFAULT_DECK_VARIANT: DeckVariant = 'light-indexed';

/** One-line rollback switch: flip to 'glyph' to fall back to text glyphs everywhere. */
export const TILE_ART_MODE: 'sprite' | 'glyph' = 'sprite';

export interface SpriteCoord {
  readonly col: number;
  readonly row: number;
}

export interface SpriteStyle {
  readonly backgroundImage: string;
  readonly backgroundSize: string;
  readonly backgroundPosition: string;
}

// --- Sheet geometry ---------------------------------------------------------

/** Every sprite cell is CELL x CELL px; the actual art sits at (ART_X, ART_Y) sized ART_W x ART_H within it. */
const CELL = 64;
const ART_X = 10;
const ART_Y = 2;
const ART_W = 44;
const ART_H = 60;

const FACE_SHEET_COLS = 10;
const FACE_SHEET_ROWS = 5;
const FACE_SHEET_WIDTH = FACE_SHEET_COLS * CELL; // 640
const FACE_SHEET_HEIGHT = FACE_SHEET_ROWS * CELL; // 320

const BACKS_SHEET_COLS = 7;
const BACKS_SHEET_ROWS = 3;
const BACKS_SHEET_WIDTH = BACKS_SHEET_COLS * CELL; // 448
const BACKS_SHEET_HEIGHT = BACKS_SHEET_ROWS * CELL; // 192

const DECK_FILENAMES: Readonly<Record<DeckVariant, string>> = {
  light: 'deck_mahjong_light_0.png',
  'light-indexed': 'deck_mahjong_light_1.png',
  dark: 'deck_mahjong_dark_0.png',
  'dark-indexed': 'deck_mahjong_dark_1.png',
};

const BACKS_FILENAME = 'deck_mahjong_backs.png';

const TILES_URL_BASE = '/tiles';

// --- Coordinate map ----------------------------------------------------------
//
// Tong/dots 1-9 -> row 0, cols 0-8
// Tiao/bamboo 1-9 -> row 1, cols 0-8
// Wan/characters 1-9 -> row 2, cols 0-8
// Winds east/south/west/north -> row 3, cols 0/1/2/3
// Dragons red/green/white -> row 3, cols 4/5/6
// Seasons 1-4 (spring/summer/autumn/winter) -> row 4, cols 0/1/2/3
// Flowers 1-4 (plum/orchid/chrysanthemum/bamboo) -> row 4, cols 4/5/6/7
//
// This ordering matches docs/RULES.md §1's flower/season numbering
// (plum=1..bamboo=4, spring=1..winter=4; see tile-display.ts's
// FLOWER_GLYPHS/SEASON_GLYPHS, which use the same numbering).

const SUIT_ROW: Readonly<Record<'tong' | 'tiao' | 'wan', number>> = {
  tong: 0,
  tiao: 1,
  wan: 2,
};

const HONOR_ROW = 3;
const WIND_COL: Readonly<Record<'east' | 'south' | 'west' | 'north', number>> = {
  east: 0,
  south: 1,
  west: 2,
  north: 3,
};
const DRAGON_COL: Readonly<Record<'red' | 'green' | 'white', number>> = {
  red: 4,
  green: 5,
  white: 6,
};

const FLOWER_SEASON_ROW = 4;
const SEASON_COL: Readonly<Record<1 | 2 | 3 | 4, number>> = { 1: 0, 2: 1, 3: 2, 4: 3 };
const FLOWER_COL: Readonly<Record<1 | 2 | 3 | 4, number>> = { 1: 4, 2: 5, 3: 6, 4: 7 };

const BACK_COORD: SpriteCoord = { col: 0, row: 1 };

function computeCoord(kind: TileKind): SpriteCoord {
  switch (kind.category) {
    case 'suit':
      return { col: kind.rank - 1, row: SUIT_ROW[kind.suit] };
    case 'wind':
      return { col: WIND_COL[kind.wind], row: HONOR_ROW };
    case 'dragon':
      return { col: DRAGON_COL[kind.dragon], row: HONOR_ROW };
    case 'flower':
      return kind.series === 'flower'
        ? { col: FLOWER_COL[kind.number], row: FLOWER_SEASON_ROW }
        : { col: SEASON_COL[kind.number], row: FLOWER_SEASON_ROW };
  }
}

/** All 42 tile kinds the engine defines (27 suit + 4 wind + 3 dragon + 4 flower + 4 season). */
const ALL_TILE_KINDS: readonly TileKind[] = [
  ...HAND_TILE_KINDS,
  { category: 'flower', series: 'flower', number: 1 },
  { category: 'flower', series: 'flower', number: 2 },
  { category: 'flower', series: 'flower', number: 3 },
  { category: 'flower', series: 'flower', number: 4 },
  { category: 'flower', series: 'season', number: 1 },
  { category: 'flower', series: 'season', number: 2 },
  { category: 'flower', series: 'season', number: 3 },
  { category: 'flower', series: 'season', number: 4 },
];

/** Total map: every one of the 42 tile kinds resolves to a coordinate. */
const SPRITE_COORDS: ReadonlyMap<string, SpriteCoord> = new Map(
  ALL_TILE_KINDS.map((kind) => [kindKey(kind), computeCoord(kind)]),
);

/**
 * Looks up a tile kind's sprite-sheet coordinate. Returns null only as a
 * defensive/unreachable fallback — the map is total over every real
 * TileKind the engine can produce.
 */
export function tileSpriteCoord(kind: TileKind): SpriteCoord | null {
  return SPRITE_COORDS.get(kindKey(kind)) ?? null;
}

// --- CSS sprite-position math -------------------------------------------------

function formatPercent(value: number): string {
  return `${value.toFixed(4)}%`;
}

function sizePercent(sheetWidth: number, sheetHeight: number): string {
  const x = (sheetWidth / ART_W) * 100;
  const y = (sheetHeight / ART_H) * 100;
  return `${formatPercent(x)} ${formatPercent(y)}`;
}

function positionPercent(coord: SpriteCoord, sheetWidth: number, sheetHeight: number): string {
  const targetX = coord.col * CELL + ART_X;
  const targetY = coord.row * CELL + ART_Y;
  const x = (targetX / (sheetWidth - ART_W)) * 100;
  const y = (targetY / (sheetHeight - ART_H)) * 100;
  return `${formatPercent(x)} ${formatPercent(y)}`;
}

/**
 * Computes the CSS background-* values to render `kind` from the given deck
 * variant's sprite sheet. Returns null iff `tileSpriteCoord` returns null
 * (defensive/unreachable for real tile kinds).
 */
export function tileSpriteStyle(kind: TileKind, deck: DeckVariant = DEFAULT_DECK_VARIANT): SpriteStyle | null {
  const coord = tileSpriteCoord(kind);
  if (coord === null) return null;

  return {
    backgroundImage: `url('${TILES_URL_BASE}/${DECK_FILENAMES[deck]}')`,
    backgroundSize: sizePercent(FACE_SHEET_WIDTH, FACE_SHEET_HEIGHT),
    backgroundPosition: positionPercent(coord, FACE_SHEET_WIDTH, FACE_SHEET_HEIGHT),
  };
}

/** Computes the CSS background-* values for the face-down tile-back sprite. */
export function tileBackSpriteStyle(): SpriteStyle {
  return {
    backgroundImage: `url('${TILES_URL_BASE}/${BACKS_FILENAME}')`,
    backgroundSize: sizePercent(BACKS_SHEET_WIDTH, BACKS_SHEET_HEIGHT),
    backgroundPosition: positionPercent(BACK_COORD, BACKS_SHEET_WIDTH, BACKS_SHEET_HEIGHT),
  };
}
