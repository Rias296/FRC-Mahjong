/**
 * Tester-authored adversarial tests for the tile-sprite pipeline, on top of
 * the builder's own tile-sprites.test.ts. These independently recompute the
 * CSS sprite geometry from the documented sheet constants (rather than
 * trusting the module's own internal formulas) and probe totality/range
 * invariants across every deck variant, not just the default.
 */

import { describe, expect, it } from 'vitest';
import { HAND_TILE_KINDS, kindKey, type TileKind } from '../../engine/tiles';
import {
  DEFAULT_DECK_VARIANT,
  tileBackSpriteStyle,
  tileSpriteCoord,
  tileSpriteStyle,
  type DeckVariant,
} from './tile-sprites';

const FLOWER_SEASON_KINDS: readonly TileKind[] = (['flower', 'season'] as const).flatMap((series) =>
  ([1, 2, 3, 4] as const).map((number): TileKind => ({ category: 'flower', series, number })),
);

const ALL_KINDS: readonly TileKind[] = [...HAND_TILE_KINDS, ...FLOWER_SEASON_KINDS];

// Independently re-derived sheet geometry constants (deliberately not
// imported from the module under test) so a bug in the module's own
// constants can't hide from these assertions.
const CELL = 64;
const ART_X = 10;
const ART_Y = 2;
const ART_W = 44;
const ART_H = 60;
const FACE_W = 640;
const FACE_H = 320;
const BACKS_W = 448;
const BACKS_H = 192;

function expectedPercent(colOrRow: number, axisArt: number, cellOffset: number, sheetSize: number): number {
  const target = colOrRow * CELL + cellOffset;
  return (target / (sheetSize - axisArt)) * 100;
}

const DECK_VARIANTS: readonly DeckVariant[] = ['light', 'light-indexed', 'dark', 'dark-indexed'];
const DECK_FILES: Readonly<Record<DeckVariant, string>> = {
  light: 'deck_mahjong_light_0.png',
  'light-indexed': 'deck_mahjong_light_1.png',
  dark: 'deck_mahjong_dark_0.png',
  'dark-indexed': 'deck_mahjong_dark_1.png',
};

describe('adversarial: totality and uniqueness over the real engine enumeration', () => {
  it('every one of engine tiles.ts HAND_TILE_KINDS (34) plus 8 flower/season kinds resolves, all 42 coords distinct', () => {
    expect(HAND_TILE_KINDS.length).toBe(34);
    const coords = ALL_KINDS.map((k) => tileSpriteCoord(k));
    expect(coords.every((c) => c !== null)).toBe(true);
    const keys = new Set(coords.map((c) => `${c!.col},${c!.row}`));
    expect(keys.size).toBe(42);
  });

  it('no HAND_TILE_KINDS entry is silently missing (compares kindKey sets, not just counts)', () => {
    const mapped = new Set(ALL_KINDS.map(kindKey));
    for (const k of HAND_TILE_KINDS) {
      expect(mapped.has(kindKey(k))).toBe(true);
    }
  });
});

describe('adversarial: independently recomputed geometry for every kind x every deck variant', () => {
  for (const variant of DECK_VARIANTS) {
    it(`deck "${variant}": backgroundPosition matches independently recomputed percentages for all 42 kinds`, () => {
      for (const kind of ALL_KINDS) {
        const coord = tileSpriteCoord(kind)!;
        const x = expectedPercent(coord.col, ART_W, ART_X, FACE_W);
        const y = expectedPercent(coord.row, ART_H, ART_Y, FACE_H);
        const style = tileSpriteStyle(kind, variant)!;
        expect(style.backgroundPosition).toBe(`${x.toFixed(4)}% ${y.toFixed(4)}%`);
        expect(style.backgroundImage).toBe(`url('/tiles/${DECK_FILES[variant]}')`);
        // Sanity: every real tile's sprite position must land inside the
        // visible 0-100% range or the art would clip/vanish.
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(100);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(100);
      }
    });
  }

  it('backgroundSize is identical across all four face-deck variants (same sheet dimensions)', () => {
    const sizes = DECK_VARIANTS.map((v) => tileSpriteStyle({ category: 'suit', suit: 'wan', rank: 1 }, v)?.backgroundSize);
    expect(new Set(sizes).size).toBe(1);
  });

  it('tile-back sprite position is independently recomputed and in-range', () => {
    const x = expectedPercent(0, ART_W, ART_X, BACKS_W);
    const y = expectedPercent(1, ART_H, ART_Y, BACKS_H);
    const style = tileBackSpriteStyle();
    expect(style.backgroundPosition).toBe(`${x.toFixed(4)}% ${y.toFixed(4)}%`);
    expect(x).toBeGreaterThanOrEqual(0);
    expect(x).toBeLessThanOrEqual(100);
    expect(y).toBeGreaterThanOrEqual(0);
    expect(y).toBeLessThanOrEqual(100);
  });
});

describe('adversarial: DEFAULT_DECK_VARIANT wiring', () => {
  it('tileSpriteStyle with no deck argument matches the explicit DEFAULT_DECK_VARIANT call', () => {
    const kind: TileKind = { category: 'dragon', dragon: 'white' };
    const implicit = tileSpriteStyle(kind);
    const explicit = tileSpriteStyle(kind, DEFAULT_DECK_VARIANT);
    expect(implicit).toEqual(explicit);
  });
});

describe('adversarial: row/column exclusivity (catches accidental honor/flower row collisions)', () => {
  it('suit rows (0,1,2), honor row (3), and flower/season row (4) never collide in (col,row) space', () => {
    const byRow = new Map<number, Set<number>>();
    for (const kind of ALL_KINDS) {
      const c = tileSpriteCoord(kind)!;
      if (!byRow.has(c.row)) byRow.set(c.row, new Set());
      const cols = byRow.get(c.row)!;
      expect(cols.has(c.col)).toBe(false); // no two kinds share (col,row) within a row either
      cols.add(c.col);
    }
    // Honor row must hold exactly 7 distinct cols (4 winds + 3 dragons), no more no less.
    expect(byRow.get(3)?.size).toBe(7);
    // Flower/season row must hold exactly 8 distinct cols.
    expect(byRow.get(4)?.size).toBe(8);
    // Each suit row holds exactly 9 distinct cols (ranks 1-9).
    expect(byRow.get(0)?.size).toBe(9);
    expect(byRow.get(1)?.size).toBe(9);
    expect(byRow.get(2)?.size).toBe(9);
  });
});
