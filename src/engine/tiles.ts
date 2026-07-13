/**
 * Tile model for the Taiwan Mahjong engine.
 *
 * Pure data types + pure functions only. See docs/RULES.md §1.
 */

export type SuitName = 'wan' | 'tong' | 'tiao';
export type WindName = 'east' | 'south' | 'west' | 'north';
export type DragonName = 'red' | 'green' | 'white';
export type Rank = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
export type FlowerNumber = 1 | 2 | 3 | 4;

export type TileKind =
  | { category: 'suit'; suit: SuitName; rank: Rank }
  | { category: 'wind'; wind: WindName }
  | { category: 'dragon'; dragon: DragonName }
  | { category: 'flower'; series: 'flower' | 'season'; number: FlowerNumber };

export type TileId = string;

export interface Tile {
  readonly id: TileId;
  readonly kind: TileKind;
}

/**
 * Stable key for a tile kind (ignores copy number).
 * 'wan-5' | 'wind-east' | 'dragon-red' | 'flower-3' | 'season-1'
 */
export function kindKey(kind: TileKind): string {
  switch (kind.category) {
    case 'suit':
      return `${kind.suit}-${kind.rank}`;
    case 'wind':
      return `wind-${kind.wind}`;
    case 'dragon':
      return `dragon-${kind.dragon}`;
    case 'flower':
      return `${kind.series}-${kind.number}`;
  }
}

const SUITS: readonly SuitName[] = ['wan', 'tong', 'tiao'];
const RANKS: readonly Rank[] = [1, 2, 3, 4, 5, 6, 7, 8, 9];
const WINDS: readonly WindName[] = ['east', 'south', 'west', 'north'];
const DRAGONS: readonly DragonName[] = ['red', 'green', 'white'];
const FLOWER_NUMBERS: readonly FlowerNumber[] = [1, 2, 3, 4];

function makeTile(kind: TileKind, copy: number): Tile {
  return { id: `${kindKey(kind)}-${copy}`, kind };
}

/**
 * Generates the full 144-tile set in canonical order:
 * wan 1-9 x4, tong 1-9 x4, tiao 1-9 x4, winds E/S/W/N x4, dragons red/green/white x4,
 * flowers 1-4, seasons 1-4. Inner loop is copies.
 */
export function createTileSet(): Tile[] {
  const tiles: Tile[] = [];

  for (const suit of SUITS) {
    for (const rank of RANKS) {
      for (let copy = 1; copy <= 4; copy++) {
        tiles.push(makeTile({ category: 'suit', suit, rank }, copy));
      }
    }
  }

  for (const wind of WINDS) {
    for (let copy = 1; copy <= 4; copy++) {
      tiles.push(makeTile({ category: 'wind', wind }, copy));
    }
  }

  for (const dragon of DRAGONS) {
    for (let copy = 1; copy <= 4; copy++) {
      tiles.push(makeTile({ category: 'dragon', dragon }, copy));
    }
  }

  for (const number of FLOWER_NUMBERS) {
    tiles.push(makeTile({ category: 'flower', series: 'flower', number }, 1));
  }

  for (const number of FLOWER_NUMBERS) {
    tiles.push(makeTile({ category: 'flower', series: 'season', number }, 1));
  }

  return tiles;
}

export function isFlowerTile(tile: Tile): boolean {
  return tile.kind.category === 'flower';
}

/**
 * The 34 non-flower tile kinds (27 suit + 4 winds + 3 dragons) in canonical
 * order: wan 1-9, tong 1-9, tiao 1-9, winds E/S/W/N, dragons red/green/white.
 * Matches the kind order createTileSet uses for hand tiles.
 */
export const HAND_TILE_KINDS: readonly TileKind[] = [
  ...SUITS.flatMap((suit) => RANKS.map((rank): TileKind => ({ category: 'suit', suit, rank }))),
  ...WINDS.map((wind): TileKind => ({ category: 'wind', wind })),
  ...DRAGONS.map((dragon): TileKind => ({ category: 'dragon', dragon })),
];
