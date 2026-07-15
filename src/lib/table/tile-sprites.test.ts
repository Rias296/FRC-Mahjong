import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DECK_VARIANT,
  TILE_ART_MODE,
  tileBackSpriteStyle,
  tileSpriteCoord,
  tileSpriteStyle,
  type DeckVariant,
  type SpriteCoord,
} from './tile-sprites';
import { HAND_TILE_KINDS, kindKey, type TileKind } from '../../engine/tiles';

const FLOWER_SEASON_KINDS: readonly TileKind[] = [
  { category: 'flower', series: 'flower', number: 1 },
  { category: 'flower', series: 'flower', number: 2 },
  { category: 'flower', series: 'flower', number: 3 },
  { category: 'flower', series: 'flower', number: 4 },
  { category: 'flower', series: 'season', number: 1 },
  { category: 'flower', series: 'season', number: 2 },
  { category: 'flower', series: 'season', number: 3 },
  { category: 'flower', series: 'season', number: 4 },
];

const ALL_KINDS: readonly TileKind[] = [...HAND_TILE_KINDS, ...FLOWER_SEASON_KINDS];

const DECK_VARIANT_FILES: Readonly<Record<DeckVariant, string>> = {
  light: 'deck_mahjong_light_0.png',
  'light-indexed': 'deck_mahjong_light_1.png',
  dark: 'deck_mahjong_dark_0.png',
  'dark-indexed': 'deck_mahjong_dark_1.png',
};

describe('TILE_ART_MODE / DEFAULT_DECK_VARIANT', () => {
  it('defaults to sprite mode and the light-indexed deck', () => {
    expect(TILE_ART_MODE).toBe('sprite');
    expect(DEFAULT_DECK_VARIANT).toBe('light-indexed');
  });
});

describe('tileSpriteCoord', () => {
  it('resolves a non-null coordinate for all 42 tile kinds', () => {
    for (const kind of ALL_KINDS) {
      expect(tileSpriteCoord(kind)).not.toBeNull();
    }
  });

  it('the coordinate map has exactly 42 entries with no two kinds sharing a coordinate', () => {
    expect(ALL_KINDS.length).toBe(42);
    const coordKeys = new Set<string>();
    for (const kind of ALL_KINDS) {
      const coord = tileSpriteCoord(kind) as SpriteCoord;
      coordKeys.add(`${coord.col},${coord.row}`);
    }
    expect(coordKeys.size).toBe(42);
  });

  it('all face coordinates fall within the 10x5 grid', () => {
    for (const kind of ALL_KINDS) {
      const coord = tileSpriteCoord(kind) as SpriteCoord;
      expect(coord.col).toBeGreaterThanOrEqual(0);
      expect(coord.col).toBeLessThan(10);
      expect(coord.row).toBeGreaterThanOrEqual(0);
      expect(coord.row).toBeLessThan(5);
    }
  });

  it('spot checks match the documented coordinate map', () => {
    expect(tileSpriteCoord({ category: 'suit', suit: 'wan', rank: 1 })).toEqual({ col: 0, row: 2 });
    expect(tileSpriteCoord({ category: 'suit', suit: 'tong', rank: 9 })).toEqual({ col: 8, row: 0 });
    expect(tileSpriteCoord({ category: 'suit', suit: 'tiao', rank: 1 })).toEqual({ col: 0, row: 1 });
    expect(tileSpriteCoord({ category: 'wind', wind: 'east' })).toEqual({ col: 0, row: 3 });
    expect(tileSpriteCoord({ category: 'dragon', dragon: 'red' })).toEqual({ col: 4, row: 3 });
    expect(tileSpriteCoord({ category: 'flower', series: 'season', number: 1 })).toEqual({ col: 0, row: 4 });
    expect(tileSpriteCoord({ category: 'flower', series: 'flower', number: 1 })).toEqual({ col: 4, row: 4 });
  });

  it('returns null for an unknown/invalid kind (defensive fallback only)', () => {
    const bogus = { category: 'not-a-real-category' } as unknown as TileKind;
    expect(tileSpriteCoord(bogus)).toBeNull();
  });
});

describe('tileSpriteStyle', () => {
  it('produces the exact CSS values for wan-1 on the default deck', () => {
    const style = tileSpriteStyle({ category: 'suit', suit: 'wan', rank: 1 });
    expect(style).toEqual({
      backgroundImage: "url('/tiles/deck_mahjong_light_1.png')",
      backgroundSize: '1454.5455% 533.3333%',
      backgroundPosition: '1.6779% 50.0000%',
    });
  });

  it('produces the exact CSS values for tong-9 on the default deck', () => {
    const style = tileSpriteStyle({ category: 'suit', suit: 'tong', rank: 9 });
    expect(style).toEqual({
      backgroundImage: "url('/tiles/deck_mahjong_light_1.png')",
      backgroundSize: '1454.5455% 533.3333%',
      backgroundPosition: '87.5839% 0.7692%',
    });
  });

  it('selects the correct file per deck variant', () => {
    for (const [variant, filename] of Object.entries(DECK_VARIANT_FILES) as Array<[DeckVariant, string]>) {
      const style = tileSpriteStyle({ category: 'suit', suit: 'wan', rank: 1 }, variant);
      expect(style?.backgroundImage).toBe(`url('/tiles/${filename}')`);
    }
  });

  it('returns null when tileSpriteCoord returns null for the given kind', () => {
    const bogus = { category: 'not-a-real-category' } as unknown as TileKind;
    expect(tileSpriteStyle(bogus)).toBeNull();
  });
});

describe('tileBackSpriteStyle', () => {
  it('targets the backs sheet with the correct size/position for its cell', () => {
    expect(tileBackSpriteStyle()).toEqual({
      backgroundImage: "url('/tiles/deck_mahjong_backs.png')",
      backgroundSize: '1018.1818% 320.0000%',
      backgroundPosition: '2.4752% 50.0000%',
    });
  });
});

describe('sprite sheet files on disk', () => {
  const publicDir = join(process.cwd(), 'public');

  it('every deck variant file exists', () => {
    for (const filename of Object.values(DECK_VARIANT_FILES)) {
      expect(existsSync(join(publicDir, 'tiles', filename))).toBe(true);
    }
  });

  it('the backs sheet file exists', () => {
    expect(existsSync(join(publicDir, 'tiles', 'deck_mahjong_backs.png'))).toBe(true);
  });
});

// Guards against a stray import mismatch between this test file and the
// module under test (kindKey is used here only to double-check ALL_KINDS
// covers the engine's own canonical hand-kind ordering, not to duplicate
// tile-sprites.ts's internal map).
describe('ALL_KINDS sanity', () => {
  it('has 34 unique hand kinds plus 8 unique flower/season kinds', () => {
    const handKeys = new Set(HAND_TILE_KINDS.map(kindKey));
    expect(handKeys.size).toBe(34);
    const flowerKeys = new Set(FLOWER_SEASON_KINDS.map(kindKey));
    expect(flowerKeys.size).toBe(8);
  });
});
