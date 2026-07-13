/**
 * GameState: the capstone hand-flow orchestrator for the Taiwan Mahjong
 * engine. Owns turn structure, the claim window, self-draw hu, sacred
 * discard, scoring, hand-end, and dealer-continue. See docs/RULES.md §3-§11.
 *
 * Pure data types + pure functions only. Imports only from ./tiles, ./seats,
 * ./wall, ./shuffle, ./deal, ./hand, ./actions, ./flowers, ./rob-kong (types
 * only), ./scoring, ./rules-config.
 *
 * Covers the full turn/claim flow plus own-turn kongs and the robbing-the-kong
 * window (declare-added-kong, declare-concealed-kong, declare-rob), per
 * docs/RULES.md §6.2-6.3 and §7.
 *
 * Style, matching the rest of src/engine/*: RuleError is returned (never
 * thrown) for any rejected client action; a bare `throw new Error(...)` is
 * reserved for engine-invariant violations that indicate a bug in the state
 * machine itself, never for a legitimately-rejectable player action.
 * applyAction never mutates its input state.
 */

import { kindKey, type Tile, type TileId, type TileKind } from './tiles';
import { nextSeat, SEATS, type Seat } from './seats';
import { drawFromHead, remaining, type Wall } from './wall';
import { shuffle } from './shuffle';
import { createTileSet } from './tiles';
import { deal } from './deal';
import { canWin } from './hand';
import {
  canAddedKong,
  canChow,
  canConcealedKong,
  canKongFromDiscard,
  canPung,
  resolveClaims,
  type Claim,
  type PlayerHand,
  type PlayerMeld,
} from './actions';
import { replaceOneFlower, resolveFlowerChain, resolveInitialDeal } from './flowers';
import { findRobbers, promoteAddedKong, revertAddedKong, type KongType } from './rob-kong';
import {
  computeHandTai,
  computePaymentLegs,
  meetsMinimumTai,
  type PaymentLeg,
  type WinType,
} from './scoring';
import type { RulesConfig } from './rules-config';

// --- Rule errors -----------------------------------------------------------

export type RuleErrorCode =
  | 'wrong-phase'
  | 'wrong-seat'
  | 'hand-is-over'
  | 'already-responded'
  | 'tile-not-in-hand'
  | 'illegal-claim'
  | 'illegal-kong'
  | 'barred-by-sacred-discard'
  | 'below-minimum-tai'
  | 'not-a-winning-hand'
  | 'no-replacement-available';

export interface RuleError {
  readonly type: 'rule-error';
  readonly code: RuleErrorCode;
  readonly message: string;
}

/** Discriminant check on r.type === 'rule-error'. GameState has no 'type' field. */
export function isRuleError(r: GameState | RuleError): r is RuleError {
  return 'type' in r && r.type === 'rule-error';
}

function ruleError(code: RuleErrorCode, message: string): RuleError {
  return { type: 'rule-error', code, message };
}

// --- Player / phase / result types -----------------------------------------

export interface PlayerState {
  readonly hand: PlayerHand; // from ./actions
  readonly flowers: readonly Tile[]; // exposure order
  readonly discards: readonly Tile[]; // this seat's discard row; claimed discards never land here
  readonly barred: boolean; // sacred discard §8
}

export type Phase =
  | { readonly type: 'awaiting-draw' }
  | { readonly type: 'awaiting-discard'; readonly drawnTile: Tile | null }
  | {
      readonly type: 'awaiting-claims';
      readonly discarderSeat: Seat;
      readonly discardedTile: Tile;
      readonly responses: Readonly<Partial<Record<Seat, Claim | 'pass'>>>;
    }
  | {
      readonly type: 'awaiting-rob-kong';
      readonly declarerSeat: Seat;
      readonly kongTile: Tile;
      readonly kongType: KongType;
      readonly pendingConcealedKongTiles: readonly Tile[] | null;
      readonly eligibleRobbers: readonly Seat[];
      readonly responses: Readonly<Partial<Record<Seat, 'rob' | 'pass'>>>;
    }
  | { readonly type: 'hand-over'; readonly result: HandResult };

export interface WinnerResult {
  readonly seat: Seat;
  readonly winType: WinType;
  readonly handTai: number;
  readonly winningTile: Tile;
}

export type HandResult =
  | {
      readonly kind: 'win';
      readonly winners: readonly WinnerResult[];
      readonly legs: readonly PaymentLeg[];
      readonly nextDealerSeat: Seat;
      readonly nextRepeatCount: number;
    }
  | { readonly kind: 'exhaustive-draw'; readonly nextDealerSeat: Seat; readonly nextRepeatCount: number };

export interface GameState {
  readonly seed: number;
  readonly rules: RulesConfig;
  readonly dealerSeat: Seat;
  readonly repeatCount: number;
  readonly wall: Wall;
  readonly players: readonly [PlayerState, PlayerState, PlayerState, PlayerState]; // index = Seat
  readonly currentTurnSeat: Seat;
  readonly phase: Phase;
}

// --- Actions -----------------------------------------------------------------

export type ClaimSpec =
  | { readonly type: 'hu' }
  | { readonly type: 'pung' }
  | { readonly type: 'kong' }
  | { readonly type: 'chow'; readonly tileIds: readonly [TileId, TileId] }; // the 2 concealed tiles used

export type GameAction =
  | { readonly type: 'draw'; readonly seat: Seat }
  | { readonly type: 'discard'; readonly seat: Seat; readonly tileId: TileId }
  | { readonly type: 'declare-hu'; readonly seat: Seat }
  | { readonly type: 'claim'; readonly seat: Seat; readonly claim: ClaimSpec }
  | { readonly type: 'pass'; readonly seat: Seat }
  | { readonly type: 'declare-added-kong'; readonly seat: Seat; readonly tileId: TileId }
  | { readonly type: 'declare-concealed-kong'; readonly seat: Seat; readonly kind: TileKind }
  | { readonly type: 'declare-rob'; readonly seat: Seat };

// --- Small internal immutability helpers ------------------------------------

type Players = readonly [PlayerState, PlayerState, PlayerState, PlayerState];

function replacePlayer(players: Players, seat: Seat, updated: PlayerState): Players {
  const next: [PlayerState, PlayerState, PlayerState, PlayerState] = [...players];
  next[seat] = updated;
  return next;
}

function sameKind(a: Tile, b: Tile): boolean {
  return kindKey(a.kind) === kindKey(b.kind);
}

// --- Dealer-continue helpers (RULES.md §9), reused by every hand-over path --

function computeNextDealerOnDraw(dealer: Seat, rules: RulesConfig): Seat {
  return rules.dealerRepeatsOnDraw ? dealer : nextSeat(dealer);
}

function computeNextRepeatOnDraw(repeatCount: number, rules: RulesConfig): number {
  return rules.dealerRepeatsOnDraw ? repeatCount + 1 : 0;
}

function computeNextDealerOnWin(
  dealer: Seat,
  winnerSeats: readonly Seat[],
  repeatCount: number,
): { nextDealerSeat: Seat; nextRepeatCount: number } {
  if (winnerSeats.includes(dealer)) {
    return { nextDealerSeat: dealer, nextRepeatCount: repeatCount + 1 };
  }
  return { nextDealerSeat: nextSeat(dealer), nextRepeatCount: 0 };
}

// --- startHand / startHandFromWall ------------------------------------------

function buildPlayersFromResolved(resolved: {
  hands: readonly [Tile[], Tile[], Tile[], Tile[]];
  flowers: readonly [Tile[], Tile[], Tile[], Tile[]];
}): Players {
  const build = (seat: Seat): PlayerState => ({
    hand: { concealedTiles: resolved.hands[seat], melds: [] },
    flowers: resolved.flowers[seat],
    discards: [],
    barred: false,
  });
  return [build(0), build(1), build(2), build(3)];
}

function exhaustiveDrawHandOver(dealer: Seat, repeatCount: number, rules: RulesConfig): Phase {
  return {
    type: 'hand-over',
    result: {
      kind: 'exhaustive-draw',
      nextDealerSeat: computeNextDealerOnDraw(dealer, rules),
      nextRepeatCount: computeNextRepeatOnDraw(repeatCount, rules),
    },
  };
}

/**
 * The deterministic test seam for rigging exact wall contents (RULES.md
 * §3.3). Deals, resolves initial flowers, and performs the dealer's opening
 * 17th-tile draw (with flower chaining), producing a fully-formed GameState.
 */
export function startHandFromWall(
  wall: Wall,
  dealer: Seat,
  rules: RulesConfig,
  repeatCount: number,
  seed: number,
): GameState {
  const dealResult = deal(wall, dealer);
  const resolved = resolveInitialDeal(dealResult, dealer, rules);

  if (resolved.exhausted) {
    return {
      seed,
      rules,
      dealerSeat: dealer,
      repeatCount,
      wall: resolved.wall,
      players: buildPlayersFromResolved(resolved),
      currentTurnSeat: dealer,
      phase: exhaustiveDrawHandOver(dealer, repeatCount, rules),
    };
  }

  const playersAfterDeal = buildPlayersFromResolved(resolved);

  // Reserve check: degenerate config may leave no legal opening draw at all.
  if (remaining(resolved.wall) <= rules.deadWallReserve) {
    return {
      seed,
      rules,
      dealerSeat: dealer,
      repeatCount,
      wall: resolved.wall,
      players: playersAfterDeal,
      currentTurnSeat: dealer,
      phase: exhaustiveDrawHandOver(dealer, repeatCount, rules),
    };
  }

  const opening = drawFromHead(resolved.wall);
  const chain = resolveFlowerChain(opening.wall, opening.tile, rules);
  const dealerFlowers = [...playersAfterDeal[dealer].flowers, ...chain.exposedFlowers];

  if (chain.finalTile === null) {
    const players = replacePlayer(playersAfterDeal, dealer, {
      ...playersAfterDeal[dealer],
      flowers: dealerFlowers,
    });
    return {
      seed,
      rules,
      dealerSeat: dealer,
      repeatCount,
      wall: chain.wall,
      players,
      currentTurnSeat: dealer,
      phase: exhaustiveDrawHandOver(dealer, repeatCount, rules),
    };
  }

  const dealerHand = playersAfterDeal[dealer].hand;
  const players = replacePlayer(playersAfterDeal, dealer, {
    ...playersAfterDeal[dealer],
    flowers: dealerFlowers,
    hand: { ...dealerHand, concealedTiles: [...dealerHand.concealedTiles, chain.finalTile] },
  });

  return {
    seed,
    rules,
    dealerSeat: dealer,
    repeatCount,
    wall: chain.wall,
    players,
    currentTurnSeat: dealer,
    phase: { type: 'awaiting-discard', drawnTile: chain.finalTile },
  };
}

/** Fresh hand from a freshly-shuffled 144-tile wall for the given seed. */
export function startHand(dealer: Seat, seed: number, rules: RulesConfig, repeatCount = 0): GameState {
  return startHandFromWall(shuffle(createTileSet(), seed), dealer, rules, repeatCount, seed);
}

// --- applyAction dispatch ----------------------------------------------------

export function applyAction(state: GameState, action: GameAction): GameState | RuleError {
  if (state.phase.type === 'hand-over') {
    return ruleError('hand-is-over', `Cannot apply "${action.type}": the hand has already ended`);
  }

  switch (action.type) {
    case 'draw':
      return handleDraw(state, action);
    case 'discard':
      return handleDiscard(state, action);
    case 'declare-hu':
      return handleDeclareHu(state, action);
    case 'claim':
      return handleClaim(state, action);
    case 'pass':
      return handlePass(state, action);
    case 'declare-added-kong':
      return handleAddedKong(state, action);
    case 'declare-concealed-kong':
      return handleConcealedKong(state, action);
    case 'declare-rob':
      return handleDeclareRob(state, action);
    default: {
      const exhaustiveCheck: never = action;
      throw new Error(`applyAction: unhandled action type ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

// --- draw --------------------------------------------------------------------

function handleDraw(state: GameState, action: Extract<GameAction, { type: 'draw' }>): GameState | RuleError {
  if (state.phase.type !== 'awaiting-draw') {
    return ruleError('wrong-phase', 'draw is only legal in the awaiting-draw phase');
  }
  if (action.seat !== state.currentTurnSeat) {
    return ruleError('wrong-seat', `Seat ${action.seat} cannot draw; it is seat ${state.currentTurnSeat}'s turn`);
  }
  if (remaining(state.wall) <= state.rules.deadWallReserve) {
    // Engine-bug guard: the discard/claim-window-close handlers must never
    // hand control back to awaiting-draw when the wall is already at/under
    // the reserve. Reaching this means the state machine itself is broken.
    throw new Error('handleDraw: entered awaiting-draw with wall at or under the reserve');
  }

  const seat = action.seat;
  const player = state.players[seat];
  const drawResult = drawFromHead(state.wall);
  const chain = resolveFlowerChain(drawResult.wall, drawResult.tile, state.rules);
  const flowers = [...player.flowers, ...chain.exposedFlowers];

  if (chain.finalTile === null) {
    const players = replacePlayer(state.players, seat, { ...player, flowers });
    return {
      ...state,
      wall: chain.wall,
      players,
      phase: exhaustiveDrawHandOver(state.dealerSeat, state.repeatCount, state.rules),
    };
  }

  const players = replacePlayer(state.players, seat, {
    ...player,
    flowers,
    hand: { ...player.hand, concealedTiles: [...player.hand.concealedTiles, chain.finalTile] },
  });

  return {
    ...state,
    wall: chain.wall,
    players,
    phase: { type: 'awaiting-discard', drawnTile: chain.finalTile },
  };
}

// --- declare-hu (self-draw) ---------------------------------------------------

function handleDeclareHu(
  state: GameState,
  action: Extract<GameAction, { type: 'declare-hu' }>,
): GameState | RuleError {
  if (state.phase.type !== 'awaiting-discard') {
    return ruleError('wrong-phase', 'declare-hu is only legal in the awaiting-discard phase');
  }
  if (action.seat !== state.currentTurnSeat) {
    return ruleError(
      'wrong-seat',
      `Seat ${action.seat} cannot declare hu; it is seat ${state.currentTurnSeat}'s turn`,
    );
  }

  const drawnTile = state.phase.drawnTile;
  if (drawnTile === null) {
    return ruleError('not-a-winning-hand', 'No self-draw hu is possible after a chow/pung claim this turn');
  }

  const seat = action.seat;
  const player = state.players[seat];
  const concealedWithoutDrawn = player.hand.concealedTiles.filter((t) => t.id !== drawnTile.id);

  if (!canWin(concealedWithoutDrawn, player.hand.melds.length, drawnTile)) {
    return ruleError('not-a-winning-hand', `Seat ${seat}'s hand does not form a winning shape with ${drawnTile.id}`);
  }

  const handTai = computeHandTai({ winType: 'self-draw' }, state.rules);
  if (!meetsMinimumTai(handTai, state.rules)) {
    return ruleError('below-minimum-tai', `handTai ${handTai} is below minTaiToWin ${state.rules.minTaiToWin}`);
  }

  const payerSeats = SEATS.filter((s) => s !== seat);
  const legs = computePaymentLegs({
    winnerSeat: seat,
    winType: 'self-draw',
    payerSeats,
    handTai,
    dealerSeat: state.dealerSeat,
    repeatCount: state.repeatCount,
    rules: state.rules,
  });
  const { nextDealerSeat, nextRepeatCount } = computeNextDealerOnWin(state.dealerSeat, [seat], state.repeatCount);

  const players = replacePlayer(state.players, seat, {
    ...player,
    hand: { ...player.hand, concealedTiles: concealedWithoutDrawn },
  });

  return {
    ...state,
    players,
    phase: {
      type: 'hand-over',
      result: {
        kind: 'win',
        winners: [{ seat, winType: 'self-draw', handTai, winningTile: drawnTile }],
        legs,
        nextDealerSeat,
        nextRepeatCount,
      },
    },
  };
}

// --- discard -------------------------------------------------------------------

function handleDiscard(
  state: GameState,
  action: Extract<GameAction, { type: 'discard' }>,
): GameState | RuleError {
  if (state.phase.type !== 'awaiting-discard') {
    return ruleError('wrong-phase', 'discard is only legal in the awaiting-discard phase');
  }
  if (action.seat !== state.currentTurnSeat) {
    return ruleError(
      'wrong-seat',
      `Seat ${action.seat} cannot discard; it is seat ${state.currentTurnSeat}'s turn`,
    );
  }

  const seat = action.seat;
  const player = state.players[seat];
  const tileIndex = player.hand.concealedTiles.findIndex((t) => t.id === action.tileId);
  if (tileIndex === -1) {
    return ruleError('tile-not-in-hand', `Tile ${action.tileId} is not in seat ${seat}'s concealed hand`);
  }

  const discardedTile = player.hand.concealedTiles[tileIndex];
  const newConcealed = [
    ...player.hand.concealedTiles.slice(0, tileIndex),
    ...player.hand.concealedTiles.slice(tileIndex + 1),
  ];
  const clearsOwnBar = state.rules.sacredDiscard.scope === 'until-next-self-discard';

  const players = replacePlayer(state.players, seat, {
    ...player,
    hand: { ...player.hand, concealedTiles: newConcealed },
    barred: clearsOwnBar ? false : player.barred,
  });

  return {
    ...state,
    players,
    phase: { type: 'awaiting-claims', discarderSeat: seat, discardedTile, responses: {} },
  };
}

// --- claim / pass + claim-window resolution ------------------------------------

function handleClaim(state: GameState, action: Extract<GameAction, { type: 'claim' }>): GameState | RuleError {
  if (state.phase.type !== 'awaiting-claims') {
    return ruleError('wrong-phase', 'claim is only legal in the awaiting-claims phase');
  }
  const phase = state.phase;
  const seat = action.seat;

  if (seat === phase.discarderSeat) {
    return ruleError('wrong-seat', `Seat ${seat} is the discarder and cannot claim their own discard`);
  }
  if (phase.responses[seat] !== undefined) {
    return ruleError('already-responded', `Seat ${seat} has already responded in this claim window`);
  }

  const discardedTile = phase.discardedTile;
  const hand = state.players[seat].hand;
  let validatedClaim: Claim;

  switch (action.claim.type) {
    case 'hu': {
      if (state.players[seat].barred) {
        return ruleError('barred-by-sacred-discard', `Seat ${seat} is barred from winning by sacred discard`);
      }
      if (!canWin(hand.concealedTiles, hand.melds.length, discardedTile)) {
        return ruleError('not-a-winning-hand', `Seat ${seat}'s hand does not win on ${discardedTile.id}`);
      }
      const handTai = computeHandTai({ winType: 'discard' }, state.rules);
      if (!meetsMinimumTai(handTai, state.rules)) {
        return ruleError('below-minimum-tai', `handTai ${handTai} is below minTaiToWin ${state.rules.minTaiToWin}`);
      }
      validatedClaim = { type: 'hu', seat };
      break;
    }
    case 'pung': {
      if (!canPung(hand, discardedTile)) {
        return ruleError('illegal-claim', `Seat ${seat} cannot pung ${discardedTile.id}`);
      }
      validatedClaim = { type: 'pung', seat };
      break;
    }
    case 'kong': {
      if (!canKongFromDiscard(hand, discardedTile)) {
        return ruleError('illegal-claim', `Seat ${seat} cannot kong ${discardedTile.id}`);
      }
      if (remaining(state.wall) <= state.rules.deadWallReserve) {
        return ruleError('no-replacement-available', 'No legal tail replacement draw remains for this kong');
      }
      validatedClaim = { type: 'kong', seat };
      break;
    }
    case 'chow': {
      if (seat !== nextSeat(phase.discarderSeat)) {
        return ruleError('illegal-claim', `Only seat ${nextSeat(phase.discarderSeat)} may chow this discard`);
      }
      const options = canChow(hand, discardedTile, seat, phase.discarderSeat);
      const [idA, idB] = action.claim.tileIds;
      const matched = options.find((opt) => {
        const usedIds = opt.concealedTilesUsed.map((t) => t.id);
        return (usedIds[0] === idA && usedIds[1] === idB) || (usedIds[0] === idB && usedIds[1] === idA);
      });
      if (!matched) {
        return ruleError('illegal-claim', `Seat ${seat} has no chow option matching tiles ${idA}, ${idB}`);
      }
      validatedClaim = { type: 'chow', seat, option: matched };
      break;
    }
  }

  const newResponses: Partial<Record<Seat, Claim | 'pass'>> = { ...phase.responses, [seat]: validatedClaim };
  const stateWithResponse: GameState = { ...state, phase: { ...phase, responses: newResponses } };

  if (Object.keys(newResponses).length < 3) {
    return stateWithResponse;
  }
  return resolveClaimWindow(stateWithResponse, phase.discarderSeat, discardedTile, newResponses);
}

function handlePass(state: GameState, action: Extract<GameAction, { type: 'pass' }>): GameState | RuleError {
  if (state.phase.type === 'awaiting-rob-kong') {
    return handleRobKongResponse(state, state.phase, action.seat, 'pass');
  }

  if (state.phase.type !== 'awaiting-claims') {
    return ruleError('wrong-phase', 'pass is only legal in the awaiting-claims phase');
  }
  const phase = state.phase;
  const seat = action.seat;

  if (seat === phase.discarderSeat) {
    return ruleError('wrong-seat', `Seat ${seat} is the discarder and cannot pass in their own claim window`);
  }
  if (phase.responses[seat] !== undefined) {
    return ruleError('already-responded', `Seat ${seat} has already responded in this claim window`);
  }

  const newResponses: Partial<Record<Seat, Claim | 'pass'>> = { ...phase.responses, [seat]: 'pass' };
  const stateWithResponse: GameState = { ...state, phase: { ...phase, responses: newResponses } };

  if (Object.keys(newResponses).length < 3) {
    return stateWithResponse;
  }
  return resolveClaimWindow(stateWithResponse, phase.discarderSeat, phase.discardedTile, newResponses);
}

/**
 * Applies sacred-discard bars (RULES.md §8) to every non-discarder seat who
 * is not already barred, could have won on `discardedTile`, and meets
 * minTaiToWin. This applies uniformly to every non-discarder seat, INCLUDING
 * the seat whose non-hu claim (pung/kong/chow) wins the window: winning a
 * claim other than hu on a tile they could have declared hu on is exactly
 * the "could have declared hu ... and did not" case §8 bars, regardless of
 * whether their alternate claim happens to execute. No-op entirely when
 * `rules.sacredDiscard.enabled` is false.
 */
function applySacredDiscardBars(
  players: Players,
  nonDiscarderSeats: readonly Seat[],
  discardedTile: Tile,
  rules: RulesConfig,
): Players {
  if (!rules.sacredDiscard.enabled) {
    return players;
  }

  let result = players;
  const handTai = computeHandTai({ winType: 'discard' }, rules);
  for (const seat of nonDiscarderSeats) {
    const player = result[seat];
    if (player.barred) continue;
    const couldHaveWon =
      canWin(player.hand.concealedTiles, player.hand.melds.length, discardedTile) && meetsMinimumTai(handTai, rules);
    if (couldHaveWon) {
      result = replacePlayer(result, seat, { ...player, barred: true });
    }
  }
  return result;
}

function resolveClaimWindow(
  state: GameState,
  discarderSeat: Seat,
  discardedTile: Tile,
  responses: Readonly<Partial<Record<Seat, Claim | 'pass'>>>,
): GameState {
  const values = Object.values(responses) as ReadonlyArray<Claim | 'pass' | undefined>;
  const claims = values.filter((r): r is Claim => r !== undefined && r !== 'pass');

  if (claims.length === 0) {
    return resolveNoClaims(state, discarderSeat, discardedTile);
  }

  const resolved = resolveClaims(claims, discarderSeat);
  const winning = resolved[0];

  if (winning.type === 'hu') {
    return resolveHuClaims(state, discarderSeat, discardedTile, resolved);
  }

  return resolveNonHuClaim(state, discarderSeat, discardedTile, winning);
}

function resolveHuClaims(
  state: GameState,
  discarderSeat: Seat,
  discardedTile: Tile,
  resolvedHuClaims: readonly Claim[],
): GameState {
  const honored = state.rules.multipleWinners ? resolvedHuClaims : [resolvedHuClaims[0]];
  const handTai = computeHandTai({ winType: 'discard' }, state.rules);

  const winners: WinnerResult[] = honored.map((claim) => ({
    seat: claim.seat,
    winType: 'discard',
    handTai,
    winningTile: discardedTile,
  }));

  const legs: PaymentLeg[] = winners.flatMap((w) =>
    computePaymentLegs({
      winnerSeat: w.seat,
      winType: 'discard',
      payerSeats: [discarderSeat],
      handTai: w.handTai,
      dealerSeat: state.dealerSeat,
      repeatCount: state.repeatCount,
      rules: state.rules,
    }),
  );

  const { nextDealerSeat, nextRepeatCount } = computeNextDealerOnWin(
    state.dealerSeat,
    winners.map((w) => w.seat),
    state.repeatCount,
  );

  return {
    ...state,
    phase: {
      type: 'hand-over',
      result: { kind: 'win', winners, legs, nextDealerSeat, nextRepeatCount },
    },
  };
}

function resolveNonHuClaim(
  state: GameState,
  discarderSeat: Seat,
  discardedTile: Tile,
  claim: Claim,
  // Sub-plan A: claim.type here is 'pung' | 'kong' | 'chow' (resolveClaims's
  // contract guarantees this branch never receives a 'hu' claim).
): GameState {
  const nonDiscarderSeats = SEATS.filter((s) => s !== discarderSeat);
  const barredPlayers = applySacredDiscardBars(state.players, nonDiscarderSeats, discardedTile, state.rules);

  const claimantSeat = claim.seat;
  const claimant = barredPlayers[claimantSeat];

  if (claim.type === 'pung') {
    const matches = claimant.hand.concealedTiles.filter((t) => sameKind(t, discardedTile));
    if (matches.length < 2) {
      throw new Error('resolveNonHuClaim: validated pung claim without 2 matching concealed tiles');
    }
    const used = matches.slice(0, 2);
    const usedIds = new Set(used.map((t) => t.id));
    const remainingConcealed = claimant.hand.concealedTiles.filter((t) => !usedIds.has(t.id));
    const newMeld: PlayerMeld = { kind: 'pung', concealed: false, tiles: [discardedTile, ...used] };

    const players = replacePlayer(barredPlayers, claimantSeat, {
      ...claimant,
      hand: { concealedTiles: remainingConcealed, melds: [...claimant.hand.melds, newMeld] },
    });

    return {
      ...state,
      players,
      currentTurnSeat: claimantSeat,
      phase: { type: 'awaiting-discard', drawnTile: null },
    };
  }

  if (claim.type === 'chow') {
    const usedIds = new Set(claim.option.concealedTilesUsed.map((t) => t.id));
    const remainingConcealed = claimant.hand.concealedTiles.filter((t) => !usedIds.has(t.id));
    const newMeld: PlayerMeld = { kind: 'chow', concealed: false, tiles: claim.option.meld.tiles };

    const players = replacePlayer(barredPlayers, claimantSeat, {
      ...claimant,
      hand: { concealedTiles: remainingConcealed, melds: [...claimant.hand.melds, newMeld] },
    });

    return {
      ...state,
      players,
      currentTurnSeat: claimantSeat,
      phase: { type: 'awaiting-discard', drawnTile: null },
    };
  }

  // kong-from-discard (明槓)
  const matches = claimant.hand.concealedTiles.filter((t) => sameKind(t, discardedTile));
  if (matches.length < 3) {
    throw new Error('resolveNonHuClaim: validated kong claim without 3 matching concealed tiles');
  }
  const used = matches.slice(0, 3);
  const usedIds = new Set(used.map((t) => t.id));
  const remainingConcealed = claimant.hand.concealedTiles.filter((t) => !usedIds.has(t.id));
  const newMeld: PlayerMeld = { kind: 'kong', concealed: false, tiles: [discardedTile, ...used] };
  const claimantAfterKong: PlayerState = {
    ...claimant,
    hand: { concealedTiles: remainingConcealed, melds: [...claimant.hand.melds, newMeld] },
  };
  const playersAfterKong = replacePlayer(barredPlayers, claimantSeat, claimantAfterKong);

  return kongReplacementDraw({ ...state, players: playersAfterKong }, claimantSeat);
}

function resolveNoClaims(state: GameState, discarderSeat: Seat, discardedTile: Tile): GameState {
  const nonDiscarderSeats = SEATS.filter((s) => s !== discarderSeat);
  const barredPlayers = applySacredDiscardBars(state.players, nonDiscarderSeats, discardedTile, state.rules);

  const discarder = barredPlayers[discarderSeat];
  const players = replacePlayer(barredPlayers, discarderSeat, {
    ...discarder,
    discards: [...discarder.discards, discardedTile],
  });

  if (remaining(state.wall) <= state.rules.deadWallReserve) {
    return {
      ...state,
      players,
      phase: exhaustiveDrawHandOver(state.dealerSeat, state.repeatCount, state.rules),
    };
  }

  return {
    ...state,
    players,
    currentTurnSeat: nextSeat(discarderSeat),
    phase: { type: 'awaiting-draw' },
  };
}

// --- Own-turn kong actions + rob-the-kong flow (RULES.md §6.2-6.3, §7) -------

/**
 * From a set of rob-eligible candidate seats (already proximity-sorted by
 * findRobbers), keeps only seats that are not currently barred by sacred
 * discard and whose robbed-kong win would meet minTaiToWin. Preserves the
 * input order.
 */
function filterEligibleRobbers(candidates: readonly Seat[], players: Players, rules: RulesConfig): Seat[] {
  const robKongHandTai = computeHandTai({ winType: 'robbed-kong' }, rules);
  const meetsMin = meetsMinimumTai(robKongHandTai, rules);
  return candidates.filter((seat) => !players[seat].barred && meetsMin);
}

/**
 * The shared kong-replacement-draw tail (RULES.md §6.2/§6.3): draws one tile
 * from the tail (with flower chaining) for `seat`, whose kong is already
 * committed to `state`. Reserve legality must already have been checked by
 * the caller before the kong was declared — this never itself rejects.
 */
function kongReplacementDraw(state: GameState, seat: Seat): GameState {
  const player = state.players[seat];
  const replacement = replaceOneFlower(state.wall, state.rules);
  const flowers = [...player.flowers, ...replacement.chainedFlowers];

  if (replacement.tile === null) {
    const players = replacePlayer(state.players, seat, { ...player, flowers });
    return {
      ...state,
      wall: replacement.wall,
      players,
      phase: exhaustiveDrawHandOver(state.dealerSeat, state.repeatCount, state.rules),
    };
  }

  const players = replacePlayer(state.players, seat, {
    ...player,
    flowers,
    hand: { ...player.hand, concealedTiles: [...player.hand.concealedTiles, replacement.tile] },
  });

  return {
    ...state,
    wall: replacement.wall,
    players,
    currentTurnSeat: seat,
    phase: { type: 'awaiting-discard', drawnTile: replacement.tile },
  };
}

function buildOpponentHandsMap(players: Players, declarerSeat: Seat): Partial<Record<Seat, PlayerHand>> {
  const opponentHands: Partial<Record<Seat, PlayerHand>> = {};
  for (const seat of SEATS) {
    if (seat !== declarerSeat) {
      opponentHands[seat] = players[seat].hand;
    }
  }
  return opponentHands;
}

function handleAddedKong(
  state: GameState,
  action: Extract<GameAction, { type: 'declare-added-kong' }>,
): GameState | RuleError {
  if (state.phase.type !== 'awaiting-discard') {
    return ruleError('wrong-phase', 'declare-added-kong is only legal in the awaiting-discard phase');
  }
  if (action.seat !== state.currentTurnSeat) {
    return ruleError(
      'wrong-seat',
      `Seat ${action.seat} cannot declare a kong; it is seat ${state.currentTurnSeat}'s turn`,
    );
  }

  const seat = action.seat;
  const player = state.players[seat];
  const theTile = player.hand.concealedTiles.find((t) => t.id === action.tileId);
  if (theTile === undefined) {
    return ruleError('tile-not-in-hand', `Tile ${action.tileId} is not in seat ${seat}'s concealed hand`);
  }

  const eligibleKinds = canAddedKong(player.hand);
  if (!eligibleKinds.some((k) => kindKey(k) === kindKey(theTile.kind))) {
    return ruleError('illegal-kong', `Seat ${seat} cannot add-kong tile ${theTile.id}`);
  }

  if (remaining(state.wall) <= state.rules.deadWallReserve) {
    return ruleError('no-replacement-available', 'No legal tail replacement draw remains for this kong');
  }

  const promotedHand = promoteAddedKong(player.hand, theTile);
  const playersAfterPromotion = replacePlayer(state.players, seat, { ...player, hand: promotedHand });
  const stateAfterPromotion: GameState = { ...state, players: playersAfterPromotion };

  const opponentHands = buildOpponentHandsMap(playersAfterPromotion, seat);
  const robbers = findRobbers(theTile, 'added', seat, opponentHands, state.rules);
  const eligibleRobbers = filterEligibleRobbers(robbers, playersAfterPromotion, state.rules);

  if (eligibleRobbers.length === 0) {
    return kongReplacementDraw(stateAfterPromotion, seat);
  }

  return {
    ...stateAfterPromotion,
    phase: {
      type: 'awaiting-rob-kong',
      declarerSeat: seat,
      kongTile: theTile,
      kongType: 'added',
      pendingConcealedKongTiles: null,
      eligibleRobbers,
      responses: {},
    },
  };
}

function handleConcealedKong(
  state: GameState,
  action: Extract<GameAction, { type: 'declare-concealed-kong' }>,
): GameState | RuleError {
  if (state.phase.type !== 'awaiting-discard') {
    return ruleError('wrong-phase', 'declare-concealed-kong is only legal in the awaiting-discard phase');
  }
  if (action.seat !== state.currentTurnSeat) {
    return ruleError(
      'wrong-seat',
      `Seat ${action.seat} cannot declare a kong; it is seat ${state.currentTurnSeat}'s turn`,
    );
  }

  const seat = action.seat;
  const player = state.players[seat];

  const eligibleKinds = canConcealedKong(player.hand);
  if (!eligibleKinds.some((k) => kindKey(k) === kindKey(action.kind))) {
    return ruleError('illegal-kong', `Seat ${seat} cannot concealed-kong kind ${kindKey(action.kind)}`);
  }

  if (remaining(state.wall) <= state.rules.deadWallReserve) {
    return ruleError('no-replacement-available', 'No legal tail replacement draw remains for this kong');
  }

  const matching = player.hand.concealedTiles.filter((t) => kindKey(t.kind) === kindKey(action.kind));
  const pendingConcealedKongTiles = matching.slice(0, 4);

  const opponentHands = buildOpponentHandsMap(state.players, seat);
  const robbers = findRobbers(pendingConcealedKongTiles[0], 'concealed', seat, opponentHands, state.rules);
  const eligibleRobbers = filterEligibleRobbers(robbers, state.players, state.rules);

  if (eligibleRobbers.length === 0) {
    const pendingIds = new Set(pendingConcealedKongTiles.map((t) => t.id));
    const remainingConcealed = player.hand.concealedTiles.filter((t) => !pendingIds.has(t.id));
    const newMeld: PlayerMeld = { kind: 'kong', concealed: true, tiles: pendingConcealedKongTiles };
    const updatedPlayer: PlayerState = {
      ...player,
      hand: { concealedTiles: remainingConcealed, melds: [...player.hand.melds, newMeld] },
    };
    const playersAfterKong = replacePlayer(state.players, seat, updatedPlayer);
    return kongReplacementDraw({ ...state, players: playersAfterKong }, seat);
  }

  return {
    ...state,
    phase: {
      type: 'awaiting-rob-kong',
      declarerSeat: seat,
      kongTile: pendingConcealedKongTiles[0],
      kongType: 'concealed',
      pendingConcealedKongTiles,
      eligibleRobbers,
      responses: {},
    },
  };
}

// --- awaiting-rob-kong: declare-rob / pass + window resolution --------------

function handleRobKongResponse(
  state: GameState,
  phase: Extract<Phase, { type: 'awaiting-rob-kong' }>,
  seat: Seat,
  response: 'rob' | 'pass',
): GameState | RuleError {
  if (!phase.eligibleRobbers.includes(seat)) {
    return ruleError('wrong-seat', `Seat ${seat} is not eligible to respond to this rob window`);
  }
  if (phase.responses[seat] !== undefined) {
    return ruleError('already-responded', `Seat ${seat} has already responded in this rob window`);
  }

  const newResponses: Partial<Record<Seat, 'rob' | 'pass'>> = { ...phase.responses, [seat]: response };
  const stateWithResponse: GameState = { ...state, phase: { ...phase, responses: newResponses } };

  if (Object.keys(newResponses).length < phase.eligibleRobbers.length) {
    return stateWithResponse;
  }
  return resolveRobKongWindow(stateWithResponse, phase, newResponses);
}

function handleDeclareRob(
  state: GameState,
  action: Extract<GameAction, { type: 'declare-rob' }>,
): GameState | RuleError {
  if (state.phase.type !== 'awaiting-rob-kong') {
    return ruleError('wrong-phase', 'declare-rob is only legal in the awaiting-rob-kong phase');
  }
  return handleRobKongResponse(state, state.phase, action.seat, 'rob');
}

function resolveRobKongWindow(
  state: GameState,
  phase: Extract<Phase, { type: 'awaiting-rob-kong' }>,
  responses: Readonly<Partial<Record<Seat, 'rob' | 'pass'>>>,
): GameState {
  const robbers = phase.eligibleRobbers.filter((seat) => responses[seat] === 'rob');

  if (robbers.length > 0) {
    return resolveRobKongSuccess(state, phase, robbers);
  }
  return resolveRobKongAllPass(state, phase);
}

/**
 * At least one rob (RULES.md §7.2 step 3): the kong is cancelled/reverted,
 * the honored robber(s) win off the kong declarer treated as the discarder.
 */
function resolveRobKongSuccess(
  state: GameState,
  phase: Extract<Phase, { type: 'awaiting-rob-kong' }>,
  robbers: readonly Seat[],
): GameState {
  const honored = state.rules.multipleWinners ? robbers : [robbers[0]];
  const declarerSeat = phase.declarerSeat;
  const declarer = state.players[declarerSeat];

  let players: Players;
  if (phase.kongType === 'added') {
    const revertedHand = revertAddedKong(declarer.hand, phase.kongTile);
    players = replacePlayer(state.players, declarerSeat, { ...declarer, hand: revertedHand });
  } else {
    // Concealed kong: the declarer's hand was never mutated (pending model).
    // Only the representative kongTile transfers to the robber; the other 3
    // pending tiles were never removed and remain untouched in concealed hand.
    const newConcealed = declarer.hand.concealedTiles.filter((t) => t.id !== phase.kongTile.id);
    players = replacePlayer(state.players, declarerSeat, {
      ...declarer,
      hand: { ...declarer.hand, concealedTiles: newConcealed },
    });
  }

  const handTai = computeHandTai({ winType: 'robbed-kong' }, state.rules);
  const winners: WinnerResult[] = honored.map((seat) => ({
    seat,
    winType: 'robbed-kong',
    handTai,
    winningTile: phase.kongTile,
  }));

  const legs: PaymentLeg[] = winners.flatMap((w) =>
    computePaymentLegs({
      winnerSeat: w.seat,
      winType: 'discard',
      payerSeats: [declarerSeat],
      handTai: w.handTai,
      dealerSeat: state.dealerSeat,
      repeatCount: state.repeatCount,
      rules: state.rules,
    }),
  );

  const { nextDealerSeat, nextRepeatCount } = computeNextDealerOnWin(
    state.dealerSeat,
    winners.map((w) => w.seat),
    state.repeatCount,
  );

  return {
    ...state,
    players,
    phase: {
      type: 'hand-over',
      result: { kind: 'win', winners, legs, nextDealerSeat, nextRepeatCount },
    },
  };
}

/**
 * Everyone eligible passed (RULES.md §7.2 step 4): the kong stands. Every
 * eligible-but-declined robber is barred by sacred discard (unless disabled).
 * A pending concealed kong's meld is executed now (it was never mutated
 * while the window was open); an added kong's hand is already in its
 * post-promotion shape from `handleAddedKong`. Then the declarer draws their
 * replacement tile.
 */
function resolveRobKongAllPass(state: GameState, phase: Extract<Phase, { type: 'awaiting-rob-kong' }>): GameState {
  let players = state.players;

  if (state.rules.sacredDiscard.enabled) {
    for (const seat of phase.eligibleRobbers) {
      const player = players[seat];
      if (!player.barred) {
        players = replacePlayer(players, seat, { ...player, barred: true });
      }
    }
  }

  if (phase.kongType === 'concealed' && phase.pendingConcealedKongTiles !== null) {
    const pending = phase.pendingConcealedKongTiles;
    const pendingIds = new Set(pending.map((t) => t.id));
    const declarer = players[phase.declarerSeat];
    const remainingConcealed = declarer.hand.concealedTiles.filter((t) => !pendingIds.has(t.id));
    const newMeld: PlayerMeld = { kind: 'kong', concealed: true, tiles: pending };
    players = replacePlayer(players, phase.declarerSeat, {
      ...declarer,
      hand: { concealedTiles: remainingConcealed, melds: [...declarer.hand.melds, newMeld] },
    });
  }

  return kongReplacementDraw({ ...state, players }, phase.declarerSeat);
}
