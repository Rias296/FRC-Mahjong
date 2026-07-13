import type { Tile } from './tiles';
import { createPrng } from './prng';

/**
 * Fisher-Yates shuffle, deterministic from the seed. Does not mutate the input.
 */
export function shuffle(tiles: readonly Tile[], seed: number): Tile[] {
  const result = tiles.slice();
  const random = createPrng(seed);

  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const temp = result[i];
    result[i] = result[j];
    result[j] = temp;
  }

  return result;
}
