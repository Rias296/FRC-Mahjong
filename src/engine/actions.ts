/**
 * Per-action legality checks (discard, chow, pung, the three kong kinds) and
 * the deterministic claim-priority resolver for a single discard.
 * See docs/RULES.md §6.1-6.3.
 *
 * Pure data types + pure functions only. Imports only from ./tiles, ./seats,
 * ./hand.
 *
 * Hand-shape invariants (RULES.md §3.3, mirrors hand.ts's math):
 * - AT-REST shape (a player who has not yet drawn/claimed this turn):
 *   `concealedTiles.length === 16 - 3 * melds.length`. Used by the
 *   claim-eligibility functions (canChow, canPung, canKongFromDiscard), which
 *   evaluate another player's discard against a resting hand.
 * - MUST-ACT shape (a player holding their extra drawn/claimed tile):
 *   `concealedTiles.length === 17 - 3 * melds.length`. Used by the own-turn
 *   functions (isLegalDiscard, canAddedKong, canConcealedKong).
 */

import { HAND_TILE_KINDS, isFlowerTile, kindKey, type SuitName, type Tile, type TileKind } from './tiles';
import type { Seat } from './seats';
import { nextSeat } from './seats';
import type { Meld } from './hand';

export interface PlayerMeld extends Meld {
  /** True only for kongs (暗槓); chow/pung melds are always exposed (false). */
  readonly concealed: boolean;
}

export interface PlayerHand {
  readonly concealedTiles: readonly Tile[];
  readonly melds: readonly PlayerMeld[];
}

export interface ChowOption {
  /** The 2 concealed tiles used to complete the chow, ascending rank. */
  readonly concealedTilesUsed: readonly [Tile, Tile];
  /** kind 'chow', 3 tiles ascending rank, includes the discard. */
  readonly meld: Meld;
}

export type Claim =
  | { readonly type: 'hu'; readonly seat: Seat }
  | { readonly type: 'kong'; readonly seat: Seat }
  | { readonly type: 'pung'; readonly seat: Seat }
  | { readonly type: 'chow'; readonly seat: Seat; readonly option: ChowOption };

type HandShape = 'at-rest' | 'must-act';

/**
 * Shared invariant validator, mirroring hand.ts's throw-on-invariant-violation
 * style. Throws on any structural violation of a PlayerHand.
 */
function assertValidPlayerHand(hand: PlayerHand, shape: HandShape, context: string): void {
  if (hand.concealedTiles.some(isFlowerTile)) {
    throw new Error(`${context}: flower tiles cannot appear in concealedTiles`);
  }

  for (const meld of hand.melds) {
    if (meld.concealed && meld.kind !== 'kong') {
      throw new Error(`${context}: only kong melds may be concealed (got concealed ${meld.kind})`);
    }
    const expectedTileCount = meld.kind === 'kong' ? 4 : 3;
    if (meld.tiles.length !== expectedTileCount) {
      throw new Error(
        `${context}: meld of kind "${meld.kind}" must have ${expectedTileCount} tiles, got ${meld.tiles.length}`,
      );
    }
  }

  const expectedLength = shape === 'at-rest' ? 16 - 3 * hand.melds.length : 17 - 3 * hand.melds.length;
  if (hand.concealedTiles.length !== expectedLength) {
    throw new Error(
      `${context}: expected ${expectedLength} concealed tiles for melds.length=${hand.melds.length} ` +
        `(${shape}), got ${hand.concealedTiles.length}`,
    );
  }
}

function assertNotFlowerDiscard(discardedTile: Tile, context: string): void {
  if (isFlowerTile(discardedTile)) {
    throw new Error(`${context}: discardedTile cannot be a flower`);
  }
}

function countMatching(tiles: readonly Tile[], kind: TileKind): number {
  const key = kindKey(kind);
  return tiles.filter((t) => kindKey(t.kind) === key).length;
}

/** True iff `tile.id` (not just kind) appears in `hand.concealedTiles`. */
export function isLegalDiscard(hand: PlayerHand, tile: Tile): boolean {
  assertValidPlayerHand(hand, 'must-act', 'isLegalDiscard');
  return hand.concealedTiles.some((t) => t.id === tile.id);
}

function findFirstSuitRank(tiles: readonly Tile[], suit: SuitName, rank: number): Tile | undefined {
  return tiles.find((t) => t.kind.category === 'suit' && t.kind.suit === suit && t.kind.rank === rank);
}

function suitRankOf(tile: Tile): number {
  if (tile.kind.category !== 'suit') {
    throw new Error('actions.ts: expected a suit tile');
  }
  return tile.kind.rank;
}

/**
 * All legal chow options against `discardedTile`, claimed by `claimantSeat`
 * from `discarderSeat`. Only the player immediately next in turn order after
 * the discarder may chow (RULES.md §6.1).
 */
export function canChow(
  hand: PlayerHand,
  discardedTile: Tile,
  claimantSeat: Seat,
  discarderSeat: Seat,
): ChowOption[] {
  if (claimantSeat !== nextSeat(discarderSeat)) {
    return [];
  }

  assertValidPlayerHand(hand, 'at-rest', 'canChow');
  assertNotFlowerDiscard(discardedTile, 'canChow');

  const discardKind = discardedTile.kind;
  if (discardKind.category !== 'suit') {
    return [];
  }
  const { suit, rank } = discardKind;

  const windows: Array<readonly [number, number]> = [];
  if (rank - 2 >= 1) {
    windows.push([rank - 2, rank - 1]);
  }
  if (rank - 1 >= 1 && rank + 1 <= 9) {
    windows.push([rank - 1, rank + 1]);
  }
  if (rank + 2 <= 9) {
    windows.push([rank + 1, rank + 2]);
  }

  const options: ChowOption[] = [];
  for (const [lo, hi] of windows) {
    const first = findFirstSuitRank(hand.concealedTiles, suit, lo);
    const second = findFirstSuitRank(hand.concealedTiles, suit, hi);
    if (!first || !second) {
      continue;
    }
    const meldTiles = [first, second, discardedTile].slice().sort((a, b) => suitRankOf(a) - suitRankOf(b));
    options.push({
      concealedTilesUsed: [first, second],
      meld: { kind: 'chow', tiles: meldTiles },
    });
  }

  return options;
}

/** True iff `hand.concealedTiles` has >= 2 tiles matching `discardedTile`'s kind. */
export function canPung(hand: PlayerHand, discardedTile: Tile): boolean {
  assertValidPlayerHand(hand, 'at-rest', 'canPung');
  assertNotFlowerDiscard(discardedTile, 'canPung');
  return countMatching(hand.concealedTiles, discardedTile.kind) >= 2;
}

/** True iff `hand.concealedTiles` has >= 3 tiles matching `discardedTile`'s kind. */
export function canKongFromDiscard(hand: PlayerHand, discardedTile: Tile): boolean {
  assertValidPlayerHand(hand, 'at-rest', 'canKongFromDiscard');
  assertNotFlowerDiscard(discardedTile, 'canKongFromDiscard');
  return countMatching(hand.concealedTiles, discardedTile.kind) >= 3;
}

/**
 * The kind of every exposed pung in `hand.melds` that can be promoted to a
 * kong with a tile currently in `hand.concealedTiles` (加槓). Chows and
 * concealed kongs are never "added onto" and are skipped.
 */
export function canAddedKong(hand: PlayerHand): TileKind[] {
  assertValidPlayerHand(hand, 'must-act', 'canAddedKong');

  const result: TileKind[] = [];
  for (const meld of hand.melds) {
    if (meld.kind !== 'pung' || meld.concealed) {
      continue;
    }
    const pungKind = meld.tiles[0].kind;
    if (countMatching(hand.concealedTiles, pungKind) >= 1) {
      result.push(pungKind);
    }
  }
  return result;
}

/**
 * The kind of every hand-tile kind with exactly 4 concealed copies, eligible
 * for a concealed kong declaration (暗槓). Returned in HAND_TILE_KINDS
 * canonical order.
 */
export function canConcealedKong(hand: PlayerHand): TileKind[] {
  assertValidPlayerHand(hand, 'must-act', 'canConcealedKong');

  const result: TileKind[] = [];
  for (const kind of HAND_TILE_KINDS) {
    if (countMatching(hand.concealedTiles, kind) >= 4) {
      result.push(kind);
    }
  }
  return result;
}

/**
 * Turn-order distance of `seat` from `discarderSeat`, going E->S->W->N
 * (0 = discarderSeat itself, 1..3 = seats reached in turn order thereafter).
 * This is the single shared turn-order-distance rule used both by
 * resolveClaims's proximity tie-break (RULES.md §6.1) and by findRobbers's
 * multiple-robber tie-break (RULES.md §7.2 step 3, in ./rob-kong.ts). Must
 * never be duplicated elsewhere — always import this function.
 */
export function proximity(seat: Seat, discarderSeat: Seat): number {
  return (seat - discarderSeat + 4) % 4;
}

/**
 * Deterministic claim-priority resolution for one discard (RULES.md §6.1).
 * hu > kong/pung (shared priority level) > chow; ties within a level resolve
 * by proximity to the discarder (nearest in E->S->W->N order wins). Multiple
 * simultaneous hu claims are all returned, sorted nearest-first. Does not
 * mutate `claims`.
 */
export function resolveClaims(claims: readonly Claim[], discarderSeat: Seat): Claim[] {
  for (const claim of claims) {
    if (claim.seat === discarderSeat) {
      throw new Error('resolveClaims: a claim cannot come from the discarder\'s seat');
    }
  }

  const seenSeats = new Set<Seat>();
  for (const claim of claims) {
    if (seenSeats.has(claim.seat)) {
      throw new Error(`resolveClaims: multiple claims from the same seat (${claim.seat})`);
    }
    seenSeats.add(claim.seat);
  }

  const byProximity = (a: Claim, b: Claim): number => proximity(a.seat, discarderSeat) - proximity(b.seat, discarderSeat);

  const huClaims = claims.filter((c) => c.type === 'hu');
  if (huClaims.length > 0) {
    return [...huClaims].sort(byProximity);
  }

  const kongOrPungClaims = claims.filter((c) => c.type === 'kong' || c.type === 'pung');
  if (kongOrPungClaims.length > 0) {
    return [[...kongOrPungClaims].sort(byProximity)[0]];
  }

  const chowClaims = claims.filter((c) => c.type === 'chow');
  if (chowClaims.length > 0) {
    return [[...chowClaims].sort(byProximity)[0]];
  }

  return [];
}
