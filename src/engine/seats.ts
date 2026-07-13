/**
 * Seat model. East=0, South=1, West=2, North=3.
 */

export type Seat = 0 | 1 | 2 | 3;

export const SEATS: readonly Seat[] = [0, 1, 2, 3];

export function nextSeat(seat: Seat): Seat {
  return ((seat + 1) % 4) as Seat;
}
