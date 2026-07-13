/**
 * Robbing the kong (搶槓): rob-eligibility detection for the added-kong (加槓)
 * and, when configured, concealed-kong (暗槓) rob windows, plus the
 * promote/revert state transitions that bracket the added-kong rob window.
 * See docs/RULES.md §7.
 *
 * Pure data types + pure functions only. Imports only from ./tiles, ./seats,
 * ./hand, ./actions, ./rules-config.
 */

import { isFlowerTile, kindKey, type Tile } from './tiles';
import { SEATS, type Seat } from './seats';
import { canWin } from './hand';
import { proximity, type PlayerHand, type PlayerMeld } from './actions';
import type { RulesConfig } from './rules-config';

export type KongType = 'added' | 'concealed';

/**
 * The seats (sorted nearest-to-declarer-first, per RULES.md §7.2 step 3 /
 * §6.1's proximity rule) of every opponent who could declare hu on
 * `kongTile`, the tile just used to complete `kongType` kong by
 * `declarerSeat`. Config gates first: returns `[]` immediately if
 * `rules.robKong.enabled` is false, or if `kongType === 'concealed'` and
 * `rules.robKong.robConcealedKong` is false (added kongs are never affected
 * by `robConcealedKong`). Does not mutate any input.
 */
export function findRobbers(
  kongTile: Tile,
  kongType: KongType,
  declarerSeat: Seat,
  opponentHands: Partial<Record<Seat, PlayerHand>>,
  rules: RulesConfig,
): Seat[] {
  if (!rules.robKong.enabled) {
    return [];
  }
  if (kongType === 'concealed' && !rules.robKong.robConcealedKong) {
    return [];
  }

  if (isFlowerTile(kongTile)) {
    throw new Error('findRobbers: kongTile cannot be a flower');
  }

  if (Object.prototype.hasOwnProperty.call(opponentHands, declarerSeat)) {
    throw new Error(`findRobbers: opponentHands must not include the declarer seat (${declarerSeat})`);
  }

  const opponentSeats = SEATS.filter((seat) => seat !== declarerSeat);
  for (const seat of opponentSeats) {
    if (!Object.prototype.hasOwnProperty.call(opponentHands, seat)) {
      throw new Error(`findRobbers: opponentHands is missing seat ${seat}`);
    }
  }

  const eligible: Seat[] = [];
  for (const seat of opponentSeats) {
    const hand = opponentHands[seat] as PlayerHand;
    if (canWin(hand.concealedTiles, hand.melds.length, kongTile)) {
      eligible.push(seat);
    }
  }

  return eligible.sort((a, b) => proximity(a, declarerSeat) - proximity(b, declarerSeat));
}

/**
 * Promotes `hand`'s exposed pung matching `addedTile`'s kind to an exposed
 * kong, moving `addedTile` from concealedTiles into that meld (RULES.md
 * §6.2(2), §7.2). Throws if `addedTile` is not present (by id) in
 * `hand.concealedTiles`, or if no exposed pung of the matching kind exists
 * in `hand.melds`. Does not mutate `hand` or any of its arrays/objects.
 */
export function promoteAddedKong(hand: PlayerHand, addedTile: Tile): PlayerHand {
  const tileIndex = hand.concealedTiles.findIndex((t) => t.id === addedTile.id);
  if (tileIndex === -1) {
    throw new Error(`promoteAddedKong: addedTile (${addedTile.id}) is not in hand.concealedTiles`);
  }

  const addedKey = kindKey(addedTile.kind);
  const meldIndex = hand.melds.findIndex(
    (meld) => meld.kind === 'pung' && !meld.concealed && kindKey(meld.tiles[0].kind) === addedKey,
  );
  if (meldIndex === -1) {
    throw new Error(`promoteAddedKong: no exposed pung of kind "${addedKey}" exists in hand.melds`);
  }

  const originalPung = hand.melds[meldIndex];
  const promotedMeld: PlayerMeld = {
    kind: 'kong',
    concealed: false,
    tiles: [...originalPung.tiles, addedTile],
  };

  const newConcealedTiles = [
    ...hand.concealedTiles.slice(0, tileIndex),
    ...hand.concealedTiles.slice(tileIndex + 1),
  ];
  const newMelds = hand.melds.slice();
  newMelds[meldIndex] = promotedMeld;

  return { concealedTiles: newConcealedTiles, melds: newMelds };
}

/**
 * Reverts `hand`'s exposed kong containing `addedTile` (by id) back to an
 * exposed pung of its other 3 tiles, dropping `addedTile` from the meld
 * (RULES.md §7.2 step 3: a successful rob cancels the kong). `addedTile`
 * does NOT return to `concealedTiles` — it transfers to the robber, entirely
 * the caller's responsibility outside this function. Throws if no exposed
 * (concealed === false) kong meld contains `addedTile`'s id (this also
 * correctly rejects the case where the only matching kong is concealed).
 * Does not mutate `hand` or any of its arrays/objects.
 */
export function revertAddedKong(hand: PlayerHand, addedTile: Tile): PlayerHand {
  const meldIndex = hand.melds.findIndex(
    (meld) => meld.kind === 'kong' && !meld.concealed && meld.tiles.some((t) => t.id === addedTile.id),
  );
  if (meldIndex === -1) {
    throw new Error(
      `revertAddedKong: no exposed kong meld contains addedTile (${addedTile.id})`,
    );
  }

  const originalKong = hand.melds[meldIndex];
  const revertedMeld: PlayerMeld = {
    kind: 'pung',
    concealed: false,
    tiles: originalKong.tiles.filter((t) => t.id !== addedTile.id),
  };

  const newMelds = hand.melds.slice();
  newMelds[meldIndex] = revertedMeld;

  return { concealedTiles: hand.concealedTiles, melds: newMelds };
}
