import type { Tile } from './tiles';

/**
 * The wall is a single ordered array of tiles. Index 0 = head, last index = tail.
 * No reserve enforcement here — deadWallReserve is a caller/hand-flow concern.
 */
export type Wall = readonly Tile[];

export function drawFromHead(wall: Wall): { tile: Tile; wall: Wall } {
  if (wall.length === 0) {
    throw new Error('Cannot draw from an empty wall');
  }
  const tile = wall[0];
  return { tile, wall: wall.slice(1) };
}

export function drawFromTail(wall: Wall): { tile: Tile; wall: Wall } {
  if (wall.length === 0) {
    throw new Error('Cannot draw from an empty wall');
  }
  const tile = wall[wall.length - 1];
  return { tile, wall: wall.slice(0, wall.length - 1) };
}

export function remaining(wall: Wall): number {
  return wall.length;
}
