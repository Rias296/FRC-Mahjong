import type { Tile } from './tiles';
import type { Seat } from './seats';
import { nextSeat } from './seats';
import type { Wall } from './wall';
import { drawFromHead, remaining } from './wall';

export interface DealResult {
  /** Indexed by absolute Seat, each exactly 16 tiles. */
  hands: readonly [Tile[], Tile[], Tile[], Tile[]];
  /** The 80 undealt tiles, order preserved. */
  wall: Wall;
}

/**
 * Deals 4 rounds of 4 tiles from the head, dealer first then turn order.
 * Does not shuffle internally — takes an already-shuffled wall.
 * Throws if remaining(wall) < 64.
 */
export function deal(wall: Wall, dealer: Seat): DealResult {
  if (remaining(wall) < 64) {
    throw new Error('Cannot deal: wall has fewer than 64 tiles remaining');
  }

  const hands: [Tile[], Tile[], Tile[], Tile[]] = [[], [], [], []];
  let currentWall: Wall = wall;

  for (let round = 0; round < 4; round++) {
    let seat = dealer;
    for (let turn = 0; turn < 4; turn++) {
      for (let i = 0; i < 4; i++) {
        const drawn = drawFromHead(currentWall);
        hands[seat].push(drawn.tile);
        currentWall = drawn.wall;
      }
      seat = nextSeat(seat);
    }
  }

  return { hands, wall: currentWall };
}
