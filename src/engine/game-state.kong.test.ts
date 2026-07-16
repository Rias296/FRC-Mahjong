import { describe, expect, it } from 'vitest';
import {
  applyAction,
  isRuleError,
  startHandFromWall,
  type GameAction,
  type GameState,
  type PlayerState,
  type RuleError,
  type RuleErrorCode,
} from './game-state';
import {
  kindKey,
  type DragonName,
  type FlowerNumber,
  type Rank,
  type SuitName,
  type Tile,
  type TileKind,
  type WindName,
} from './tiles';
import { nextSeat, type Seat } from './seats';
import type { Wall } from './wall';
import type { PlayerHand, PlayerMeld } from './actions';
import { computeDealerTai } from './scoring';
import { DEFAULT_RULES, type RulesConfig } from './rules-config';

// --- Test-local shorthand tile builder (duplicated per-file convention, see
// game-state.test.ts / game-state.adversarial.test.ts / rob-kong.test.ts) ---
// Suit tiles: 'wan1'..'wan9', 'tong1'..'tong9', 'tiao1'..'tiao9'.
// Honors: 'east' | 'south' | 'west' | 'north' | 'red' | 'green' | 'white'.
// Flowers: 'flower1'..'flower4', 'season1'..'season4'.
const WINDS: readonly WindName[] = ['east', 'south', 'west', 'north'];
const DRAGONS: readonly DragonName[] = ['red', 'green', 'white'];

function kindFromSpec(spec: string): TileKind {
  const suitMatch = /^(wan|tong|tiao)([1-9])$/.exec(spec);
  if (suitMatch) {
    return { category: 'suit', suit: suitMatch[1] as SuitName, rank: Number(suitMatch[2]) as Rank };
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
  return { id: `${kindKey(kind)}-kong${idCounter}`, kind };
}

function hand(...specs: string[]): Tile[] {
  return specs.map(tile);
}

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

/** A 16-tile at-rest hand tenpai, waiting on the given spec to complete 5 sets + 1 pair. */
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

/**
 * A must-act hand (one exposed pung of `spec`, 4th tile concealed) ready for
 * an added-kong declaration: melds.length=1, concealedTiles.length=14
 * (17 - 3*1). Returns the tile that would be added.
 */
function addedKongReadyHand(spec: string): { hand: PlayerHand; addedTile: Tile } {
  const pungMeld: PlayerMeld = { kind: 'pung', concealed: false, tiles: hand(spec, spec, spec) };
  const addedTile = tile(spec);
  const concealed = [addedTile, ...fillerTiles(13)];
  return { hand: { concealedTiles: concealed, melds: [pungMeld] }, addedTile };
}

/**
 * A must-act hand (17 concealed tiles, no melds) with exactly 4 concealed
 * copies of `spec`, ready for a concealed-kong declaration.
 */
function concealedKongReadyHand(spec: string): PlayerHand {
  const concealed = [tile(spec), tile(spec), tile(spec), tile(spec), ...fillerTiles(13)];
  return { concealedTiles: concealed, melds: [] };
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

/** Every tile id physically accounted for in a GameState. */
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

/**
 * A won hand-over's winning tile is deliberately dropped from the winner's
 * tracked hand data (only referenced via `WinnerResult.winningTile`) — this
 * mirrors handleDeclareHu's own concealedWithoutDrawn removal and
 * resolveHuClaims never adding the discardedTile to any hand. Returns the id
 * to exclude from a pre-win "before" snapshot when conservation-checking
 * across a win-resolving step, or null when `state` is not a won hand-over.
 */
function winningTileIdOf(state: GameState): string | null {
  if (state.phase.type === 'hand-over' && state.phase.result.kind === 'win') {
    return state.phase.result.winners[0].winningTile.id;
  }
  return null;
}

// ================================================================================
// 1. declare-added-kong: promote + replacement draw, no eligible robbers
// ================================================================================

describe('declare-added-kong', () => {
  it('promotes the pung, draws a replacement with flower chaining, and returns to awaiting-discard when no opponent can rob', () => {
    const { hand: h, addedTile } = addedKongReadyHand('tong8');
    const flowerA = tile('flower1');
    const finalTile = tile('wan5');
    const wall = wallOf(...fillerTiles(20), finalTile, flowerA); // tail = flowerA (drawn first)

    const state = stateWith({
      wall,
      currentTurnSeat: 0,
      phase: { type: 'awaiting-discard', drawnTile: null },
      players: [
        playerStateFromHand(h),
        defaultPlayerState(deadHandTiles()),
        defaultPlayerState(deadHandTiles()),
        defaultPlayerState(deadHandTiles()),
      ],
    });

    const result = expectOk(applyAction(state, { type: 'declare-added-kong', seat: 0, tileId: addedTile.id }));

    expect(result.players[0].hand.melds).toHaveLength(1);
    expect(result.players[0].hand.melds[0].kind).toBe('kong');
    expect(result.players[0].hand.melds[0].concealed).toBe(false);
    expect(ids(result.players[0].hand.melds[0].tiles)).toContain(addedTile.id);
    expect(result.players[0].hand.concealedTiles.some((t) => t.id === addedTile.id)).toBe(false);
    expect(ids(result.players[0].flowers)).toEqual([flowerA.id]);
    expect(result.phase.type).toBe('awaiting-discard');
    if (result.phase.type === 'awaiting-discard') {
      expect(result.phase.drawnTile?.id).toBe(finalTile.id);
    }
    expect(result.currentTurnSeat).toBe(0);
    expect(result.wall).toHaveLength(20);
  });
});

// ================================================================================
// 2. declare-concealed-kong: meld + replacement draw, robConcealedKong default false
// ================================================================================

describe('declare-concealed-kong', () => {
  it('records the concealed meld and draws a replacement when robConcealedKong is false (default), even with a winning opponent present', () => {
    const h = concealedKongReadyHand('tong8');
    const replacement = tile('wan5');
    const wall = wallOf(...fillerTiles(20), replacement);

    const state = stateWith({
      wall,
      currentTurnSeat: 0,
      phase: { type: 'awaiting-discard', drawnTile: null },
      players: [
        playerStateFromHand(h),
        playerStateFromHand(waitingOnHand('tong8')), // would be eligible if robConcealedKong were true
        defaultPlayerState(deadHandTiles()),
        defaultPlayerState(deadHandTiles()),
      ],
    });

    const kind: TileKind = { category: 'suit', suit: 'tong', rank: 8 };
    const result = expectOk(applyAction(state, { type: 'declare-concealed-kong', seat: 0, kind }));

    expect(result.players[0].hand.melds).toHaveLength(1);
    expect(result.players[0].hand.melds[0].kind).toBe('kong');
    expect(result.players[0].hand.melds[0].concealed).toBe(true);
    expect(result.players[0].hand.melds[0].tiles).toHaveLength(4);
    expect(result.phase.type).toBe('awaiting-discard');
    if (result.phase.type === 'awaiting-discard') {
      expect(result.phase.drawnTile?.id).toBe(replacement.id);
    }
    expect(result.wall).toHaveLength(20);
  });
});

// ================================================================================
// 3. Reserve check
// ================================================================================

describe('kong declaration at the wall reserve', () => {
  it('rejects both added and concealed kong declarations with no-replacement-available', () => {
    const wall = wallOf(...fillerTiles(16)); // remaining === deadWallReserve (16)

    const { hand: addedHand, addedTile } = addedKongReadyHand('tong8');
    const addedState = stateWith({
      wall,
      currentTurnSeat: 0,
      phase: { type: 'awaiting-discard', drawnTile: null },
      players: [
        playerStateFromHand(addedHand),
        defaultPlayerState(deadHandTiles()),
        defaultPlayerState(deadHandTiles()),
        defaultPlayerState(deadHandTiles()),
      ],
    });
    expectRuleErrorCode(
      applyAction(addedState, { type: 'declare-added-kong', seat: 0, tileId: addedTile.id }),
      'no-replacement-available',
    );

    const concealedHand = concealedKongReadyHand('tong9');
    const concealedState = stateWith({
      wall,
      currentTurnSeat: 0,
      phase: { type: 'awaiting-discard', drawnTile: null },
      players: [
        playerStateFromHand(concealedHand),
        defaultPlayerState(deadHandTiles()),
        defaultPlayerState(deadHandTiles()),
        defaultPlayerState(deadHandTiles()),
      ],
    });
    const kind: TileKind = { category: 'suit', suit: 'tong', rank: 9 };
    expectRuleErrorCode(
      applyAction(concealedState, { type: 'declare-concealed-kong', seat: 0, kind }),
      'no-replacement-available',
    );
  });
});

// ================================================================================
// 4. Illegal kong material / unknown tile
// ================================================================================

describe('illegal kong material and unknown tile', () => {
  it('declare-added-kong: unknown tileId is tile-not-in-hand; a tile with no matching exposed pung is illegal-kong', () => {
    const { hand: h } = addedKongReadyHand('tong8');
    const wall = wallOf(...fillerTiles(20));
    const state = stateWith({
      wall,
      currentTurnSeat: 0,
      phase: { type: 'awaiting-discard', drawnTile: null },
      players: [
        playerStateFromHand(h),
        defaultPlayerState(deadHandTiles()),
        defaultPlayerState(deadHandTiles()),
        defaultPlayerState(deadHandTiles()),
      ],
    });

    expectRuleErrorCode(
      applyAction(state, { type: 'declare-added-kong', seat: 0, tileId: 'no-such-tile-id' }),
      'tile-not-in-hand',
    );

    // No exposed pung at all: 17 must-act filler concealed tiles, no melds.
    const noMeldHand: PlayerHand = { concealedTiles: fillerTiles(17), melds: [] };
    const noMeldState = stateWith({
      wall,
      currentTurnSeat: 0,
      phase: { type: 'awaiting-discard', drawnTile: null },
      players: [
        playerStateFromHand(noMeldHand),
        defaultPlayerState(deadHandTiles()),
        defaultPlayerState(deadHandTiles()),
        defaultPlayerState(deadHandTiles()),
      ],
    });
    expectRuleErrorCode(
      applyAction(noMeldState, { type: 'declare-added-kong', seat: 0, tileId: noMeldHand.concealedTiles[0].id }),
      'illegal-kong',
    );
  });

  it('declare-concealed-kong: a kind with fewer than 4 concealed copies is illegal-kong', () => {
    const wall = wallOf(...fillerTiles(20));
    const noQuadHand: PlayerHand = { concealedTiles: fillerTiles(17), melds: [] };
    const state = stateWith({
      wall,
      currentTurnSeat: 0,
      phase: { type: 'awaiting-discard', drawnTile: null },
      players: [
        playerStateFromHand(noQuadHand),
        defaultPlayerState(deadHandTiles()),
        defaultPlayerState(deadHandTiles()),
        defaultPlayerState(deadHandTiles()),
      ],
    });
    const kind: TileKind = { category: 'wind', wind: 'east' };
    expectRuleErrorCode(applyAction(state, { type: 'declare-concealed-kong', seat: 0, kind }), 'illegal-kong');
  });
});

// ================================================================================
// 5. Added kong with one eligible robber opens the window before any draw
// ================================================================================

describe('awaiting-rob-kong window opening', () => {
  it('an added kong with exactly one eligible robber opens the window before any replacement draw', () => {
    const { hand: h, addedTile } = addedKongReadyHand('tong8');
    const wall = wallOf(...fillerTiles(20), tile('wan5')); // tail tile must never be drawn
    const state = stateWith({
      wall,
      currentTurnSeat: 0,
      phase: { type: 'awaiting-discard', drawnTile: null },
      players: [
        playerStateFromHand(h),
        playerStateFromHand(waitingOnHand('tong8')),
        defaultPlayerState(deadHandTiles()),
        defaultPlayerState(deadHandTiles()),
      ],
    });

    const result = expectOk(applyAction(state, { type: 'declare-added-kong', seat: 0, tileId: addedTile.id }));

    expect(result.phase.type).toBe('awaiting-rob-kong');
    if (result.phase.type !== 'awaiting-rob-kong') throw new Error('expected awaiting-rob-kong');
    expect(result.phase.declarerSeat).toBe(0);
    expect(result.phase.kongTile.id).toBe(addedTile.id);
    expect(result.phase.kongType).toBe('added');
    expect(result.phase.pendingConcealedKongTiles).toBeNull();
    expect(result.phase.eligibleRobbers).toEqual([1]);
    expect(result.phase.responses).toEqual({});
    expect(ids(result.wall)).toEqual(ids(wall)); // no replacement draw yet
    expect(result.players[0].hand.melds[0].kind).toBe('kong'); // already promoted
  });
});

// ================================================================================
// 6. Successful rob reverts the kong; robber wins with robKongTai
// ================================================================================

describe('successful rob', () => {
  it('reverts the kong to a pung, and the robber wins with robKongTai in handTai; declarer alone pays', () => {
    const { hand: h, addedTile } = addedKongReadyHand('tong8');
    const wall = wallOf(...fillerTiles(20), tile('wan5'));
    const state = stateWith({
      wall,
      dealerSeat: 0,
      repeatCount: 0,
      currentTurnSeat: 0,
      phase: { type: 'awaiting-discard', drawnTile: null },
      players: [
        playerStateFromHand(h),
        playerStateFromHand(waitingOnHand('tong8')),
        defaultPlayerState(deadHandTiles()),
        defaultPlayerState(deadHandTiles()),
      ],
    });

    const declared = expectOk(applyAction(state, { type: 'declare-added-kong', seat: 0, tileId: addedTile.id }));
    const result = expectOk(applyAction(declared, { type: 'declare-rob', seat: 1 }));

    expect(result.phase.type).toBe('hand-over');
    if (result.phase.type !== 'hand-over' || result.phase.result.kind !== 'win') {
      throw new Error('expected a win result');
    }
    expect(result.phase.result.winners).toEqual([
      {
        seat: 1,
        winType: 'robbed-kong',
        handTai: DEFAULT_RULES.robKongTai,
        winningTile: expect.objectContaining({ id: addedTile.id }),
      },
    ]);
    expect(result.phase.result.legs).toHaveLength(1);
    const dealerTai = computeDealerTai(0, DEFAULT_RULES);
    expect(result.phase.result.legs[0]).toEqual({
      payerSeat: 0,
      payeeSeat: 1,
      amount: DEFAULT_RULES.points.basePoints + (DEFAULT_RULES.robKongTai + dealerTai) * DEFAULT_RULES.points.perTai,
    });
    expect(result.phase.result.nextDealerSeat).toBe(1);
    expect(result.phase.result.nextRepeatCount).toBe(0);

    const revertedMeld = result.players[0].hand.melds[0];
    expect(revertedMeld.kind).toBe('pung');
    expect(revertedMeld.concealed).toBe(false);
    expect(revertedMeld.tiles).toHaveLength(3);
    expect(ids(revertedMeld.tiles)).not.toContain(addedTile.id);
  });
});

// ================================================================================
// 7. All pass: bars every eligible robber, kong stands, replacement drawn
// ================================================================================

describe('all pass on the rob window', () => {
  it('bars every eligible robber, the kong stands, and the declarer draws a replacement', () => {
    const { hand: h, addedTile } = addedKongReadyHand('tong8');
    const replacement = tile('wan5');
    const wall = wallOf(...fillerTiles(20), replacement);
    const state = stateWith({
      wall,
      currentTurnSeat: 0,
      phase: { type: 'awaiting-discard', drawnTile: null },
      players: [
        playerStateFromHand(h),
        playerStateFromHand(waitingOnHand('tong8')),
        defaultPlayerState(deadHandTiles()),
        playerStateFromHand(waitingOnHand('tong8')),
      ],
    });

    const declared = expectOk(applyAction(state, { type: 'declare-added-kong', seat: 0, tileId: addedTile.id }));
    expect(declared.phase.type).toBe('awaiting-rob-kong');
    if (declared.phase.type !== 'awaiting-rob-kong') throw new Error('expected awaiting-rob-kong');
    expect(declared.phase.eligibleRobbers).toEqual([1, 3]);

    let s: GameState | RuleError = applyAction(declared, { type: 'pass', seat: 1 });
    s = expectOk(s);
    const result = expectOk(applyAction(s, { type: 'pass', seat: 3 }));

    expect(result.players[1].barred).toBe(true);
    expect(result.players[3].barred).toBe(true);
    expect(result.players[0].hand.melds[0].kind).toBe('kong'); // kong still stands
    expect(result.players[0].hand.melds[0].tiles).toHaveLength(4);
    expect(result.phase.type).toBe('awaiting-discard');
    if (result.phase.type === 'awaiting-discard') {
      expect(result.phase.drawnTile?.id).toBe(replacement.id);
    }
    expect(result.currentTurnSeat).toBe(0);
  });
});

// ================================================================================
// 8. Eligibility filtering: barred / below-minimum-tai candidates excluded
// ================================================================================

describe('eligibility filtering', () => {
  it('excludes a previously-barred candidate; below-minimum-tai excludes everyone and skips the window entirely', () => {
    // (a) seat1 eligible-by-hand but pre-barred: excluded. seat3 eligible and not barred: window opens with just seat3.
    const { hand: h, addedTile } = addedKongReadyHand('tong8');
    const wall = wallOf(...fillerTiles(20), tile('wan5'));
    const barredState = stateWith({
      wall,
      currentTurnSeat: 0,
      phase: { type: 'awaiting-discard', drawnTile: null },
      players: [
        playerStateFromHand(h),
        { hand: waitingOnHand('tong8'), flowers: [], discards: [], barred: true },
        defaultPlayerState(deadHandTiles()),
        playerStateFromHand(waitingOnHand('tong8')),
      ],
    });
    const barredResult = expectOk(
      applyAction(barredState, { type: 'declare-added-kong', seat: 0, tileId: addedTile.id }),
    );
    expect(barredResult.phase.type).toBe('awaiting-rob-kong');
    if (barredResult.phase.type !== 'awaiting-rob-kong') throw new Error('expected awaiting-rob-kong');
    expect(barredResult.phase.eligibleRobbers).toEqual([3]);

    // (b) minTaiToWin above robKongTai excludes every otherwise-eligible seat; the
    // window is skipped and the kong stands immediately.
    const { hand: h2, addedTile: addedTile2 } = addedKongReadyHand('tong8');
    const replacement = tile('wan6');
    const wall2 = wallOf(...fillerTiles(20), replacement);
    const rules: RulesConfig = { ...DEFAULT_RULES, minTaiToWin: DEFAULT_RULES.robKongTai + 1 };
    const minTaiState = stateWith({
      rules,
      wall: wall2,
      currentTurnSeat: 0,
      phase: { type: 'awaiting-discard', drawnTile: null },
      players: [
        playerStateFromHand(h2),
        playerStateFromHand(waitingOnHand('tong8')),
        defaultPlayerState(deadHandTiles()),
        defaultPlayerState(deadHandTiles()),
      ],
    });
    const minTaiResult = expectOk(
      applyAction(minTaiState, { type: 'declare-added-kong', seat: 0, tileId: addedTile2.id }),
    );
    expect(minTaiResult.phase.type).toBe('awaiting-discard');
    if (minTaiResult.phase.type === 'awaiting-discard') {
      expect(minTaiResult.phase.drawnTile?.id).toBe(replacement.id);
    }
  });
});

// ================================================================================
// 9. Multiple robbers: multipleWinners false/true
// ================================================================================

describe('multiple robbers', () => {
  it('multipleWinners=false: nearest robber wins alone; multipleWinners=true: both win with independent legs paid by the declarer', () => {
    // multipleWinners=false
    const { hand: h1, addedTile: addedTile1 } = addedKongReadyHand('tong8');
    const wall1 = wallOf(...fillerTiles(20), tile('wan5'));
    const rulesFalse: RulesConfig = { ...DEFAULT_RULES, multipleWinners: false };
    const state1 = stateWith({
      rules: rulesFalse,
      wall: wall1,
      dealerSeat: 0,
      currentTurnSeat: 0,
      phase: { type: 'awaiting-discard', drawnTile: null },
      players: [
        playerStateFromHand(h1),
        playerStateFromHand(waitingOnHand('tong8')),
        defaultPlayerState(deadHandTiles()),
        playerStateFromHand(waitingOnHand('tong8')),
      ],
    });
    const declared1 = expectOk(applyAction(state1, { type: 'declare-added-kong', seat: 0, tileId: addedTile1.id }));
    if (declared1.phase.type !== 'awaiting-rob-kong') throw new Error('expected awaiting-rob-kong');
    expect(declared1.phase.eligibleRobbers).toEqual([1, 3]);

    let s1: GameState | RuleError = applyAction(declared1, { type: 'declare-rob', seat: 3 });
    s1 = expectOk(s1);
    const result1 = expectOk(applyAction(s1, { type: 'declare-rob', seat: 1 }));
    if (result1.phase.type !== 'hand-over' || result1.phase.result.kind !== 'win') {
      throw new Error('expected a win result');
    }
    expect(result1.phase.result.winners).toHaveLength(1);
    expect(result1.phase.result.winners[0].seat).toBe(1); // nearer to declarer(0)
    expect(result1.phase.result.legs).toHaveLength(1);

    // multipleWinners=true
    const { hand: h2, addedTile: addedTile2 } = addedKongReadyHand('tong8');
    const wall2 = wallOf(...fillerTiles(20), tile('wan6'));
    const rulesTrue: RulesConfig = { ...DEFAULT_RULES, multipleWinners: true };
    const state2 = stateWith({
      rules: rulesTrue,
      wall: wall2,
      dealerSeat: 0,
      currentTurnSeat: 0,
      phase: { type: 'awaiting-discard', drawnTile: null },
      players: [
        playerStateFromHand(h2),
        playerStateFromHand(waitingOnHand('tong8')),
        defaultPlayerState(deadHandTiles()),
        playerStateFromHand(waitingOnHand('tong8')),
      ],
    });
    const declared2 = expectOk(applyAction(state2, { type: 'declare-added-kong', seat: 0, tileId: addedTile2.id }));
    if (declared2.phase.type !== 'awaiting-rob-kong') throw new Error('expected awaiting-rob-kong');

    let s2: GameState | RuleError = applyAction(declared2, { type: 'declare-rob', seat: 3 });
    s2 = expectOk(s2);
    const result2 = expectOk(applyAction(s2, { type: 'declare-rob', seat: 1 }));
    if (result2.phase.type !== 'hand-over' || result2.phase.result.kind !== 'win') {
      throw new Error('expected a win result');
    }
    expect(result2.phase.result.winners.map((w) => w.seat).sort()).toEqual([1, 3]);
    expect(result2.phase.result.legs).toHaveLength(2);
    expect(result2.phase.result.legs.every((l) => l.payerSeat === 0)).toBe(true);
  });
});

// ================================================================================
// 10. robKong config gates
// ================================================================================

describe('robKong config gates', () => {
  it('robKong.enabled=false opens no window even with a winning opponent present', () => {
    const { hand: h, addedTile } = addedKongReadyHand('tong8');
    const replacement = tile('wan5');
    const wall = wallOf(...fillerTiles(20), replacement);
    const rules: RulesConfig = { ...DEFAULT_RULES, robKong: { enabled: false, robConcealedKong: false } };
    const state = stateWith({
      rules,
      wall,
      currentTurnSeat: 0,
      phase: { type: 'awaiting-discard', drawnTile: null },
      players: [
        playerStateFromHand(h),
        playerStateFromHand(waitingOnHand('tong8')),
        defaultPlayerState(deadHandTiles()),
        defaultPlayerState(deadHandTiles()),
      ],
    });
    const result = expectOk(applyAction(state, { type: 'declare-added-kong', seat: 0, tileId: addedTile.id }));
    expect(result.phase.type).toBe('awaiting-discard');
    if (result.phase.type === 'awaiting-discard') {
      expect(result.phase.drawnTile?.id).toBe(replacement.id);
    }
  });

  it('robConcealedKong=true opens a window on a concealed kong; a successful rob transfers only the kongTile, leaving the other three tiles unmelded in the declarer\'s hand', () => {
    const h = concealedKongReadyHand('tong8');
    const wall = wallOf(...fillerTiles(20), tile('wan5'));
    const rules: RulesConfig = { ...DEFAULT_RULES, robKong: { enabled: true, robConcealedKong: true } };
    const state = stateWith({
      rules,
      wall,
      dealerSeat: 0,
      currentTurnSeat: 0,
      phase: { type: 'awaiting-discard', drawnTile: null },
      players: [
        playerStateFromHand(h),
        playerStateFromHand(waitingOnHand('tong8')),
        defaultPlayerState(deadHandTiles()),
        defaultPlayerState(deadHandTiles()),
      ],
    });
    const kind: TileKind = { category: 'suit', suit: 'tong', rank: 8 };
    const declared = expectOk(applyAction(state, { type: 'declare-concealed-kong', seat: 0, kind }));
    expect(declared.phase.type).toBe('awaiting-rob-kong');
    if (declared.phase.type !== 'awaiting-rob-kong') throw new Error('expected awaiting-rob-kong');
    expect(declared.phase.kongType).toBe('concealed');
    expect(declared.phase.eligibleRobbers).toEqual([1]);
    const pending = declared.phase.pendingConcealedKongTiles;
    if (pending === null) throw new Error('expected pendingConcealedKongTiles');
    expect(pending).toHaveLength(4);
    const kongTileId = declared.phase.kongTile.id;

    const result = expectOk(applyAction(declared, { type: 'declare-rob', seat: 1 }));
    expect(result.phase.type).toBe('hand-over');
    if (result.phase.type !== 'hand-over' || result.phase.result.kind !== 'win') {
      throw new Error('expected a win result');
    }
    expect(result.phase.result.winners[0].seat).toBe(1);
    expect(result.phase.result.winners[0].winningTile.id).toBe(kongTileId);

    // No new meld was ever formed; the other 3 pending tiles remain in
    // concealed hand, only the kongTile is gone.
    expect(result.players[0].hand.melds).toHaveLength(0);
    const remainingConcealedIds = ids(result.players[0].hand.concealedTiles);
    expect(remainingConcealedIds).not.toContain(kongTileId);
    const otherThreeIds = pending.filter((t) => t.id !== kongTileId).map((t) => t.id);
    for (const id of otherThreeIds) {
      expect(remainingConcealedIds).toContain(id);
    }
  });
});

// ================================================================================
// 11. Dealer robs a kong
// ================================================================================

describe('dealer robs a kong', () => {
  it('dealer robbing a kong repeats dealership with dealer tai applied to the single payment leg', () => {
    const { hand: h, addedTile } = addedKongReadyHand('tong8');
    const wall = wallOf(...fillerTiles(20), tile('wan5'));
    const state = stateWith({
      wall,
      dealerSeat: 1, // declarer at seat 0, robber (dealer) at seat 1
      repeatCount: 2,
      currentTurnSeat: 0,
      phase: { type: 'awaiting-discard', drawnTile: null },
      players: [
        playerStateFromHand(h),
        playerStateFromHand(waitingOnHand('tong8')),
        defaultPlayerState(deadHandTiles()),
        defaultPlayerState(deadHandTiles()),
      ],
    });
    const declared = expectOk(applyAction(state, { type: 'declare-added-kong', seat: 0, tileId: addedTile.id }));
    const result = expectOk(applyAction(declared, { type: 'declare-rob', seat: 1 }));

    if (result.phase.type !== 'hand-over' || result.phase.result.kind !== 'win') {
      throw new Error('expected a win result');
    }
    expect(result.phase.result.nextDealerSeat).toBe(1);
    expect(result.phase.result.nextRepeatCount).toBe(3);

    const dealerTai = computeDealerTai(2, DEFAULT_RULES);
    expect(result.phase.result.legs).toEqual([
      {
        payerSeat: 0,
        payeeSeat: 1,
        amount: DEFAULT_RULES.points.basePoints + (DEFAULT_RULES.robKongTai + dealerTai) * DEFAULT_RULES.points.perTai,
      },
    ]);
  });
});

// ================================================================================
// 12. Chained kongs in one turn
// ================================================================================

describe('chained kongs in one turn', () => {
  it('a replacement tile enabling a second kong, each with its own replacement draw, and a final self-drawn hu', () => {
    const { hand: h, addedTile } = addedKongReadyHand('tong8');
    const tiao9x3 = hand('tiao9', 'tiao9', 'tiao9');
    const run = hand('wan1', 'wan2', 'wan3', 'wan4', 'wan5', 'wan6', 'wan7', 'wan8', 'wan9');
    const eastLone = tile('east');
    const fullHand: PlayerHand = {
      concealedTiles: [addedTile, ...tiao9x3, ...run, eastLone],
      melds: h.melds,
    };

    const fourthTiao9 = tile('tiao9');
    const finalWinTile = tile('east');
    const wall = wallOf(...fillerTiles(20), finalWinTile, fourthTiao9);

    const state = stateWith({
      wall,
      currentTurnSeat: 0,
      phase: { type: 'awaiting-discard', drawnTile: null },
      players: [
        playerStateFromHand(fullHand),
        defaultPlayerState(deadHandTiles()),
        defaultPlayerState(deadHandTiles()),
        defaultPlayerState(deadHandTiles()),
      ],
    });

    const afterKong1 = expectOk(applyAction(state, { type: 'declare-added-kong', seat: 0, tileId: addedTile.id }));
    expect(afterKong1.phase.type).toBe('awaiting-discard');
    if (afterKong1.phase.type !== 'awaiting-discard') throw new Error('expected awaiting-discard');
    expect(afterKong1.phase.drawnTile?.id).toBe(fourthTiao9.id);
    expect(afterKong1.players[0].hand.melds).toHaveLength(1);

    const tiao9Kind: TileKind = { category: 'suit', suit: 'tiao', rank: 9 };
    const afterKong2 = expectOk(
      applyAction(afterKong1, { type: 'declare-concealed-kong', seat: 0, kind: tiao9Kind }),
    );
    expect(afterKong2.phase.type).toBe('awaiting-discard');
    if (afterKong2.phase.type !== 'awaiting-discard') throw new Error('expected awaiting-discard');
    expect(afterKong2.phase.drawnTile?.id).toBe(finalWinTile.id);
    expect(afterKong2.players[0].hand.melds).toHaveLength(2);
    expect(afterKong2.players[0].hand.melds[1].concealed).toBe(true);

    const result = expectOk(applyAction(afterKong2, { type: 'declare-hu', seat: 0 }));
    expect(result.phase.type).toBe('hand-over');
    if (result.phase.type !== 'hand-over' || result.phase.result.kind !== 'win') {
      throw new Error('expected a win result');
    }
    expect(result.phase.result.winners).toEqual([
      {
        seat: 0,
        winType: 'self-draw',
        handTai: DEFAULT_RULES.selfDrawTai,
        winningTile: expect.objectContaining({ id: finalWinTile.id }),
      },
    ]);
    expect(result.wall).toHaveLength(wall.length - 2);
  });
});

// ================================================================================
// 13. Kong replacement flower chain hitting the reserve mid-chain
// ================================================================================

describe('kong replacement flower chain hitting the reserve', () => {
  it('ends the hand in an exhaustive draw when a kong replacement flower chain hits the reserve mid-chain', () => {
    const { hand: h, addedTile } = addedKongReadyHand('tong8');
    const flowerA = tile('flower1');
    const wall = wallOf(...fillerTiles(16), flowerA); // remaining=17>16; after popping flowerA, remaining=16<=16
    const state = stateWith({
      wall,
      dealerSeat: 0,
      repeatCount: 1,
      rules: { ...DEFAULT_RULES, dealerRepeatsOnDraw: true },
      currentTurnSeat: 0,
      phase: { type: 'awaiting-discard', drawnTile: null },
      players: [
        playerStateFromHand(h),
        defaultPlayerState(deadHandTiles()),
        defaultPlayerState(deadHandTiles()),
        defaultPlayerState(deadHandTiles()),
      ],
    });

    const result = expectOk(applyAction(state, { type: 'declare-added-kong', seat: 0, tileId: addedTile.id }));
    expect(result.phase.type).toBe('hand-over');
    if (result.phase.type !== 'hand-over' || result.phase.result.kind !== 'exhaustive-draw') {
      throw new Error('expected exhaustive-draw');
    }
    expect(result.phase.result.nextDealerSeat).toBe(0);
    expect(result.phase.result.nextRepeatCount).toBe(2);
    expect(ids(result.players[0].flowers)).toEqual([flowerA.id]);
    expect(result.wall).toHaveLength(16);
    // The kong itself already stands (already promoted) even though the hand ends in a draw.
    expect(result.players[0].hand.melds[0].kind).toBe('kong');
  });
});

// ================================================================================
// 14. Rob-window action rejections
// ================================================================================

describe('rob-window action rejections', () => {
  it('a seat not in eligibleRobbers gets wrong-seat; an eligible seat responding twice gets already-responded; declare-rob outside awaiting-rob-kong gets wrong-phase', () => {
    const { hand: h, addedTile } = addedKongReadyHand('tong8');
    const wall = wallOf(...fillerTiles(20), tile('wan5'));
    const state = stateWith({
      wall,
      currentTurnSeat: 0,
      phase: { type: 'awaiting-discard', drawnTile: null },
      players: [
        playerStateFromHand(h),
        playerStateFromHand(waitingOnHand('tong8')),
        defaultPlayerState(deadHandTiles()),
        defaultPlayerState(deadHandTiles()),
      ],
    });
    const declared = expectOk(applyAction(state, { type: 'declare-added-kong', seat: 0, tileId: addedTile.id }));
    if (declared.phase.type !== 'awaiting-rob-kong') throw new Error('expected awaiting-rob-kong');
    expect(declared.phase.eligibleRobbers).toEqual([1]);

    // Seat 2 is not eligible.
    expectRuleErrorCode(applyAction(declared, { type: 'declare-rob', seat: 2 }), 'wrong-seat');
    expectRuleErrorCode(applyAction(declared, { type: 'pass', seat: 2 }), 'wrong-seat');

    // Build a 2-eligible-robber window to test the still-open already-responded case.
    const { hand: h2, addedTile: addedTile2 } = addedKongReadyHand('tong8');
    const wall2 = wallOf(...fillerTiles(20), tile('wan6'));
    const state2 = stateWith({
      wall: wall2,
      currentTurnSeat: 0,
      phase: { type: 'awaiting-discard', drawnTile: null },
      players: [
        playerStateFromHand(h2),
        playerStateFromHand(waitingOnHand('tong8')),
        defaultPlayerState(deadHandTiles()),
        playerStateFromHand(waitingOnHand('tong8')),
      ],
    });
    const declared2 = expectOk(applyAction(state2, { type: 'declare-added-kong', seat: 0, tileId: addedTile2.id }));
    if (declared2.phase.type !== 'awaiting-rob-kong') throw new Error('expected awaiting-rob-kong');
    const afterPass1 = expectOk(applyAction(declared2, { type: 'pass', seat: 1 }));
    expect(afterPass1.phase.type).toBe('awaiting-rob-kong'); // window still open (seat 3 hasn't responded)
    expectRuleErrorCode(applyAction(afterPass1, { type: 'pass', seat: 1 }), 'already-responded');
    expectRuleErrorCode(applyAction(afterPass1, { type: 'declare-rob', seat: 1 }), 'already-responded');

    // declare-rob outside awaiting-rob-kong.
    const drawState = stateWith({ phase: { type: 'awaiting-draw' } });
    expectRuleErrorCode(applyAction(drawState, { type: 'declare-rob', seat: 1 }), 'wrong-phase');
  });
});

// ================================================================================
// 15. Rob window determinism under response order
// ================================================================================

describe('rob window determinism under response order', () => {
  it('rob-window resolution is identical under every permutation of eligible-seat response order', () => {
    const { hand: h, addedTile } = addedKongReadyHand('tong8');
    const wall = wallOf(...fillerTiles(20), tile('wan5'));
    const state = stateWith({
      wall,
      currentTurnSeat: 0,
      phase: { type: 'awaiting-discard', drawnTile: null },
      players: [
        playerStateFromHand(h),
        playerStateFromHand(waitingOnHand('tong8')),
        defaultPlayerState(deadHandTiles()),
        playerStateFromHand(waitingOnHand('tong8')),
      ],
    });
    const declared = expectOk(applyAction(state, { type: 'declare-added-kong', seat: 0, tileId: addedTile.id }));
    if (declared.phase.type !== 'awaiting-rob-kong') throw new Error('expected awaiting-rob-kong');
    expect(declared.phase.eligibleRobbers).toEqual([1, 3]);

    const responseSpecs: ReadonlyArray<readonly [Seat, 'rob' | 'pass']> = [
      [1, 'pass'],
      [3, 'rob'],
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
    for (const perm of permutations(responseSpecs)) {
      let s: GameState = declared;
      for (const [seat, resp] of perm) {
        const action: GameAction = resp === 'rob' ? { type: 'declare-rob', seat } : { type: 'pass', seat };
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
// 16. Immutability and tile conservation across kong paths
// ================================================================================

describe('immutability and tile conservation across kong paths', () => {
  it('applyAction never mutates its input state across the kong/rob-kong flow', () => {
    const { hand: h, addedTile } = addedKongReadyHand('tong8');
    const wall = wallOf(...fillerTiles(20), tile('wan5'));
    const state = stateWith({
      wall,
      currentTurnSeat: 0,
      phase: { type: 'awaiting-discard', drawnTile: null },
      players: [
        playerStateFromHand(h),
        playerStateFromHand(waitingOnHand('tong8')),
        defaultPlayerState(deadHandTiles()),
        defaultPlayerState(deadHandTiles()),
      ],
    });
    const snapshot = JSON.parse(JSON.stringify(state)) as GameState;

    const declared = expectOk(applyAction(state, { type: 'declare-added-kong', seat: 0, tileId: addedTile.id }));
    expect(state).toEqual(snapshot);

    const declaredSnapshot = JSON.parse(JSON.stringify(declared)) as GameState;
    applyAction(declared, { type: 'declare-rob', seat: 1 });
    applyAction(declared, { type: 'pass', seat: 1 });
    expect(declared).toEqual(declaredSnapshot);
  });

  it('tile conservation holds across the promote-and-rob path (added kong)', () => {
    const { hand: h, addedTile } = addedKongReadyHand('tong8');
    const wall = wallOf(...fillerTiles(20), tile('wan5'));
    const state = stateWith({
      wall,
      currentTurnSeat: 0,
      phase: { type: 'awaiting-discard', drawnTile: null },
      players: [
        playerStateFromHand(h),
        playerStateFromHand(waitingOnHand('tong8')),
        defaultPlayerState(deadHandTiles()),
        defaultPlayerState(deadHandTiles()),
      ],
    });
    const before = allTileIdsIn(state).sort();

    const declared = expectOk(applyAction(state, { type: 'declare-added-kong', seat: 0, tileId: addedTile.id }));
    expect(allTileIdsIn(declared).sort()).toEqual(before);

    // A successful rob resolves the hand into a win; the winning tile is
    // dropped from tracked hand data at that point (see winningTileIdOf).
    const result = expectOk(applyAction(declared, { type: 'declare-rob', seat: 1 }));
    const winningTileId = winningTileIdOf(result);
    expect(winningTileId).not.toBeNull();
    expect(allTileIdsIn(result).sort()).toEqual(before.filter((id) => id !== winningTileId));
  });

  it('tile conservation holds across the promote-and-all-pass path (added kong), including the replacement draw', () => {
    const { hand: h, addedTile } = addedKongReadyHand('tong8');
    const replacement = tile('wan5');
    const wall = wallOf(...fillerTiles(20), replacement);
    const state = stateWith({
      wall,
      currentTurnSeat: 0,
      phase: { type: 'awaiting-discard', drawnTile: null },
      players: [
        playerStateFromHand(h),
        playerStateFromHand(waitingOnHand('tong8')),
        defaultPlayerState(deadHandTiles()),
        defaultPlayerState(deadHandTiles()),
      ],
    });
    const before = allTileIdsIn(state).sort();

    const declared = expectOk(applyAction(state, { type: 'declare-added-kong', seat: 0, tileId: addedTile.id }));
    const result = expectOk(applyAction(declared, { type: 'pass', seat: 1 }));
    expect(allTileIdsIn(result).sort()).toEqual(before);
  });

  it('tile conservation holds across the pending-concealed-kong all-pass path', () => {
    const h = concealedKongReadyHand('tong8');
    const replacement = tile('wan5');
    const wall = wallOf(...fillerTiles(20), replacement);
    const rules: RulesConfig = { ...DEFAULT_RULES, robKong: { enabled: true, robConcealedKong: true } };
    const state = stateWith({
      rules,
      wall,
      currentTurnSeat: 0,
      phase: { type: 'awaiting-discard', drawnTile: null },
      players: [
        playerStateFromHand(h),
        playerStateFromHand(waitingOnHand('tong8')),
        defaultPlayerState(deadHandTiles()),
        defaultPlayerState(deadHandTiles()),
      ],
    });
    const before = allTileIdsIn(state).sort();

    const kind: TileKind = { category: 'suit', suit: 'tong', rank: 8 };
    const declared = expectOk(applyAction(state, { type: 'declare-concealed-kong', seat: 0, kind }));
    expect(allTileIdsIn(declared).sort()).toEqual(before);

    const result = expectOk(applyAction(declared, { type: 'pass', seat: 1 }));
    expect(allTileIdsIn(result).sort()).toEqual(before);
  });

  it('tile conservation holds across the pending-concealed-kong rob path', () => {
    const h = concealedKongReadyHand('tong9');
    const wall = wallOf(...fillerTiles(20), tile('wan5'));
    const rules: RulesConfig = { ...DEFAULT_RULES, robKong: { enabled: true, robConcealedKong: true } };
    const state = stateWith({
      rules,
      wall,
      currentTurnSeat: 0,
      phase: { type: 'awaiting-discard', drawnTile: null },
      players: [
        playerStateFromHand(h),
        playerStateFromHand(waitingOnHand('tong9')),
        defaultPlayerState(deadHandTiles()),
        defaultPlayerState(deadHandTiles()),
      ],
    });
    const before = allTileIdsIn(state).sort();

    const kind: TileKind = { category: 'suit', suit: 'tong', rank: 9 };
    const declared = expectOk(applyAction(state, { type: 'declare-concealed-kong', seat: 0, kind }));
    expect(allTileIdsIn(declared).sort()).toEqual(before);

    // A successful rob resolves the hand into a win; the winning tile is
    // dropped from tracked hand data at that point (see winningTileIdOf).
    const result = expectOk(applyAction(declared, { type: 'declare-rob', seat: 1 }));
    const winningTileId = winningTileIdOf(result);
    expect(winningTileId).not.toBeNull();
    expect(allTileIdsIn(result).sort()).toEqual(before.filter((id) => id !== winningTileId));
  });
});

// ================================================================================
// 17. Full hand via rigged wall: complete rob-kong sequence end-to-end
// ================================================================================

describe('full hand via rigged wall: rob-kong sequence end-to-end', () => {
  it('declare concealed kong -> opponent robs -> hand-over win with correct payment', () => {
    const rules: RulesConfig = { ...DEFAULT_RULES, robKong: { enabled: true, robConcealedKong: true } };

    const seat0Hand = [tile('tong8'), tile('tong8'), tile('tong8'), tile('tong8'), ...fillerTiles(12)];
    const seat1Hand = waitingOnHand('tong8').concealedTiles as Tile[];
    const seat2Hand = deadHandTiles();
    const seat3Hand = deadHandTiles();
    const dealBlock = buildDealBlock(0, [seat0Hand, seat1Hand, seat2Hand, seat3Hand]);
    const openingDraw = tile('wan1');
    const wall = wallOf(...dealBlock, openingDraw, ...fillerTiles(79));

    const started = startHandFromWall(wall, 0, rules, 0, 99);
    expect(started.phase.type).toBe('awaiting-discard');
    if (started.phase.type !== 'awaiting-discard' || started.phase.drawnTile === null) {
      throw new Error('expected awaiting-discard with a drawn tile');
    }
    expect(started.phase.drawnTile.id).toBe(openingDraw.id);
    expectConserved144(started);

    const kind: TileKind = { category: 'suit', suit: 'tong', rank: 8 };
    const declared = expectOk(applyAction(started, { type: 'declare-concealed-kong', seat: 0, kind }));
    expect(declared.phase.type).toBe('awaiting-rob-kong');
    if (declared.phase.type !== 'awaiting-rob-kong') throw new Error('expected awaiting-rob-kong');
    expect(declared.phase.eligibleRobbers).toEqual([1]);
    const kongTileId = declared.phase.kongTile.id;

    const result = expectOk(applyAction(declared, { type: 'declare-rob', seat: 1 }));
    expect(result.phase.type).toBe('hand-over');
    if (result.phase.type !== 'hand-over' || result.phase.result.kind !== 'win') {
      throw new Error('expected a win result');
    }
    expect(result.phase.result.winners).toEqual([
      {
        seat: 1,
        winType: 'robbed-kong',
        handTai: rules.robKongTai,
        winningTile: expect.objectContaining({ id: kongTileId }),
      },
    ]);
    const dealerTai = computeDealerTai(0, rules);
    expect(result.phase.result.legs).toEqual([
      { payerSeat: 0, payeeSeat: 1, amount: rules.points.basePoints + (rules.robKongTai + dealerTai) * rules.points.perTai },
    ]);
    expect(result.phase.result.nextDealerSeat).toBe(1);
    expect(result.phase.result.nextRepeatCount).toBe(0);

    expect(result.players[0].hand.melds).toHaveLength(0);
    expect(result.players[0].hand.concealedTiles).toHaveLength(16);
    expect(ids(result.players[0].hand.concealedTiles)).not.toContain(kongTileId);
  });
});

// ================================================================================
// 18. Full hand via rigged wall: kong stands after all pass, hand continues
// ================================================================================

describe('full hand via rigged wall: kong stands, hand continues to a later win', () => {
  it('a concealed kong with no eligible robbers stands, draws a replacement, and the hand continues to a later discard win', () => {
    const rules: RulesConfig = { ...DEFAULT_RULES }; // robConcealedKong default false

    const seat0Hand = [tile('tong8'), tile('tong8'), tile('tong8'), tile('tong8'), ...fillerTiles(12)];
    const seat1Hand = waitingOnHand('east').concealedTiles as Tile[];
    const seat2Hand = deadHandTiles();
    const seat3Hand = deadHandTiles();
    const dealBlock = buildDealBlock(0, [seat0Hand, seat1Hand, seat2Hand, seat3Hand]);
    const openingDraw = tile('wan2');
    const replacementTile = tile('east');
    const wall = wallOf(...dealBlock, openingDraw, ...fillerTiles(78), replacementTile);

    const started = startHandFromWall(wall, 0, rules, 0, 101);
    expect(started.phase.type).toBe('awaiting-discard');
    if (started.phase.type !== 'awaiting-discard' || started.phase.drawnTile === null) {
      throw new Error('expected awaiting-discard with a drawn tile');
    }
    expectConserved144(started);

    const kind: TileKind = { category: 'suit', suit: 'tong', rank: 8 };
    const afterKong = expectOk(applyAction(started, { type: 'declare-concealed-kong', seat: 0, kind }));
    expect(afterKong.phase.type).toBe('awaiting-discard');
    if (afterKong.phase.type !== 'awaiting-discard' || afterKong.phase.drawnTile === null) {
      throw new Error('expected awaiting-discard with a drawn replacement tile');
    }
    expect(afterKong.phase.drawnTile.id).toBe(replacementTile.id);
    expect(afterKong.players[0].hand.melds).toHaveLength(1);
    expect(afterKong.players[0].hand.melds[0].concealed).toBe(true);

    const discarded = expectOk(applyAction(afterKong, { type: 'discard', seat: 0, tileId: replacementTile.id }));
    expect(discarded.phase.type).toBe('awaiting-claims');

    let s: GameState | RuleError = applyAction(discarded, { type: 'claim', seat: 1, claim: { type: 'hu' } });
    s = expectOk(s);
    s = applyAction(s, { type: 'pass', seat: 2 });
    s = expectOk(s);
    const result = expectOk(applyAction(s, { type: 'pass', seat: 3 }));

    expect(result.phase.type).toBe('hand-over');
    if (result.phase.type !== 'hand-over' || result.phase.result.kind !== 'win') {
      throw new Error('expected a win result');
    }
    expect(result.phase.result.winners).toEqual([
      { seat: 1, winType: 'discard', handTai: 0, winningTile: expect.objectContaining({ id: replacementTile.id }) },
    ]);
    const dealerTai = computeDealerTai(0, rules);
    expect(result.phase.result.legs).toEqual([
      { payerSeat: 0, payeeSeat: 1, amount: rules.points.basePoints + dealerTai * rules.points.perTai },
    ]);
    expect(result.phase.result.nextDealerSeat).toBe(1);
    expect(result.phase.result.nextRepeatCount).toBe(0);
  });
});

// ================================================================================
// 19. Full determinism: kong declaration replay
// ================================================================================

describe('full determinism: kong declaration replay', () => {
  it('two identical startHandFromWall calls with an identical action sequence including a concealed-kong + rob declaration replay to deep-equal states at every step', () => {
    function buildWall(): Wall {
      const seat0Hand = [tile('tong8'), tile('tong8'), tile('tong8'), tile('tong8'), ...fillerTiles(12)];
      const seat1Hand = waitingOnHand('tong8').concealedTiles as Tile[];
      const seat2Hand = deadHandTiles();
      const seat3Hand = deadHandTiles();
      const dealBlock = buildDealBlock(0, [seat0Hand, seat1Hand, seat2Hand, seat3Hand]);
      const openingDraw = tile('wan1');
      return wallOf(...dealBlock, openingDraw, ...fillerTiles(79));
    }

    idCounter = 0;
    const wallA = buildWall();
    idCounter = 0;
    const wallB = buildWall();

    const rules: RulesConfig = { ...DEFAULT_RULES, robKong: { enabled: true, robConcealedKong: true } };
    const startedA = startHandFromWall(wallA, 0, rules, 0, 202);
    const startedB = startHandFromWall(wallB, 0, rules, 0, 202);
    expect(startedA).toEqual(startedB);

    const kind: TileKind = { category: 'suit', suit: 'tong', rank: 8 };
    const declaredA = expectOk(applyAction(startedA, { type: 'declare-concealed-kong', seat: 0, kind }));
    const declaredB = expectOk(applyAction(startedB, { type: 'declare-concealed-kong', seat: 0, kind }));
    expect(declaredA).toEqual(declaredB);

    const resultA = expectOk(applyAction(declaredA, { type: 'declare-rob', seat: 1 }));
    const resultB = expectOk(applyAction(declaredB, { type: 'declare-rob', seat: 1 }));
    expect(resultA).toEqual(resultB);
  });
});
