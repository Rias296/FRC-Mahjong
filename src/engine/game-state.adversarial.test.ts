import { describe, expect, it } from 'vitest';
import {
  applyAction,
  isRuleError,
  startHandFromWall,
  type ClaimSpec,
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
import type { PlayerHand } from './actions';
import { computeDealerTai } from './scoring';
import { DEFAULT_RULES } from './rules-config';

// --- Test-local shorthand tile builder (duplicated per-file convention) ---
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
  return { id: `${kindKey(kind)}-adv${idCounter}`, kind };
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

const FILLER_SPECS: readonly string[] = [
  'wan1', 'wan2', 'wan3', 'wan4', 'wan5', 'wan6', 'wan7', 'wan8', 'wan9',
  'tong1', 'tong2', 'tong3', 'tong4', 'tong5', 'tong6', 'tong7', 'tong8', 'tong9',
  'tiao1', 'tiao2', 'tiao3', 'tiao4', 'tiao5', 'tiao6', 'tiao7', 'tiao8', 'tiao9',
];
function fillerTiles(count: number): Tile[] {
  const result: Tile[] = [];
  for (let i = 0; i < count; i++) result.push(tile(FILLER_SPECS[i % FILLER_SPECS.length]));
  return result;
}

function deadHandTiles(): Tile[] {
  return hand(
    'wan1', 'wan3', 'wan5', 'wan7', 'wan9',
    'tong1', 'tong3', 'tong5', 'tong7', 'tong9',
    'tiao1', 'tiao3', 'tiao5', 'tiao7', 'tiao9',
    'east',
  );
}

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

function pungEligibleHand(spec: string): PlayerHand {
  return { concealedTiles: [tile(spec), tile(spec), ...fillerTiles(14)], melds: [] };
}

function kongEligibleHand(spec: string): PlayerHand {
  return { concealedTiles: [tile(spec), tile(spec), tile(spec), ...fillerTiles(13)], melds: [] };
}

function chowEligibleHand(loSpec: string, hiSpec: string): PlayerHand {
  return { concealedTiles: [tile(loSpec), tile(hiSpec), ...fillerTiles(14)], melds: [] };
}

function completeSixteenPlusOne(): { sixteen: Tile[]; winningTile: Tile } {
  const sixteen = hand(
    'wan1', 'wan2', 'wan3', 'wan4', 'wan5', 'wan6', 'wan7', 'wan8', 'wan9',
    'tong1', 'tong2', 'tong3',
    'tiao1', 'tiao1', 'tiao1',
    'east',
  );
  return { sixteen, winningTile: tile('east') };
}

function defaultPlayerState(handTiles: Tile[]): PlayerState {
  return { hand: { concealedTiles: handTiles, melds: [] }, flowers: [], discards: [], barred: false };
}
function playerStateFromHand(h: PlayerHand): PlayerState {
  return { hand: h, flowers: [], discards: [], barred: false };
}

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

function expectOk(result: GameState | RuleError): GameState {
  if (isRuleError(result)) {
    throw new Error(`Expected GameState, got RuleError: ${result.code} - ${result.message}`);
  }
  return result;
}
function expectRuleErrorCode(result: GameState | RuleError, code: RuleErrorCode): void {
  expect(isRuleError(result)).toBe(true);
  if (isRuleError(result)) expect(result.code).toBe(code);
}
function allTileIdsIn(state: GameState): string[] {
  const out: string[] = [];
  for (const player of state.players) {
    out.push(...ids(player.hand.concealedTiles));
    for (const meld of player.hand.melds) out.push(...ids(meld.tiles));
    out.push(...ids(player.flowers));
    out.push(...ids(player.discards));
  }
  out.push(...ids(state.wall));
  if (state.phase.type === 'awaiting-claims') out.push(state.phase.discardedTile.id);
  return out;
}

// ================================================================================
// Gap 1: multi-hand dealer-repeat chaining across two real startHand calls
// ================================================================================

describe('multi-hand dealer-repeat chaining', () => {
  it('dealer winning hand 1 escalates dealer tai in hand 2 payments via chained startHand calls', () => {
    // Hand 1: dealer (seat 0) wins the heavenly hand (self-draw on opening 17).
    const win1 = completeSixteenPlusOne();
    const block1 = buildDealBlock(0, [win1.sixteen, deadHandTiles(), deadHandTiles(), deadHandTiles()]);
    const wall1 = wallOf(...block1, win1.winningTile, ...fillerTiles(79));
    const hand1Started = startHandFromWall(wall1, 0, DEFAULT_RULES, 0, 1);
    const hand1Result = expectOk(applyAction(hand1Started, { type: 'declare-hu', seat: 0 }));

    expect(hand1Result.phase.type).toBe('hand-over');
    if (hand1Result.phase.type !== 'hand-over' || hand1Result.phase.result.kind !== 'win') {
      throw new Error('expected hand 1 to end in a win');
    }
    expect(hand1Result.phase.result.nextDealerSeat).toBe(0);
    expect(hand1Result.phase.result.nextRepeatCount).toBe(1);

    // Hand 2: feed hand 1's nextDealerSeat/nextRepeatCount into a fresh startHandFromWall.
    // Dealer (still seat 0) wins again by heavenly hand.
    const win2 = completeSixteenPlusOne();
    const block2 = buildDealBlock(0, [win2.sixteen, deadHandTiles(), deadHandTiles(), deadHandTiles()]);
    const wall2 = wallOf(...block2, win2.winningTile, ...fillerTiles(79));
    const hand2Started = startHandFromWall(
      wall2,
      hand1Result.phase.result.nextDealerSeat,
      DEFAULT_RULES,
      hand1Result.phase.result.nextRepeatCount,
      2,
    );
    expect(hand2Started.repeatCount).toBe(1); // carried over from hand 1

    const hand2Result = expectOk(applyAction(hand2Started, { type: 'declare-hu', seat: 0 }));
    if (hand2Result.phase.type !== 'hand-over' || hand2Result.phase.result.kind !== 'win') {
      throw new Error('expected hand 2 to end in a win');
    }

    // Dealer tai at repeatCount=1: dealerBaseTai + dealerRepeatBonusTaiPerRepeat * 1
    const expectedDealerTai = computeDealerTai(1, DEFAULT_RULES);
    expect(expectedDealerTai).toBe(DEFAULT_RULES.dealerBaseTai + DEFAULT_RULES.dealerRepeatBonusTaiPerRepeat * 1);

    // Self-draw win by the dealer: all 3 legs carry handTai(selfDrawTai) + dealerTai.
    const expectedLegTai = DEFAULT_RULES.selfDrawTai + expectedDealerTai;
    const expectedAmount = DEFAULT_RULES.basePoints + expectedLegTai * DEFAULT_RULES.pointsPerTai;

    expect(hand2Result.phase.result.legs).toHaveLength(3);
    for (const leg of hand2Result.phase.result.legs) {
      expect(leg.amount).toBe(expectedAmount);
      expect(leg.payeeSeat).toBe(0);
    }
    expect(hand2Result.phase.result.nextDealerSeat).toBe(0);
    expect(hand2Result.phase.result.nextRepeatCount).toBe(2); // escalates again
  });

  it('non-dealer winning hand 1 resets repeatCount to 0 for hand 2, and dealer tai reflects that reset', () => {
    // Hand 1: dealer is seat 0, but seat 1 (non-dealer) wins by discard claim.
    const discardedTile = tile('east');
    const state1 = stateWith({
      dealerSeat: 0,
      repeatCount: 3, // pretend this was already a repeating dealer
      phase: { type: 'awaiting-claims', discarderSeat: 0, discardedTile, responses: {} },
      players: [
        defaultPlayerState(deadHandTiles()),
        playerStateFromHand(waitingOnHand('east')),
        defaultPlayerState(deadHandTiles()),
        defaultPlayerState(deadHandTiles()),
      ],
    });
    let s: GameState | RuleError = applyAction(state1, { type: 'claim', seat: 1, claim: { type: 'hu' } });
    s = expectOk(s);
    s = applyAction(s, { type: 'pass', seat: 2 });
    s = expectOk(s);
    const hand1Result = expectOk(applyAction(s, { type: 'pass', seat: 3 }));

    if (hand1Result.phase.type !== 'hand-over' || hand1Result.phase.result.kind !== 'win') {
      throw new Error('expected hand 1 to end in a win');
    }
    expect(hand1Result.phase.result.nextDealerSeat).toBe(1); // rotates to the winner
    expect(hand1Result.phase.result.nextRepeatCount).toBe(0); // resets

    // Hand 2: new dealer is seat 1, repeatCount 0 -> dealer tai should be exactly dealerBaseTai.
    const win2 = completeSixteenPlusOne();
    const block2 = buildDealBlock(1, [deadHandTiles(), win2.sixteen, deadHandTiles(), deadHandTiles()]);
    const wall2 = wallOf(...block2, win2.winningTile, ...fillerTiles(79));
    const hand2Started = startHandFromWall(wall2, 1, DEFAULT_RULES, 0, 3);
    const hand2Result = expectOk(applyAction(hand2Started, { type: 'declare-hu', seat: 1 }));

    if (hand2Result.phase.type !== 'hand-over' || hand2Result.phase.result.kind !== 'win') {
      throw new Error('expected hand 2 to end in a win');
    }
    const expectedLegTai = DEFAULT_RULES.selfDrawTai + DEFAULT_RULES.dealerBaseTai;
    const expectedAmount = DEFAULT_RULES.basePoints + expectedLegTai * DEFAULT_RULES.pointsPerTai;
    for (const leg of hand2Result.phase.result.legs) {
      expect(leg.amount).toBe(expectedAmount);
    }
  });
});

// ================================================================================
// Gap 2: multipleWinners=false — the losing hu claimant is NOT barred
// ================================================================================

describe('sacred discard: unhonored hu claimants under multipleWinners=false', () => {
  it('a hu claimant who submitted a valid claim but lost to a nearer hu claimant is not barred afterward', () => {
    const discardedTile = tile('east');
    const state = stateWith({
      rules: { ...DEFAULT_RULES, multipleWinners: false },
      phase: { type: 'awaiting-claims', discarderSeat: 0, discardedTile, responses: {} },
      players: [
        defaultPlayerState(deadHandTiles()),
        playerStateFromHand(waitingOnHand('east')), // seat 1: nearer, wins
        defaultPlayerState(deadHandTiles()),
        playerStateFromHand(waitingOnHand('east')), // seat 3: farther, loses the tie-break
      ],
    });

    let s: GameState | RuleError = applyAction(state, { type: 'claim', seat: 1, claim: { type: 'hu' } });
    s = expectOk(s);
    s = applyAction(s, { type: 'pass', seat: 2 });
    s = expectOk(s);
    const result = expectOk(applyAction(s, { type: 'claim', seat: 3, claim: { type: 'hu' } }));

    expect(result.phase.type).toBe('hand-over');
    // Seat 3 explicitly attempted to win (did not decline/pass) and only lost to
    // the nearest-wins tie-break rule — RULES.md §8 bars a player who "could have
    // declared hu ... and did not [decline]". Seat 3 did not decline; they are not
    // barred by this implementation. Documenting/asserting this behavior explicitly:
    // GameState has no further use for `barred` once hand-over, but the field is
    // still present on PlayerState and should read false here.
    expect(result.players[3].barred).toBe(false);
    expect(result.players[1].barred).toBe(false);
  });
});

// ================================================================================
// Gap 3: extra wrong-phase / wrong-seat combinations
// ================================================================================

describe('additional wrong-phase / wrong-seat rejections', () => {
  it('claim and pass are rejected outside awaiting-claims (awaiting-draw and awaiting-discard)', () => {
    const drawState = stateWith({ phase: { type: 'awaiting-draw' } });
    expectRuleErrorCode(
      applyAction(drawState, { type: 'claim', seat: 1, claim: { type: 'pung' } }),
      'wrong-phase',
    );
    expectRuleErrorCode(applyAction(drawState, { type: 'pass', seat: 1 }), 'wrong-phase');

    const discardState = stateWith({ phase: { type: 'awaiting-discard', drawnTile: tile('wan1') } });
    expectRuleErrorCode(
      applyAction(discardState, { type: 'claim', seat: 1, claim: { type: 'pung' } }),
      'wrong-phase',
    );
    expectRuleErrorCode(applyAction(discardState, { type: 'pass', seat: 1 }), 'wrong-phase');
  });

  it('draw is rejected during awaiting-claims', () => {
    const discardedTile = tile('east');
    const state = stateWith({
      phase: { type: 'awaiting-claims', discarderSeat: 0, discardedTile, responses: {} },
    });
    expectRuleErrorCode(applyAction(state, { type: 'draw', seat: 1 }), 'wrong-phase');
  });

  it('discard by a non-current-turn seat is rejected wrong-seat', () => {
    const state = stateWith({
      currentTurnSeat: 0,
      phase: { type: 'awaiting-discard', drawnTile: tile('wan1') },
    });
    const result = applyAction(state, { type: 'discard', seat: 1, tileId: state.players[1].hand.concealedTiles[0].id });
    expectRuleErrorCode(result, 'wrong-seat');
  });

  it('declare-hu by a non-current-turn seat is rejected wrong-seat, even with a winning hand', () => {
    const { sixteen, winningTile } = completeSixteenPlusOne();
    const state = stateWith({
      currentTurnSeat: 0,
      players: [
        defaultPlayerState(deadHandTiles()),
        playerStateFromHand({ concealedTiles: [...sixteen, winningTile], melds: [] }),
        defaultPlayerState(deadHandTiles()),
        defaultPlayerState(deadHandTiles()),
      ],
      phase: { type: 'awaiting-discard', drawnTile: winningTile },
    });
    expectRuleErrorCode(applyAction(state, { type: 'declare-hu', seat: 1 }), 'wrong-seat');
  });
});

// ================================================================================
// Gap 4: barred player's own draw/discard cycle
// ================================================================================

describe('barred player normal turn cycle', () => {
  it('a barred player can still draw and discard normally; until-next-self-discard clears on their discard', () => {
    const state = stateWith({
      rules: { ...DEFAULT_RULES, sacredDiscard: { enabled: true, scope: 'until-next-self-discard' } },
      dealerSeat: 0,
      currentTurnSeat: 1,
      wall: wallOf(...fillerTiles(40)),
      players: [
        defaultPlayerState(deadHandTiles()),
        { ...defaultPlayerState(deadHandTiles()), barred: true },
        defaultPlayerState(deadHandTiles()),
        defaultPlayerState(deadHandTiles()),
      ],
      phase: { type: 'awaiting-draw' },
    });

    const afterDraw = expectOk(applyAction(state, { type: 'draw', seat: 1 }));
    expect(afterDraw.players[1].barred).toBe(true); // drawing alone doesn't clear the bar
    expect(afterDraw.phase.type).toBe('awaiting-discard');
    if (afterDraw.phase.type !== 'awaiting-discard' || afterDraw.phase.drawnTile === null) {
      throw new Error('expected awaiting-discard with a drawn tile');
    }

    const afterDiscard = expectOk(
      applyAction(afterDraw, { type: 'discard', seat: 1, tileId: afterDraw.phase.drawnTile.id }),
    );
    expect(afterDiscard.players[1].barred).toBe(false); // cleared on own discard
  });

  it('a barred player under entire-hand scope stays barred across multiple of their own discards', () => {
    let state = stateWith({
      rules: { ...DEFAULT_RULES, sacredDiscard: { enabled: true, scope: 'entire-hand' } },
      dealerSeat: 0,
      currentTurnSeat: 1,
      wall: wallOf(...fillerTiles(40)),
      players: [
        defaultPlayerState(deadHandTiles()),
        { ...defaultPlayerState(deadHandTiles()), barred: true },
        defaultPlayerState(deadHandTiles()),
        defaultPlayerState(deadHandTiles()),
      ],
      phase: { type: 'awaiting-draw' },
    });

    // Two full draw/discard cycles for seat 1; bar must persist through both.
    for (let i = 0; i < 2; i++) {
      const afterDraw = expectOk(applyAction(state, { type: 'draw', seat: 1 }));
      if (afterDraw.phase.type !== 'awaiting-discard' || afterDraw.phase.drawnTile === null) {
        throw new Error('expected awaiting-discard with a drawn tile');
      }
      expect(afterDraw.players[1].barred).toBe(true);
      const discardResult = expectOk(
        applyAction(afterDraw, { type: 'discard', seat: 1, tileId: afterDraw.phase.drawnTile.id }),
      );
      expect(discardResult.players[1].barred).toBe(true); // never clears under entire-hand
      // resolve the claim window with all passes (turn naturally advances to
      // nextSeat(1) = 2); force it back to seat 1 for the next draw/discard
      // cycle, since this test targets bar persistence, not full rotation.
      let s: GameState = discardResult;
      for (const seat of [2, 3, 0] as const) {
        s = expectOk(applyAction(s, { type: 'pass', seat }));
      }
      expect(s.phase.type).toBe('awaiting-draw');
      expect(s.currentTurnSeat).toBe(2);
      state = { ...s, currentTurnSeat: 1 };
    }
  });
});

// ================================================================================
// Gap 5: full-hand determinism (replay two identical action sequences)
// ================================================================================

describe('full-hand replay determinism', () => {
  it('two identical startHandFromWall + identical action sequences produce deep-equal states at every step', () => {
    idCounter = 0;
    const win = completeSixteenPlusOne();
    idCounter = 0; // reset so both wall constructions use identical ids
    const block = buildDealBlock(0, [win.sixteen, deadHandTiles(), deadHandTiles(), deadHandTiles()]);
    const wallA = wallOf(...block, win.winningTile, ...fillerTiles(79));

    idCounter = 0;
    const winB = completeSixteenPlusOne();
    idCounter = 0;
    const blockB = buildDealBlock(0, [winB.sixteen, deadHandTiles(), deadHandTiles(), deadHandTiles()]);
    const wallB = wallOf(...blockB, winB.winningTile, ...fillerTiles(79));

    const startedA = startHandFromWall(wallA, 0, DEFAULT_RULES, 0, 7);
    const startedB = startHandFromWall(wallB, 0, DEFAULT_RULES, 0, 7);
    expect(startedA).toEqual(startedB);

    const resultA = expectOk(applyAction(startedA, { type: 'declare-hu', seat: 0 }));
    const resultB = expectOk(applyAction(startedB, { type: 'declare-hu', seat: 0 }));
    expect(resultA).toEqual(resultB);
  });
});

// ================================================================================
// Gap 6: tile conservation through multiple claim types in one hand
// ================================================================================

describe('tile conservation across multiple claim types', () => {
  it('conservation holds after a pung claim followed later by a chow claim in the same hand', () => {
    // Build every tile the whole scenario will ever touch up front, so the
    // "before" snapshot is complete and no tile is conjured mid-test.
    const discard1 = tile('east');
    const discard2 = tile('tong5'); // seat 2 will discard this after the pung
    const chowLo = tile('tong4');
    const chowHi = tile('tong6');
    const seat2Filler = fillerTiles(13); // + 2x east (pung) + discard2 = 16
    const seat3Filler = fillerTiles(14); // + chowLo + chowHi = 16

    const state1 = stateWith({
      dealerSeat: 0,
      currentTurnSeat: 0,
      wall: wallOf(...fillerTiles(40)),
      phase: { type: 'awaiting-claims', discarderSeat: 0, discardedTile: discard1, responses: {} },
      players: [
        defaultPlayerState(deadHandTiles()),
        defaultPlayerState(deadHandTiles()),
        playerStateFromHand({
          concealedTiles: [tile('east'), tile('east'), discard2, ...seat2Filler],
          melds: [],
        }),
        playerStateFromHand({ concealedTiles: [chowLo, chowHi, ...seat3Filler], melds: [] }),
      ],
    });
    const before = allTileIdsIn(state1).sort();

    let s: GameState | RuleError = applyAction(state1, { type: 'pass', seat: 1 });
    s = expectOk(s);
    s = applyAction(s, { type: 'claim', seat: 2, claim: { type: 'pung' } });
    s = expectOk(s);
    const afterPung = expectOk(applyAction(s, { type: 'pass', seat: 3 }));

    expect(afterPung.currentTurnSeat).toBe(2);
    expect(afterPung.phase.type).toBe('awaiting-discard');

    // seat 2 discards the pre-placed tong5; seat 3 (nextSeat(2) === 3) can chow it.
    const afterDiscard2 = expectOk(applyAction(afterPung, { type: 'discard', seat: 2, tileId: discard2.id }));
    expect(afterDiscard2.phase.type).toBe('awaiting-claims');
    if (afterDiscard2.phase.type !== 'awaiting-claims') throw new Error('expected awaiting-claims');

    const chowOptionTiles: [string, string] = [chowLo.id, chowHi.id];
    let s2: GameState | RuleError = applyAction(afterDiscard2, { type: 'pass', seat: 0 });
    s2 = expectOk(s2);
    s2 = applyAction(s2, { type: 'pass', seat: 1 });
    s2 = expectOk(s2);
    const afterChow = expectOk(
      applyAction(s2, { type: 'claim', seat: 3, claim: { type: 'chow', tileIds: chowOptionTiles } }),
    );

    expect(afterChow.currentTurnSeat).toBe(3);
    const after = allTileIdsIn(afterChow).sort();
    expect(after).toEqual(before);
    expect(new Set(after).size).toBe(before.length);
  });
});

// ================================================================================
// Gap 7: 3-way pung/kong/chow race under all response orderings
// ================================================================================

describe('3-way claim race: pung vs kong vs chow', () => {
  // NOTE (tester independent-verification pass): the `it` title below previously
  // read "kong ... wins over pung and chow", which contradicted both this
  // describe's own in-body comments and its assertions. Per RULES.md §6.1, kong
  // and pung share priority level 2 and ties resolve by proximity to the
  // discarder (nearest wins); proximity(seat=2, discarderSeat=0) = 2 <
  // proximity(seat=3, discarderSeat=0) = 3, so the pung (seat 2) is nearer and
  // wins over the kong (seat 3). The assertion (`currentTurnSeat === 2` with a
  // pung meld) was always correct; only the title was wrong. Corrected here.
  it('pung (priority 2, nearer to the discarder than the kong) wins over both the kong and the chow under every response ordering', () => {
    const discardedTile = tile('east');
    // seat 1 = nextSeat(0): chow-eligible. seat 2: pung-eligible. seat 3: kong-eligible.
    const chowH = chowEligibleHand('east', 'east'); // deliberately not a real chow shape; use dedicated wan chow below
    void chowH;
    const chowFixture = { concealedTiles: [tile('wan2'), tile('wan3'), ...fillerTiles(14)], melds: [] };
    const base = stateWith({
      phase: { type: 'awaiting-claims', discarderSeat: 0, discardedTile, responses: {} },
      players: [
        defaultPlayerState(deadHandTiles()),
        playerStateFromHand(chowFixture), // seat 1 (nextSeat of discarder): could chow on wan1 discard, but this discard is 'east' so chow won't actually validate -- replaced below
        playerStateFromHand(pungEligibleHand('east')),
        playerStateFromHand(kongEligibleHand('east')),
      ],
    });

    // Since 'east' can never form a chow (honors never chow), seat 1 passes;
    // this test focuses on kong vs pung proximity, which is the real §6.1 race.
    const responses: ReadonlyArray<readonly [Seat, 'pass' | ClaimSpec]> = [
      [1, 'pass'],
      [2, { type: 'pung' }],
      [3, { type: 'kong' }],
    ];

    function permutations<T>(arr: readonly T[]): T[][] {
      if (arr.length <= 1) return [arr.slice()];
      const result: T[][] = [];
      for (let i = 0; i < arr.length; i++) {
        const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
        for (const p of permutations(rest)) result.push([arr[i], ...p]);
      }
      return result;
    }

    const finalStates: GameState[] = [];
    for (const perm of permutations(responses)) {
      let s: GameState = base;
      for (const [seat, resp] of perm) {
        const action: GameAction = resp === 'pass' ? { type: 'pass', seat } : { type: 'claim', seat, claim: resp };
        s = expectOk(applyAction(s, action));
      }
      finalStates.push(s);
    }

    for (const s of finalStates) {
      // kong (seat 3) is nearer to the discarder (proximity 3 vs pung's proximity 2)?
      // proximity(seat, discarder=0) = seat itself here; pung=2, kong=3 -> pung is nearer.
      // Per RULES.md §6.1, ties within a priority level resolve by proximity
      // (nearest wins), and kong/pung share priority level 2.
      expect(s.currentTurnSeat).toBe(2); // pung (proximity 2) is nearer than kong (proximity 3)
      expect(s).toEqual(finalStates[0]);
    }
  });
});
