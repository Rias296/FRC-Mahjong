import { describe, expect, it } from 'vitest';
import {
  applyAction,
  isRuleError,
  startHand,
  startHandFromWall,
  type ClaimSpec,
  type GameAction,
  type GameState,
  type PlayerState,
  type RuleError,
  type RuleErrorCode,
} from './game-state';
import {
  createTileSet,
  kindKey,
  type DragonName,
  type FlowerNumber,
  type Rank,
  type SuitName,
  type Tile,
  type TileKind,
  type WindName,
} from './tiles';
import { nextSeat, SEATS, type Seat } from './seats';
import type { Wall } from './wall';
import { shuffle } from './shuffle';
import type { PlayerHand } from './actions';
import { computeDealerTai } from './scoring';
import { DEFAULT_RULES, type RulesConfig } from './rules-config';

// --- Test-local shorthand tile builder (duplicated per-file convention, see hand.test.ts / flowers.test.ts) ---
// Suit tiles: 'wan1'..'wan9', 'tong1'..'tong9', 'tiao1'..'tiao9'.
// Honors: 'east' | 'south' | 'west' | 'north' | 'red' | 'green' | 'white'.
// Flowers: 'flower1'..'flower4', 'season1'..'season4'.
const WINDS: readonly WindName[] = ['east', 'south', 'west', 'north'];
const DRAGONS: readonly DragonName[] = ['red', 'green', 'white'];

function kindFromSpec(spec: string): TileKind {
  const suitMatch = /^(wan|tong|tiao)([1-9])$/.exec(spec);
  if (suitMatch) {
    return {
      category: 'suit',
      suit: suitMatch[1] as SuitName,
      rank: Number(suitMatch[2]) as Rank,
    };
  }
  if ((WINDS as readonly string[]).includes(spec)) {
    return { category: 'wind', wind: spec as WindName };
  }
  if ((DRAGONS as readonly string[]).includes(spec)) {
    return { category: 'dragon', dragon: spec as DragonName };
  }
  const flowerMatch = /^flower([1-4])$/.exec(spec);
  if (flowerMatch) {
    return { category: 'flower', series: 'flower', number: Number(flowerMatch[1]) as FlowerNumber };
  }
  const seasonMatch = /^season([1-4])$/.exec(spec);
  if (seasonMatch) {
    return { category: 'flower', series: 'season', number: Number(seasonMatch[1]) as FlowerNumber };
  }
  throw new Error(`Unknown tile spec: ${spec}`);
}

let idCounter = 0;

function tile(spec: string): Tile {
  const kind = kindFromSpec(spec);
  idCounter += 1;
  return { id: `${kindKey(kind)}-test${idCounter}`, kind };
}

function hand(...specs: string[]): Tile[] {
  return specs.map(tile);
}

/** Builds a Wall from head-to-tail order (index 0 = head, last index = tail). */
function wallOf(...tiles: Tile[]): Wall {
  return tiles;
}

function ids(tiles: readonly Tile[]): string[] {
  return tiles.map((t) => t.id);
}

/** N distinct non-flower filler tiles, cycling through the 27 hand-tile kinds. */
const FILLER_SPECS: readonly string[] = [
  'wan1', 'wan2', 'wan3', 'wan4', 'wan5', 'wan6', 'wan7', 'wan8', 'wan9',
  'tong1', 'tong2', 'tong3', 'tong4', 'tong5', 'tong6', 'tong7', 'tong8', 'tong9',
  'tiao1', 'tiao2', 'tiao3', 'tiao4', 'tiao5', 'tiao6', 'tiao7', 'tiao8', 'tiao9',
];

function fillerTiles(count: number): Tile[] {
  const result: Tile[] = [];
  for (let i = 0; i < count; i++) {
    result.push(tile(FILLER_SPECS[i % FILLER_SPECS.length]));
  }
  return result;
}

// --- Hand fixtures -----------------------------------------------------------

/** A 16-tile at-rest hand, isolated odd ranks + one honor: never tenpai, never pung/kong-eligible. */
function deadHandTiles(): Tile[] {
  return hand(
    'wan1', 'wan3', 'wan5', 'wan7', 'wan9',
    'tong1', 'tong3', 'tong5', 'tong7', 'tong9',
    'tiao1', 'tiao3', 'tiao5', 'tiao7', 'tiao9',
    'east',
  );
}

/** A 16-tile at-rest hand tenpai, waiting on the given honor spec to complete 5 sets + 1 pair. */
function waitingOnHand(waitSpec: string): PlayerHand {
  const concealed = hand(
    'wan1', 'wan2', 'wan3',
    'tong1', 'tong2', 'tong3',
    'tiao1', 'tiao2', 'tiao3',
    'red', 'red', 'red',
    'south', 'south', 'south',
    waitSpec,
  );
  return { concealedTiles: concealed, melds: [] };
}

/** A 16-tile at-rest hand with >=2 concealed copies of `spec` (pung-eligible), rest filler. */
function pungEligibleHand(spec: string): PlayerHand {
  const concealed = [tile(spec), tile(spec), ...fillerTiles(14)];
  return { concealedTiles: concealed, melds: [] };
}

/** A 16-tile at-rest hand with >=3 concealed copies of `spec` (kong-eligible), rest filler. */
function kongEligibleHand(spec: string): PlayerHand {
  const concealed = [tile(spec), tile(spec), tile(spec), ...fillerTiles(13)];
  return { concealedTiles: concealed, melds: [] };
}

/** A 16-tile at-rest hand holding `loSpec`/`hiSpec` (a chow-completing pair), rest filler. Returns the two named tiles too. */
function chowEligibleHand(loSpec: string, hiSpec: string): { hand: PlayerHand; lo: Tile; hi: Tile } {
  const lo = tile(loSpec);
  const hi = tile(hiSpec);
  const concealed = [lo, hi, ...fillerTiles(14)];
  return { hand: { concealedTiles: concealed, melds: [] }, lo, hi };
}

/** A 16-tile at-rest hand that is both hu-eligible AND pung-eligible on 'east'. */
function dualEligibleOnEastHand(): PlayerHand {
  const concealed = hand(
    'east', 'east',
    'wan1', 'wan2', 'wan3', 'wan4', 'wan5', 'wan6', 'wan7', 'wan8', 'wan9',
    'tong1', 'tong2', 'tong3',
    'tiao1', 'tiao1',
  );
  return { concealedTiles: concealed, melds: [] };
}

/** A 16-tile concealed hand + a candidate tile forming a complete 5-set + 1-pair hand. */
function completeSixteenPlusOne(): { sixteen: Tile[]; winningTile: Tile } {
  const sixteen = hand(
    'wan1', 'wan2', 'wan3', 'wan4', 'wan5', 'wan6', 'wan7', 'wan8', 'wan9',
    'tong1', 'tong2', 'tong3',
    'tiao1', 'tiao1', 'tiao1',
    'east',
  );
  const winningTile = tile('east');
  return { sixteen, winningTile };
}

function defaultPlayerState(handTiles: Tile[]): PlayerState {
  return { hand: { concealedTiles: handTiles, melds: [] }, flowers: [], discards: [], barred: false };
}

function playerStateFromHand(h: PlayerHand): PlayerState {
  return { hand: h, flowers: [], discards: [], barred: false };
}

// --- GameState fixture helper --------------------------------------------------

function stateWith(overrides: Partial<GameState>): GameState {
  const base: GameState = {
    seed: 1,
    rules: DEFAULT_RULES,
    dealerSeat: 0,
    repeatCount: 0,
    wall: wallOf(...fillerTiles(40)),
    players: [
      defaultPlayerState(deadHandTiles()),
      defaultPlayerState(deadHandTiles()),
      defaultPlayerState(deadHandTiles()),
      defaultPlayerState(deadHandTiles()),
    ],
    currentTurnSeat: 0,
    phase: { type: 'awaiting-draw' },
  };
  return { ...base, ...overrides };
}

// --- Rigged-wall helper for full-hand scenario tests --------------------------

/**
 * Builds the exact 64-tile head block `deal()` will consume, given each
 * seat's target 16-tile dealt hand (in whatever internal order desired for
 * that seat's `hands[seat]` array). Mirrors deal()'s exact draw order:
 * 4 rounds, each round dealer-then-turn-order takes 4 tiles.
 */
function buildDealBlock(dealer: Seat, perSeatHands: readonly [Tile[], Tile[], Tile[], Tile[]]): Tile[] {
  const consumedCount: [number, number, number, number] = [0, 0, 0, 0];
  const block: Tile[] = [];
  for (let round = 0; round < 4; round++) {
    let s: Seat = dealer;
    for (let turn = 0; turn < 4; turn++) {
      for (let i = 0; i < 4; i++) {
        block.push(perSeatHands[s][consumedCount[s]]);
        consumedCount[s]++;
      }
      s = nextSeat(s);
    }
  }
  return block;
}

// --- Assertion helpers ---------------------------------------------------------

function expectOk(result: GameState | RuleError): GameState {
  if (isRuleError(result)) {
    throw new Error(`Expected GameState, got RuleError: ${result.code} - ${result.message}`);
  }
  return result;
}

function expectRuleErrorCode(result: GameState | RuleError, code: RuleErrorCode): void {
  expect(isRuleError(result)).toBe(true);
  if (isRuleError(result)) {
    expect(result.code).toBe(code);
  }
}

/** Every tile id physically accounted for in a GameState (hands, melds, flowers, discards, wall, in-flight discard). */
function allTileIdsIn(state: GameState): string[] {
  const out: string[] = [];
  for (const player of state.players) {
    out.push(...ids(player.hand.concealedTiles));
    for (const meld of player.hand.melds) {
      out.push(...ids(meld.tiles));
    }
    out.push(...ids(player.flowers));
    out.push(...ids(player.discards));
  }
  out.push(...ids(state.wall));
  if (state.phase.type === 'awaiting-claims') {
    out.push(state.phase.discardedTile.id);
  }
  return out;
}

function expectConserved144(state: GameState): void {
  const allIds = allTileIdsIn(state);
  expect(allIds).toHaveLength(144);
  expect(new Set(allIds).size).toBe(144);
}

// ================================================================================
// 1. startHand deals 16 tiles per seat, resolves initial flowers, dealer holds 17
// ================================================================================

describe('startHand', () => {
  it('deals 16 tiles per non-dealer seat and 17 to the dealer, entering awaiting-discard', () => {
    const state = startHand(0, 42, DEFAULT_RULES);
    expect(state.phase.type).toBe('awaiting-discard');
    for (const seat of SEATS) {
      expect(state.players[seat].hand.melds).toEqual([]);
      if (seat === 0) {
        expect(state.players[seat].hand.concealedTiles).toHaveLength(17);
      } else {
        expect(state.players[seat].hand.concealedTiles).toHaveLength(16);
      }
    }
    expect(state.currentTurnSeat).toBe(0);
    expect(state.dealerSeat).toBe(0);
  });

  it('is deterministic for identical seed/dealer/rules', () => {
    const a = startHand(2, 777, DEFAULT_RULES);
    const b = startHand(2, 777, DEFAULT_RULES);
    expect(a).toEqual(b);
  });

  it('degenerate deadWallReserve ends in immediate exhaustive draw with all 144 tiles conserved', () => {
    const rules: RulesConfig = { ...DEFAULT_RULES, deadWallReserve: 100 };
    const state = startHand(1, 5, rules);
    expect(state.phase.type).toBe('hand-over');
    if (state.phase.type === 'hand-over') {
      expect(state.phase.result.kind).toBe('exhaustive-draw');
    }
    expectConserved144(state);
  });

  it('dealer opening-draw flower-chain into exhaustion ends the hand in a draw', () => {
    const dealt = fillerTiles(64);
    const flowerA = tile('flower1');
    const middle = fillerTiles(78);
    const flowerB = tile('flower2');
    const wall = wallOf(...dealt, flowerA, ...middle, flowerB);
    const rules: RulesConfig = { ...DEFAULT_RULES, deadWallReserve: 78 };

    const state = startHandFromWall(wall, 0, rules, 0, 999);

    expect(state.phase.type).toBe('hand-over');
    if (state.phase.type === 'hand-over') {
      expect(state.phase.result.kind).toBe('exhaustive-draw');
    }
    expect(ids(state.players[0].flowers)).toEqual([flowerA.id, flowerB.id]);
  });

  it('declare-hu on the opening 17 tiles wins as a self-draw (heavenly hand path)', () => {
    const { sixteen, winningTile } = completeSixteenPlusOne();
    const dealBlock = buildDealBlock(0, [sixteen, deadHandTiles(), deadHandTiles(), deadHandTiles()]);
    const wall = wallOf(...dealBlock, winningTile, ...fillerTiles(79));

    const started = startHandFromWall(wall, 0, DEFAULT_RULES, 0, 1);
    expect(started.phase.type).toBe('awaiting-discard');
    if (started.phase.type !== 'awaiting-discard') return;
    expect(started.phase.drawnTile?.id).toBe(winningTile.id);

    const result = expectOk(applyAction(started, { type: 'declare-hu', seat: 0 }));
    expect(result.phase.type).toBe('hand-over');
    if (result.phase.type === 'hand-over' && result.phase.result.kind === 'win') {
      expect(result.phase.result.winners).toHaveLength(1);
      expect(result.phase.result.winners[0].seat).toBe(0);
      expect(result.phase.result.winners[0].winType).toBe('self-draw');
      expect(result.phase.result.winners[0].winningTile.id).toBe(winningTile.id);
    } else {
      throw new Error('expected a win result');
    }
  });
});

// ================================================================================
// 6-7. draw / discard
// ================================================================================

describe('draw', () => {
  it('appends the drawn tile, resolves the flower chain, exposes flowers, and enters awaiting-discard', () => {
    const flowerA = tile('flower1');
    const filler1 = tile('wan2');
    const filler2 = tile('wan3');
    const wall = wallOf(flowerA, filler1, filler2);
    const rules: RulesConfig = { ...DEFAULT_RULES, deadWallReserve: 0 };
    const state = stateWith({ rules, wall, currentTurnSeat: 0, phase: { type: 'awaiting-draw' } });

    const result = expectOk(applyAction(state, { type: 'draw', seat: 0 }));

    expect(ids(result.players[0].flowers)).toEqual([flowerA.id]);
    expect(result.players[0].hand.concealedTiles).toHaveLength(17);
    expect(result.players[0].hand.concealedTiles.at(-1)?.id).toBe(filler2.id);
    expect(result.phase.type).toBe('awaiting-discard');
    if (result.phase.type === 'awaiting-discard') {
      expect(result.phase.drawnTile?.id).toBe(filler2.id);
    }
    expect(result.wall).toHaveLength(1);
  });
});

describe('discard', () => {
  it('removes the tile by id and opens the claim window; unknown tileId returns tile-not-in-hand', () => {
    const extra = tile('wan2');
    const player0 = defaultPlayerState([...deadHandTiles(), extra]);
    const state = stateWith({
      currentTurnSeat: 0,
      phase: { type: 'awaiting-discard', drawnTile: extra },
      players: [player0, defaultPlayerState(deadHandTiles()), defaultPlayerState(deadHandTiles()), defaultPlayerState(deadHandTiles())],
    });

    const result = expectOk(applyAction(state, { type: 'discard', seat: 0, tileId: extra.id }));
    expect(result.players[0].hand.concealedTiles).toHaveLength(16);
    expect(result.players[0].hand.concealedTiles.some((t) => t.id === extra.id)).toBe(false);
    expect(result.phase.type).toBe('awaiting-claims');
    if (result.phase.type === 'awaiting-claims') {
      expect(result.phase.discarderSeat).toBe(0);
      expect(result.phase.discardedTile.id).toBe(extra.id);
      expect(result.phase.responses).toEqual({});
    }

    const bad = applyAction(state, { type: 'discard', seat: 0, tileId: 'no-such-tile-id' });
    expectRuleErrorCode(bad, 'tile-not-in-hand');
  });
});

// ================================================================================
// 8-10. declare-hu (self-draw)
// ================================================================================

describe('declare-hu (self-draw)', () => {
  it('pays three legs with selfDrawTai and dealer tai on dealer-involved legs (dealer wins)', () => {
    const { sixteen, winningTile } = completeSixteenPlusOne();
    const state = stateWith({
      dealerSeat: 0,
      currentTurnSeat: 0,
      repeatCount: 2,
      phase: { type: 'awaiting-discard', drawnTile: winningTile },
      players: [
        defaultPlayerState([...sixteen, winningTile]),
        defaultPlayerState(deadHandTiles()),
        defaultPlayerState(deadHandTiles()),
        defaultPlayerState(deadHandTiles()),
      ],
    });

    const result = expectOk(applyAction(state, { type: 'declare-hu', seat: 0 }));
    expect(result.phase.type).toBe('hand-over');
    if (result.phase.type !== 'hand-over' || result.phase.result.kind !== 'win') {
      throw new Error('expected a win result');
    }
    const { winners, legs, nextDealerSeat, nextRepeatCount } = result.phase.result;
    expect(winners).toEqual([{ seat: 0, winType: 'self-draw', handTai: 1, winningTile: expect.objectContaining({ id: winningTile.id }) }]);
    expect(legs).toHaveLength(3);
    const dealerTai = computeDealerTai(2, DEFAULT_RULES);
    const expectedAmount = DEFAULT_RULES.points.basePoints + (1 + dealerTai) * DEFAULT_RULES.points.perTai;
    for (const leg of legs) {
      expect(leg.payeeSeat).toBe(0);
      expect(leg.amount).toBe(expectedAmount);
    }
    expect(legs.map((l) => l.payerSeat).sort()).toEqual([1, 2, 3]);
    expect(nextDealerSeat).toBe(0);
    expect(nextRepeatCount).toBe(3);
  });

  it('rejects a non-winning hand with not-a-winning-hand', () => {
    const extra = tile('wan2');
    const state = stateWith({
      currentTurnSeat: 0,
      phase: { type: 'awaiting-discard', drawnTile: extra },
      players: [
        defaultPlayerState([...deadHandTiles(), extra]),
        defaultPlayerState(deadHandTiles()),
        defaultPlayerState(deadHandTiles()),
        defaultPlayerState(deadHandTiles()),
      ],
    });
    const result = applyAction(state, { type: 'declare-hu', seat: 0 });
    expectRuleErrorCode(result, 'not-a-winning-hand');
  });

  it('rejects declare-hu when drawnTile is null (post chow/pung claim)', () => {
    const state = stateWith({
      currentTurnSeat: 0,
      phase: { type: 'awaiting-discard', drawnTile: null },
    });
    const result = applyAction(state, { type: 'declare-hu', seat: 0 });
    expectRuleErrorCode(result, 'not-a-winning-hand');
  });
});

// ================================================================================
// 11-19. Claim window
// ================================================================================

describe('claim window resolution', () => {
  it('hu claim on a discard beats a pung claim; single leg, discarder pays winner', () => {
    const discardedTile = tile('east');
    const state = stateWith({
      dealerSeat: 0,
      repeatCount: 0,
      phase: { type: 'awaiting-claims', discarderSeat: 0, discardedTile, responses: {} },
      players: [
        defaultPlayerState(deadHandTiles()),
        playerStateFromHand(waitingOnHand('east')),
        playerStateFromHand(pungEligibleHand('east')),
        defaultPlayerState(deadHandTiles()),
      ],
    });

    let s: GameState | RuleError = applyAction(state, { type: 'claim', seat: 1, claim: { type: 'hu' } });
    s = expectOk(s);
    s = applyAction(s, { type: 'claim', seat: 2, claim: { type: 'pung' } });
    s = expectOk(s);
    s = applyAction(s, { type: 'pass', seat: 3 });
    const result = expectOk(s);

    expect(result.phase.type).toBe('hand-over');
    if (result.phase.type !== 'hand-over' || result.phase.result.kind !== 'win') {
      throw new Error('expected a win result');
    }
    expect(result.phase.result.winners).toEqual([
      { seat: 1, winType: 'discard', handTai: 0, winningTile: expect.objectContaining({ id: discardedTile.id }) },
    ]);
    expect(result.phase.result.legs).toHaveLength(1);
    const dealerTai = computeDealerTai(0, DEFAULT_RULES);
    expect(result.phase.result.legs[0]).toEqual({
      payerSeat: 0,
      payeeSeat: 1,
      amount: DEFAULT_RULES.points.basePoints + dealerTai * DEFAULT_RULES.points.perTai,
    });
  });

  it('pung claim beats a chow claim regardless of proximity', () => {
    const discardedTile = tile('tong5');
    const chow = chowEligibleHand('tong4', 'tong6');
    const state = stateWith({
      phase: { type: 'awaiting-claims', discarderSeat: 0, discardedTile, responses: {} },
      players: [
        defaultPlayerState(deadHandTiles()),
        playerStateFromHand(chow.hand),
        playerStateFromHand(pungEligibleHand('tong5')),
        defaultPlayerState(deadHandTiles()),
      ],
    });

    let s: GameState | RuleError = applyAction(state, {
      type: 'claim',
      seat: 1,
      claim: { type: 'chow', tileIds: [chow.lo.id, chow.hi.id] },
    });
    s = expectOk(s);
    s = applyAction(s, { type: 'claim', seat: 2, claim: { type: 'pung' } });
    s = expectOk(s);
    s = applyAction(s, { type: 'pass', seat: 3 });
    const result = expectOk(s);

    expect(result.currentTurnSeat).toBe(2);
    expect(result.players[2].hand.melds).toHaveLength(1);
    expect(result.players[2].hand.melds[0].kind).toBe('pung');
    expect(result.players[1].hand.melds).toHaveLength(0);
  });

  it('kong vs pung at the same priority level resolves by proximity to the discarder (both directions)', () => {
    // Pung (seat2, prox 2) nearer than kong (seat3, prox 3): pung wins.
    const discardA = tile('white');
    const stateA = stateWith({
      phase: { type: 'awaiting-claims', discarderSeat: 0, discardedTile: discardA, responses: {} },
      players: [
        defaultPlayerState(deadHandTiles()),
        defaultPlayerState(deadHandTiles()),
        playerStateFromHand(pungEligibleHand('white')),
        playerStateFromHand(kongEligibleHand('white')),
      ],
    });
    let sa: GameState | RuleError = applyAction(stateA, { type: 'pass', seat: 1 });
    sa = expectOk(sa);
    sa = applyAction(sa, { type: 'claim', seat: 2, claim: { type: 'pung' } });
    sa = expectOk(sa);
    sa = applyAction(sa, { type: 'claim', seat: 3, claim: { type: 'kong' } });
    const resultA = expectOk(sa);
    expect(resultA.currentTurnSeat).toBe(2);
    expect(resultA.players[2].hand.melds[0].kind).toBe('pung');

    // Kong (seat1, prox 1) nearer than pung (seat3, prox 3): kong wins.
    const discardB = tile('white');
    const wallB = wallOf(...fillerTiles(20));
    const stateB = stateWith({
      wall: wallB,
      phase: { type: 'awaiting-claims', discarderSeat: 0, discardedTile: discardB, responses: {} },
      players: [
        defaultPlayerState(deadHandTiles()),
        playerStateFromHand(kongEligibleHand('white')),
        defaultPlayerState(deadHandTiles()),
        playerStateFromHand(pungEligibleHand('white')),
      ],
    });
    let sb: GameState | RuleError = applyAction(stateB, { type: 'claim', seat: 1, claim: { type: 'kong' } });
    sb = expectOk(sb);
    sb = applyAction(sb, { type: 'pass', seat: 2 });
    sb = expectOk(sb);
    sb = applyAction(sb, { type: 'claim', seat: 3, claim: { type: 'pung' } });
    const resultB = expectOk(sb);
    expect(resultB.currentTurnSeat).toBe(1);
    expect(resultB.players[1].hand.melds[0].kind).toBe('kong');
  });

  it('chow claim is only legal for nextSeat(discarder); tileIds must match a real canChow option', () => {
    const discardedTile = tile('tong5');
    const chow = chowEligibleHand('tong4', 'tong6');
    const wrongIds: [string, string] = [chow.hand.concealedTiles[2].id, chow.hand.concealedTiles[3].id]; // filler, not tong4/tong6

    // Wrong seat (not nextSeat(discarder)).
    const stateWrongSeat = stateWith({
      phase: { type: 'awaiting-claims', discarderSeat: 0, discardedTile, responses: {} },
      players: [
        defaultPlayerState(deadHandTiles()),
        defaultPlayerState(deadHandTiles()),
        playerStateFromHand(chow.hand),
        defaultPlayerState(deadHandTiles()),
      ],
    });
    const wrongSeatResult = applyAction(stateWrongSeat, {
      type: 'claim',
      seat: 2,
      claim: { type: 'chow', tileIds: [chow.lo.id, chow.hi.id] },
    });
    expectRuleErrorCode(wrongSeatResult, 'illegal-claim');

    // Correct seat, wrong tileIds.
    const stateWrongTiles = stateWith({
      phase: { type: 'awaiting-claims', discarderSeat: 0, discardedTile, responses: {} },
      players: [
        defaultPlayerState(deadHandTiles()),
        playerStateFromHand(chow.hand),
        defaultPlayerState(deadHandTiles()),
        defaultPlayerState(deadHandTiles()),
      ],
    });
    const wrongTilesResult = applyAction(stateWrongTiles, {
      type: 'claim',
      seat: 1,
      claim: { type: 'chow', tileIds: wrongIds },
    });
    expectRuleErrorCode(wrongTilesResult, 'illegal-claim');

    // Correct seat, correct tileIds (order-insensitive), executes.
    let s: GameState | RuleError = applyAction(stateWrongTiles, {
      type: 'claim',
      seat: 1,
      claim: { type: 'chow', tileIds: [chow.hi.id, chow.lo.id] },
    });
    s = expectOk(s);
    s = applyAction(s, { type: 'pass', seat: 2 });
    s = expectOk(s);
    s = applyAction(s, { type: 'pass', seat: 3 });
    const result = expectOk(s);
    expect(result.currentTurnSeat).toBe(1);
    expect(result.players[1].hand.melds).toHaveLength(1);
    expect(result.players[1].hand.melds[0].kind).toBe('chow');
    expect(ids(result.players[1].hand.melds[0].tiles).sort()).toEqual(
      [chow.lo.id, discardedTile.id, chow.hi.id].sort(),
    );
  });

  it('kong-from-discard claim executes an exposed kong, draws a replacement, and the claimant continues at awaiting-discard', () => {
    const discardedTile = tile('east');
    const replacement = tile('wan9');
    const wall = wallOf(...fillerTiles(19), replacement);
    const state = stateWith({
      wall,
      phase: { type: 'awaiting-claims', discarderSeat: 0, discardedTile, responses: {} },
      players: [
        defaultPlayerState(deadHandTiles()),
        defaultPlayerState(deadHandTiles()),
        playerStateFromHand(kongEligibleHand('east')),
        defaultPlayerState(deadHandTiles()),
      ],
    });

    let s: GameState | RuleError = applyAction(state, { type: 'claim', seat: 2, claim: { type: 'kong' } });
    s = expectOk(s);
    s = applyAction(s, { type: 'pass', seat: 1 });
    s = expectOk(s);
    s = applyAction(s, { type: 'pass', seat: 3 });
    const result = expectOk(s);

    expect(result.players[2].hand.melds).toHaveLength(1);
    expect(result.players[2].hand.melds[0].kind).toBe('kong');
    expect(result.players[2].hand.melds[0].tiles).toHaveLength(4);
    expect(result.players[2].hand.concealedTiles).toHaveLength(14);
    expect(result.players[2].hand.concealedTiles.some((t) => t.id === replacement.id)).toBe(true);
    expect(result.wall).toHaveLength(19);
    expect(result.currentTurnSeat).toBe(2);
    expect(result.phase.type).toBe('awaiting-discard');
    if (result.phase.type === 'awaiting-discard') {
      expect(result.phase.drawnTile?.id).toBe(replacement.id);
    }
  });

  it('kong-from-discard claim is rejected with no-replacement-available at the reserve', () => {
    const discardedTile = tile('east');
    const wall = wallOf(...fillerTiles(16)); // remaining === deadWallReserve (16)
    const state = stateWith({
      wall,
      phase: { type: 'awaiting-claims', discarderSeat: 0, discardedTile, responses: {} },
      players: [
        defaultPlayerState(deadHandTiles()),
        defaultPlayerState(deadHandTiles()),
        playerStateFromHand(kongEligibleHand('east')),
        defaultPlayerState(deadHandTiles()),
      ],
    });
    const result = applyAction(state, { type: 'claim', seat: 2, claim: { type: 'kong' } });
    expectRuleErrorCode(result, 'no-replacement-available');
  });

  it('no claims: the discard lands in the discarder row, next seat enters awaiting-draw', () => {
    const discardedTile = tile('east');
    const state = stateWith({
      wall: wallOf(...fillerTiles(40)),
      phase: { type: 'awaiting-claims', discarderSeat: 0, discardedTile, responses: {} },
    });

    let s: GameState | RuleError = applyAction(state, { type: 'pass', seat: 1 });
    s = expectOk(s);
    s = applyAction(s, { type: 'pass', seat: 2 });
    s = expectOk(s);
    s = applyAction(s, { type: 'pass', seat: 3 });
    const result = expectOk(s);

    expect(result.players[0].discards.map((t) => t.id)).toEqual([discardedTile.id]);
    expect(result.currentTurnSeat).toBe(1);
    expect(result.phase.type).toBe('awaiting-draw');
  });

  it('no claims at the wall reserve: hand ends in exhaustive draw; dealerRepeatsOnDraw true and false both verified', () => {
    const discardedTile = tile('east');
    const wall = wallOf(...fillerTiles(16)); // remaining === deadWallReserve

    const stateRepeats = stateWith({
      wall,
      dealerSeat: 0,
      repeatCount: 4,
      rules: { ...DEFAULT_RULES, dealerRepeatsOnDraw: true },
      phase: { type: 'awaiting-claims', discarderSeat: 0, discardedTile, responses: {} },
    });
    let s1: GameState | RuleError = applyAction(stateRepeats, { type: 'pass', seat: 1 });
    s1 = expectOk(s1);
    s1 = applyAction(s1, { type: 'pass', seat: 2 });
    s1 = expectOk(s1);
    s1 = applyAction(s1, { type: 'pass', seat: 3 });
    const result1 = expectOk(s1);
    expect(result1.phase.type).toBe('hand-over');
    if (result1.phase.type === 'hand-over' && result1.phase.result.kind === 'exhaustive-draw') {
      expect(result1.phase.result.nextDealerSeat).toBe(0);
      expect(result1.phase.result.nextRepeatCount).toBe(5);
    } else {
      throw new Error('expected exhaustive-draw');
    }

    const stateRotates = stateWith({
      wall,
      dealerSeat: 0,
      repeatCount: 4,
      rules: { ...DEFAULT_RULES, dealerRepeatsOnDraw: false },
      phase: { type: 'awaiting-claims', discarderSeat: 0, discardedTile: tile('east'), responses: {} },
    });
    let s2: GameState | RuleError = applyAction(stateRotates, { type: 'pass', seat: 1 });
    s2 = expectOk(s2);
    s2 = applyAction(s2, { type: 'pass', seat: 2 });
    s2 = expectOk(s2);
    s2 = applyAction(s2, { type: 'pass', seat: 3 });
    const result2 = expectOk(s2);
    expect(result2.phase.type).toBe('hand-over');
    if (result2.phase.type === 'hand-over' && result2.phase.result.kind === 'exhaustive-draw') {
      expect(result2.phase.result.nextDealerSeat).toBe(1);
      expect(result2.phase.result.nextRepeatCount).toBe(0);
    } else {
      throw new Error('expected exhaustive-draw');
    }
  });

  it('multipleWinners=false: nearest hu claimant wins alone; multipleWinners=true: all hu claimants win independently', () => {
    const discardedTile = tile('east');
    const baseParams = {
      phase: { type: 'awaiting-claims' as const, discarderSeat: 0 as Seat, discardedTile, responses: {} },
      players: [
        defaultPlayerState(deadHandTiles()),
        playerStateFromHand(waitingOnHand('east')),
        defaultPlayerState(deadHandTiles()),
        playerStateFromHand(waitingOnHand('east')),
      ] as GameState['players'],
    };

    const stateSingle = stateWith({ ...baseParams, rules: { ...DEFAULT_RULES, multipleWinners: false } });
    let s1: GameState | RuleError = applyAction(stateSingle, { type: 'claim', seat: 1, claim: { type: 'hu' } });
    s1 = expectOk(s1);
    s1 = applyAction(s1, { type: 'pass', seat: 2 });
    s1 = expectOk(s1);
    s1 = applyAction(s1, { type: 'claim', seat: 3, claim: { type: 'hu' } });
    const resultSingle = expectOk(s1);
    if (resultSingle.phase.type === 'hand-over' && resultSingle.phase.result.kind === 'win') {
      expect(resultSingle.phase.result.winners).toHaveLength(1);
      expect(resultSingle.phase.result.winners[0].seat).toBe(1);
      expect(resultSingle.phase.result.legs).toHaveLength(1);
    } else {
      throw new Error('expected a win result');
    }

    const stateMulti = stateWith({ ...baseParams, rules: { ...DEFAULT_RULES, multipleWinners: true } });
    let s2: GameState | RuleError = applyAction(stateMulti, { type: 'claim', seat: 1, claim: { type: 'hu' } });
    s2 = expectOk(s2);
    s2 = applyAction(s2, { type: 'pass', seat: 2 });
    s2 = expectOk(s2);
    s2 = applyAction(s2, { type: 'claim', seat: 3, claim: { type: 'hu' } });
    const resultMulti = expectOk(s2);
    if (resultMulti.phase.type === 'hand-over' && resultMulti.phase.result.kind === 'win') {
      expect(resultMulti.phase.result.winners.map((w) => w.seat).sort()).toEqual([1, 3]);
      expect(resultMulti.phase.result.legs).toHaveLength(2);
      expect(resultMulti.phase.result.legs.every((l) => l.payerSeat === 0)).toBe(true);
    } else {
      throw new Error('expected a win result');
    }
  });

  it('claim resolution state is identical under all permutations of response arrival order', () => {
    const discardedTile = tile('east');
    const base = stateWith({
      phase: { type: 'awaiting-claims', discarderSeat: 0, discardedTile, responses: {} },
      players: [
        defaultPlayerState(deadHandTiles()),
        defaultPlayerState(deadHandTiles()),
        playerStateFromHand(pungEligibleHand('east')),
        defaultPlayerState(deadHandTiles()),
      ],
    });

    const responses: ReadonlyArray<readonly [Seat, 'pass' | ClaimSpec]> = [
      [1, 'pass'],
      [2, { type: 'pung' }],
      [3, 'pass'],
    ];

    function permutations<T>(arr: readonly T[]): T[][] {
      if (arr.length <= 1) return [arr.slice()];
      const result: T[][] = [];
      for (let i = 0; i < arr.length; i++) {
        const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
        for (const p of permutations(rest)) {
          result.push([arr[i], ...p]);
        }
      }
      return result;
    }

    const finalStates: GameState[] = [];
    for (const perm of permutations(responses)) {
      let s: GameState = base;
      for (const [seat, resp] of perm) {
        const action: GameAction =
          resp === 'pass' ? { type: 'pass', seat } : { type: 'claim', seat, claim: resp };
        s = expectOk(applyAction(s, action));
      }
      finalStates.push(s);
    }

    for (const s of finalStates) {
      expect(s).toEqual(finalStates[0]);
    }
  });
});

// ================================================================================
// 20. sacred discard bars
// ================================================================================

describe('sacred discard bars', () => {
  it('a seat that could hu but passed is barred; the winning claimant and discarder are not', () => {
    const discardedTile = tile('east');
    const state = stateWith({
      phase: { type: 'awaiting-claims', discarderSeat: 0, discardedTile, responses: {} },
      players: [
        defaultPlayerState(deadHandTiles()),
        playerStateFromHand(waitingOnHand('east')),
        playerStateFromHand(pungEligibleHand('east')),
        defaultPlayerState(deadHandTiles()),
      ],
    });

    let s: GameState | RuleError = applyAction(state, { type: 'pass', seat: 1 });
    s = expectOk(s);
    s = applyAction(s, { type: 'claim', seat: 2, claim: { type: 'pung' } });
    s = expectOk(s);
    s = applyAction(s, { type: 'pass', seat: 3 });
    const result = expectOk(s);

    expect(result.players[1].barred).toBe(true);
    expect(result.players[2].barred).toBe(false); // the winning claimant
    expect(result.players[3].barred).toBe(false); // dead hand, could not have won
    expect(result.players[0].barred).toBe(false); // discarder is never barred
  });

  it('a seat that claimed pung instead of hu (and lost to a nearer kong) is barred', () => {
    const discardedTile = tile('east');
    const state = stateWith({
      wall: wallOf(...fillerTiles(20)),
      phase: { type: 'awaiting-claims', discarderSeat: 0, discardedTile, responses: {} },
      players: [
        defaultPlayerState(deadHandTiles()),
        playerStateFromHand(kongEligibleHand('east')),
        defaultPlayerState(deadHandTiles()),
        playerStateFromHand(dualEligibleOnEastHand()),
      ],
    });

    let s: GameState | RuleError = applyAction(state, { type: 'claim', seat: 1, claim: { type: 'kong' } });
    s = expectOk(s);
    s = applyAction(s, { type: 'pass', seat: 2 });
    s = expectOk(s);
    s = applyAction(s, { type: 'claim', seat: 3, claim: { type: 'pung' } });
    const result = expectOk(s);

    expect(result.currentTurnSeat).toBe(1); // kong (nearer) wins over the farther pung
    expect(result.players[3].barred).toBe(true);
  });

  it('a seat whose pung claim WINS the window is still barred if they could have declared hu on the same tile', () => {
    // Regression test: choosing pung over an available hu is a decline of hu
    // per RULES.md §8, regardless of whether that pung claim ends up winning
    // the claim window (no competing higher-priority claim here).
    const discardedTile = tile('east');
    const state = stateWith({
      phase: { type: 'awaiting-claims', discarderSeat: 0, discardedTile, responses: {} },
      players: [
        defaultPlayerState(deadHandTiles()),
        defaultPlayerState(deadHandTiles()),
        defaultPlayerState(deadHandTiles()),
        playerStateFromHand(dualEligibleOnEastHand()),
      ],
    });

    let s: GameState | RuleError = applyAction(state, { type: 'pass', seat: 1 });
    s = expectOk(s);
    s = applyAction(s, { type: 'pass', seat: 2 });
    s = expectOk(s);
    const result = expectOk(applyAction(s, { type: 'claim', seat: 3, claim: { type: 'pung' } }));

    expect(result.currentTurnSeat).toBe(3); // seat 3's pung wins the window uncontested
    expect(result.players[3].barred).toBe(true); // yet still barred: they declined an available hu
  });
});

// ================================================================================
// 21-22. Bar lifecycle
// ================================================================================

describe('sacred discard bar lifecycle', () => {
  it('a barred seat is rejected on a hu claim', () => {
    const discardedTile = tile('east');
    const state = stateWith({
      phase: { type: 'awaiting-claims', discarderSeat: 0, discardedTile, responses: {} },
      players: [
        defaultPlayerState(deadHandTiles()),
        { hand: waitingOnHand('east'), flowers: [], discards: [], barred: true },
        defaultPlayerState(deadHandTiles()),
        defaultPlayerState(deadHandTiles()),
      ],
    });
    const result = applyAction(state, { type: 'claim', seat: 1, claim: { type: 'hu' } });
    expectRuleErrorCode(result, 'barred-by-sacred-discard');
  });

  it('the bar clears on the barred seat\'s own discard under until-next-self-discard scope', () => {
    const extra = tile('wan2');
    const state = stateWith({
      currentTurnSeat: 1,
      rules: { ...DEFAULT_RULES, sacredDiscard: { enabled: true, scope: 'until-next-self-discard' } },
      phase: { type: 'awaiting-discard', drawnTile: extra },
      players: [
        defaultPlayerState(deadHandTiles()),
        { hand: { concealedTiles: [...deadHandTiles(), extra], melds: [] }, flowers: [], discards: [], barred: true },
        defaultPlayerState(deadHandTiles()),
        defaultPlayerState(deadHandTiles()),
      ],
    });
    const result = expectOk(applyAction(state, { type: 'discard', seat: 1, tileId: extra.id }));
    expect(result.players[1].barred).toBe(false);
  });

  it('the bar persists across the barred seat\'s own discard under entire-hand scope', () => {
    const extra = tile('wan2');
    const state = stateWith({
      currentTurnSeat: 1,
      rules: { ...DEFAULT_RULES, sacredDiscard: { enabled: true, scope: 'entire-hand' } },
      phase: { type: 'awaiting-discard', drawnTile: extra },
      players: [
        defaultPlayerState(deadHandTiles()),
        { hand: { concealedTiles: [...deadHandTiles(), extra], melds: [] }, flowers: [], discards: [], barred: true },
        defaultPlayerState(deadHandTiles()),
        defaultPlayerState(deadHandTiles()),
      ],
    });
    const result = expectOk(applyAction(state, { type: 'discard', seat: 1, tileId: extra.id }));
    expect(result.players[1].barred).toBe(true);
  });

  it('a barred seat may still win by self-draw', () => {
    const { sixteen, winningTile } = completeSixteenPlusOne();
    const state = stateWith({
      currentTurnSeat: 0,
      phase: { type: 'awaiting-discard', drawnTile: winningTile },
      players: [
        { hand: { concealedTiles: [...sixteen, winningTile], melds: [] }, flowers: [], discards: [], barred: true },
        defaultPlayerState(deadHandTiles()),
        defaultPlayerState(deadHandTiles()),
        defaultPlayerState(deadHandTiles()),
      ],
    });
    const result = expectOk(applyAction(state, { type: 'declare-hu', seat: 0 }));
    expect(result.phase.type).toBe('hand-over');
  });
});

// ================================================================================
// 23-24. Minimum tai / sacredDiscard disabled
// ================================================================================

describe('below-minimum-tai and disabled sacred discard', () => {
  it('below-minimum-tai self-draw hu is rejected', () => {
    const { sixteen, winningTile } = completeSixteenPlusOne();
    const rules: RulesConfig = { ...DEFAULT_RULES, minTaiToWin: 2 }; // selfDrawTai default 1 < 2
    const state = stateWith({
      rules,
      currentTurnSeat: 0,
      phase: { type: 'awaiting-discard', drawnTile: winningTile },
      players: [
        defaultPlayerState([...sixteen, winningTile]),
        defaultPlayerState(deadHandTiles()),
        defaultPlayerState(deadHandTiles()),
        defaultPlayerState(deadHandTiles()),
      ],
    });
    const result = applyAction(state, { type: 'declare-hu', seat: 0 });
    expectRuleErrorCode(result, 'below-minimum-tai');
  });

  it('below-minimum-tai discard hu is rejected and does not bar the claimant', () => {
    const discardedTile = tile('east');
    const rules: RulesConfig = { ...DEFAULT_RULES, minTaiToWin: 1 }; // discard handTai is always 0
    const state = stateWith({
      rules,
      phase: { type: 'awaiting-claims', discarderSeat: 0, discardedTile, responses: {} },
      players: [
        defaultPlayerState(deadHandTiles()),
        playerStateFromHand(waitingOnHand('east')),
        defaultPlayerState(deadHandTiles()),
        defaultPlayerState(deadHandTiles()),
      ],
    });

    const rejected = applyAction(state, { type: 'claim', seat: 1, claim: { type: 'hu' } });
    expectRuleErrorCode(rejected, 'below-minimum-tai');

    let s: GameState | RuleError = applyAction(state, { type: 'pass', seat: 1 });
    s = expectOk(s);
    s = applyAction(s, { type: 'pass', seat: 2 });
    s = expectOk(s);
    s = applyAction(s, { type: 'pass', seat: 3 });
    const result = expectOk(s);
    expect(result.players[1].barred).toBe(false);
  });

  it('sacredDiscard.enabled=false never bars and never bar-rejects', () => {
    const discardedTile = tile('east');
    const rules: RulesConfig = { ...DEFAULT_RULES, sacredDiscard: { enabled: false, scope: 'until-next-self-discard' } };
    const state = stateWith({
      rules,
      phase: { type: 'awaiting-claims', discarderSeat: 0, discardedTile, responses: {} },
      players: [
        defaultPlayerState(deadHandTiles()),
        playerStateFromHand(waitingOnHand('east')),
        defaultPlayerState(deadHandTiles()),
        defaultPlayerState(deadHandTiles()),
      ],
    });

    let s: GameState | RuleError = applyAction(state, { type: 'pass', seat: 1 });
    s = expectOk(s);
    s = applyAction(s, { type: 'pass', seat: 2 });
    s = expectOk(s);
    s = applyAction(s, { type: 'pass', seat: 3 });
    const result = expectOk(s);
    expect(result.players[1].barred).toBe(false);
  });
});

// ================================================================================
// 25. dealer repeat / rotation on win
// ================================================================================

describe('dealer continuation on win', () => {
  it('dealer self-draw win: dealer repeats, repeatCount + 1', () => {
    const { sixteen, winningTile } = completeSixteenPlusOne();
    const state = stateWith({
      dealerSeat: 0,
      currentTurnSeat: 0,
      repeatCount: 3,
      phase: { type: 'awaiting-discard', drawnTile: winningTile },
      players: [
        defaultPlayerState([...sixteen, winningTile]),
        defaultPlayerState(deadHandTiles()),
        defaultPlayerState(deadHandTiles()),
        defaultPlayerState(deadHandTiles()),
      ],
    });
    const result = expectOk(applyAction(state, { type: 'declare-hu', seat: 0 }));
    if (result.phase.type === 'hand-over' && result.phase.result.kind === 'win') {
      expect(result.phase.result.nextDealerSeat).toBe(0);
      expect(result.phase.result.nextRepeatCount).toBe(4);
    } else {
      throw new Error('expected a win result');
    }
  });

  it('non-dealer self-draw win: dealer rotates, repeatCount resets to 0', () => {
    const { sixteen, winningTile } = completeSixteenPlusOne();
    const state = stateWith({
      dealerSeat: 0,
      currentTurnSeat: 2,
      repeatCount: 3,
      phase: { type: 'awaiting-discard', drawnTile: winningTile },
      players: [
        defaultPlayerState(deadHandTiles()),
        defaultPlayerState(deadHandTiles()),
        defaultPlayerState([...sixteen, winningTile]),
        defaultPlayerState(deadHandTiles()),
      ],
    });
    const result = expectOk(applyAction(state, { type: 'declare-hu', seat: 2 }));
    if (result.phase.type === 'hand-over' && result.phase.result.kind === 'win') {
      expect(result.phase.result.nextDealerSeat).toBe(1);
      expect(result.phase.result.nextRepeatCount).toBe(0);
    } else {
      throw new Error('expected a win result');
    }
  });
});

// ================================================================================
// 26-27. Dispatch rejections and kong stubs
// ================================================================================

describe('universal dispatch rejections', () => {
  it('rejects a representative matrix of wrong-phase / wrong-seat / already-responded / hand-is-over actions', () => {
    const drawWrongPhase = stateWith({ phase: { type: 'awaiting-discard', drawnTile: null } });
    expectRuleErrorCode(applyAction(drawWrongPhase, { type: 'draw', seat: 0 }), 'wrong-phase');

    const drawWrongSeat = stateWith({ currentTurnSeat: 0, phase: { type: 'awaiting-draw' } });
    expectRuleErrorCode(applyAction(drawWrongSeat, { type: 'draw', seat: 1 }), 'wrong-seat');

    const discardWrongPhase = stateWith({ phase: { type: 'awaiting-draw' } });
    expectRuleErrorCode(applyAction(discardWrongPhase, { type: 'discard', seat: 0, tileId: 'x' }), 'wrong-phase');

    const discardWrongSeat = stateWith({ currentTurnSeat: 0, phase: { type: 'awaiting-discard', drawnTile: null } });
    expectRuleErrorCode(applyAction(discardWrongSeat, { type: 'discard', seat: 1, tileId: 'x' }), 'wrong-seat');

    const huWrongPhase = stateWith({ phase: { type: 'awaiting-draw' } });
    expectRuleErrorCode(applyAction(huWrongPhase, { type: 'declare-hu', seat: 0 }), 'wrong-phase');

    const huWrongSeat = stateWith({ currentTurnSeat: 0, phase: { type: 'awaiting-discard', drawnTile: null } });
    expectRuleErrorCode(applyAction(huWrongSeat, { type: 'declare-hu', seat: 1 }), 'wrong-seat');

    const claimWrongPhase = stateWith({ phase: { type: 'awaiting-draw' } });
    expectRuleErrorCode(
      applyAction(claimWrongPhase, { type: 'claim', seat: 1, claim: { type: 'hu' } }),
      'wrong-phase',
    );

    const claimDiscarderSelf = stateWith({
      phase: { type: 'awaiting-claims', discarderSeat: 0, discardedTile: tile('east'), responses: {} },
    });
    expectRuleErrorCode(
      applyAction(claimDiscarderSelf, { type: 'claim', seat: 0, claim: { type: 'hu' } }),
      'wrong-seat',
    );

    const passWrongPhase = stateWith({ phase: { type: 'awaiting-draw' } });
    expectRuleErrorCode(applyAction(passWrongPhase, { type: 'pass', seat: 1 }), 'wrong-phase');

    const passDiscarderSelf = stateWith({
      phase: { type: 'awaiting-claims', discarderSeat: 0, discardedTile: tile('east'), responses: {} },
    });
    expectRuleErrorCode(applyAction(passDiscarderSelf, { type: 'pass', seat: 0 }), 'wrong-seat');

    const alreadyResponded = stateWith({
      phase: {
        type: 'awaiting-claims',
        discarderSeat: 0,
        discardedTile: tile('east'),
        responses: { 1: 'pass' },
      },
    });
    expectRuleErrorCode(applyAction(alreadyResponded, { type: 'pass', seat: 1 }), 'already-responded');
    expectRuleErrorCode(
      applyAction(alreadyResponded, { type: 'claim', seat: 1, claim: { type: 'hu' } }),
      'already-responded',
    );

    const handOver = stateWith({
      phase: {
        type: 'hand-over',
        result: { kind: 'exhaustive-draw', nextDealerSeat: 0, nextRepeatCount: 0 },
      },
    });
    expectRuleErrorCode(applyAction(handOver, { type: 'draw', seat: 0 }), 'hand-is-over');
  });
});

describe('own-turn kong actions: wrong-phase / wrong-seat boundary', () => {
  it('declare-added-kong / declare-concealed-kong are rejected with wrong-phase/wrong-seat outside their valid phase+seat', () => {
    const wrongPhaseState = stateWith({ currentTurnSeat: 0, phase: { type: 'awaiting-draw' } });
    expectRuleErrorCode(
      applyAction(wrongPhaseState, { type: 'declare-added-kong', seat: 0, tileId: 'x' }),
      'wrong-phase',
    );
    expectRuleErrorCode(
      applyAction(wrongPhaseState, { type: 'declare-concealed-kong', seat: 0, kind: { category: 'wind', wind: 'east' } }),
      'wrong-phase',
    );

    const wrongSeatState = stateWith({ currentTurnSeat: 0, phase: { type: 'awaiting-discard', drawnTile: null } });
    expectRuleErrorCode(
      applyAction(wrongSeatState, { type: 'declare-added-kong', seat: 1, tileId: 'x' }),
      'wrong-seat',
    );
    expectRuleErrorCode(
      applyAction(wrongSeatState, { type: 'declare-concealed-kong', seat: 1, kind: { category: 'wind', wind: 'east' } }),
      'wrong-seat',
    );
  });

  it('declare-rob returns wrong-phase outside awaiting-rob-kong', () => {
    const drawState = stateWith({ phase: { type: 'awaiting-draw' } });
    expectRuleErrorCode(applyAction(drawState, { type: 'declare-rob', seat: 1 }), 'wrong-phase');

    const discardState = stateWith({ phase: { type: 'awaiting-discard', drawnTile: null } });
    expectRuleErrorCode(applyAction(discardState, { type: 'declare-rob', seat: 1 }), 'wrong-phase');

    const claimsState = stateWith({
      phase: { type: 'awaiting-claims', discarderSeat: 0, discardedTile: tile('east'), responses: {} },
    });
    expectRuleErrorCode(applyAction(claimsState, { type: 'declare-rob', seat: 1 }), 'wrong-phase');
  });
});

// ================================================================================
// 28. Immutability
// ================================================================================

describe('applyAction immutability', () => {
  it('never mutates its input state', () => {
    const extra = tile('wan2');
    const player0 = defaultPlayerState([...deadHandTiles(), extra]);
    const state = stateWith({
      currentTurnSeat: 0,
      phase: { type: 'awaiting-discard', drawnTile: extra },
      players: [player0, defaultPlayerState(deadHandTiles()), defaultPlayerState(deadHandTiles()), defaultPlayerState(deadHandTiles())],
    });
    const snapshot = JSON.parse(JSON.stringify(state)) as GameState;

    applyAction(state, { type: 'discard', seat: 0, tileId: extra.id });
    applyAction(state, { type: 'draw', seat: 1 });
    applyAction(state, { type: 'declare-hu', seat: 0 });

    expect(state).toEqual(snapshot);
  });
});

// ================================================================================
// 29-32. Full hand via rigged wall
// ================================================================================

describe('full hand via rigged wall', () => {
  it('start-to-finish ending in a self-drawn win with correct payments', () => {
    const { sixteen, winningTile } = completeSixteenPlusOne();
    const dealBlock = buildDealBlock(0, [sixteen, deadHandTiles(), deadHandTiles(), deadHandTiles()]);
    const wall = wallOf(...dealBlock, winningTile, ...fillerTiles(79));
    const rules: RulesConfig = { ...DEFAULT_RULES };

    const started = startHandFromWall(wall, 0, rules, 1, 42);
    expect(started.phase.type).toBe('awaiting-discard');

    const result = expectOk(applyAction(started, { type: 'declare-hu', seat: 0 }));
    expect(result.phase.type).toBe('hand-over');
    if (result.phase.type !== 'hand-over' || result.phase.result.kind !== 'win') {
      throw new Error('expected a win result');
    }
    const dealerTai = computeDealerTai(1, rules);
    const expectedAmount = rules.points.basePoints + (rules.selfDrawTai + dealerTai) * rules.points.perTai;
    expect(result.phase.result.legs).toHaveLength(3);
    for (const leg of result.phase.result.legs) {
      expect(leg.amount).toBe(expectedAmount);
    }
    expect(result.phase.result.nextDealerSeat).toBe(0);
    expect(result.phase.result.nextRepeatCount).toBe(2);
  });

  it('start-to-finish ending in a discard win', () => {
    const winningTile = tile('east');
    const dealBlock = buildDealBlock(0, [
      deadHandTiles(),
      waitingOnHand('east').concealedTiles as Tile[],
      deadHandTiles(),
      deadHandTiles(),
    ]);
    const wall = wallOf(...dealBlock, winningTile, ...fillerTiles(79));
    const rules: RulesConfig = { ...DEFAULT_RULES };

    const started = startHandFromWall(wall, 0, rules, 0, 43);
    expect(started.phase.type).toBe('awaiting-discard');
    if (started.phase.type !== 'awaiting-discard' || started.phase.drawnTile === null) {
      throw new Error('expected an awaiting-discard phase with a drawn tile');
    }
    const drawnTileId = started.phase.drawnTile.id;
    expect(drawnTileId).toBe(winningTile.id);

    const discarded = expectOk(applyAction(started, { type: 'discard', seat: 0, tileId: drawnTileId }));
    expect(discarded.phase.type).toBe('awaiting-claims');

    let s: GameState | RuleError = applyAction(discarded, { type: 'claim', seat: 1, claim: { type: 'hu' } });
    s = expectOk(s);
    s = applyAction(s, { type: 'pass', seat: 2 });
    s = expectOk(s);
    s = applyAction(s, { type: 'pass', seat: 3 });
    const result = expectOk(s);

    expect(result.phase.type).toBe('hand-over');
    if (result.phase.type !== 'hand-over' || result.phase.result.kind !== 'win') {
      throw new Error('expected a win result');
    }
    expect(result.phase.result.winners).toEqual([
      { seat: 1, winType: 'discard', handTai: 0, winningTile: expect.objectContaining({ id: winningTile.id }) },
    ]);
    const dealerTai = computeDealerTai(0, rules);
    expect(result.phase.result.legs).toEqual([
      { payerSeat: 0, payeeSeat: 1, amount: rules.points.basePoints + dealerTai * rules.points.perTai },
    ]);
    expect(result.phase.result.nextDealerSeat).toBe(1);
    expect(result.phase.result.nextRepeatCount).toBe(0);
  });

  it('start-to-finish exhaustive draw with dealer repeat', () => {
    const dealBlock = buildDealBlock(0, [deadHandTiles(), deadHandTiles(), deadHandTiles(), deadHandTiles()]);
    const opening = tile('wan9');
    const wall = wallOf(...dealBlock, opening, ...fillerTiles(79)); // total 144, reserve = 79
    const rules: RulesConfig = { ...DEFAULT_RULES, deadWallReserve: 79, dealerRepeatsOnDraw: true };

    const started = startHandFromWall(wall, 0, rules, 0, 44);
    expect(started.phase.type).toBe('awaiting-discard');
    if (started.phase.type !== 'awaiting-discard' || started.phase.drawnTile === null) {
      throw new Error('expected an awaiting-discard phase with a drawn tile');
    }
    expect(remainingLen(started)).toBe(79);

    const discarded = expectOk(
      applyAction(started, { type: 'discard', seat: 0, tileId: started.phase.drawnTile.id }),
    );

    let s: GameState | RuleError = applyAction(discarded, { type: 'pass', seat: 1 });
    s = expectOk(s);
    s = applyAction(s, { type: 'pass', seat: 2 });
    s = expectOk(s);
    s = applyAction(s, { type: 'pass', seat: 3 });
    const result = expectOk(s);

    expect(result.phase.type).toBe('hand-over');
    if (result.phase.type !== 'hand-over' || result.phase.result.kind !== 'exhaustive-draw') {
      throw new Error('expected exhaustive-draw');
    }
    expect(result.phase.result.nextDealerSeat).toBe(0);
    expect(result.phase.result.nextRepeatCount).toBe(1);
    expectConserved144(result);
  });

  it('tile conservation: all 144 ids present exactly once at every step of a real full hand', () => {
    const seed = 20240713;
    const dealer: Seat = 1;
    const wall: Wall = shuffle(createTileSet(), seed);

    const started = startHandFromWall(wall, dealer, DEFAULT_RULES, 0, seed);
    expectConserved144(started);

    if (started.phase.type !== 'awaiting-discard' || started.phase.drawnTile === null) {
      // Degenerate outcome for this seed (unlikely); conservation already checked.
      return;
    }

    const discarded = expectOk(
      applyAction(started, { type: 'discard', seat: dealer, tileId: started.phase.drawnTile.id }),
    );
    expectConserved144(discarded);

    if (discarded.phase.type !== 'awaiting-claims') {
      throw new Error('expected awaiting-claims after a discard');
    }
    const [s1, s2, s3] = SEATS.filter((s) => s !== dealer);

    const afterFirstPass = expectOk(applyAction(discarded, { type: 'pass', seat: s1 }));
    expectConserved144(afterFirstPass);
    const afterSecondPass = expectOk(applyAction(afterFirstPass, { type: 'pass', seat: s2 }));
    expectConserved144(afterSecondPass);
    const afterThirdPass = expectOk(applyAction(afterSecondPass, { type: 'pass', seat: s3 }));
    expectConserved144(afterThirdPass);
  });
});

function remainingLen(state: GameState): number {
  return state.wall.length;
}
