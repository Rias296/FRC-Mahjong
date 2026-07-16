/**
 * Independent tester verification pass for game-state.ts, additive to
 * game-state.test.ts (39 tests, builder) and game-state.adversarial.test.ts
 * (12 tests, orchestrator). This file targets gaps identified by tracing the
 * two prior test files against docs/RULES.md by hand:
 *
 * 1. Kong-from-discard replacement draw chaining through MULTIPLE flowers,
 *    and through exhaustion mid-chain during a kong's replacement (not a
 *    normal draw) — RULES.md §6.2, §6.3, edge-case-ledger #4.
 * 2. minTaiToWin boundary (non-default value): exactly-equals accepted,
 *    one-below rejected, plus the structural fact that discard-hu handTai is
 *    always 0 in the current (deferred §12) scoring table, so minTaiToWin >= 1
 *    makes discard-hu categorically unwinnable — RULES.md §11.
 * 3. State immutability of resolveClaimWindow's three branches individually
 *    (hu-execution, non-hu-claim-execution for pung/chow/kong-with-flower-
 *    chain, no-claims) — the builder's own immutability test (#28) only
 *    exercises awaiting-discard-phase actions, never the final claim/pass
 *    that triggers window resolution.
 * 4. illegal-claim for pung and kong specifically due to insufficient
 *    matching concealed tiles (as opposed to chow's illegal-claim, already
 *    covered, or kong's no-replacement-available, already covered).
 * 5. sacredDiscard.enabled=false: confirm zero barring across ALL seats,
 *    including that a pre-existing bar on an unrelated seat is left alone.
 * 6. Mid-game `draw` action's flower-chain-into-exhaustion branch (distinct
 *    from the already-tested startHandFromWall opening-draw variant).
 * 7. hu outranks kong (not just pung) on the same discard.
 * 8. multipleWinners=true where the dealer is one of several simultaneous
 *    winners (previously only tested with non-dealer-only claimants).
 */

import { describe, expect, it } from 'vitest';
import {
  applyAction,
  isRuleError,
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
import type { Wall } from './wall';
import type { PlayerHand } from './actions';
import { computeDealerTai } from './scoring';
import { DEFAULT_RULES, type RulesConfig } from './rules-config';

// --- Test-local shorthand tile builder (duplicated per-file convention, see
// game-state.test.ts / game-state.adversarial.test.ts) ---
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
  return { id: `${kindKey(kind)}-tester${idCounter}`, kind };
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

function chowEligibleHand(loSpec: string, hiSpec: string): { hand: PlayerHand; lo: Tile; hi: Tile } {
  const lo = tile(loSpec);
  const hi = tile(hiSpec);
  return { hand: { concealedTiles: [lo, hi, ...fillerTiles(14)], melds: [] }, lo, hi };
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

// ================================================================================
// 1. Kong-from-discard replacement draw: multi-flower chaining and
//    exhaustion mid-chain during the kong's own replacement draw.
// ================================================================================

describe('kong-from-discard replacement draw: flower chaining', () => {
  it('chains through two consecutive flowers before landing on the actual replacement tile', () => {
    const discardedTile = tile('east');
    const finalTile = tile('wan9');
    const flower2 = tile('flower2');
    const flower1 = tile('flower1');
    const headFiller = tile('wan1'); // untouched: only tail draws happen in this scenario
    // Tail order (drawFromTail pops the *last* element first): flower1, then
    // flower2, then finalTile.
    const wall = wallOf(headFiller, finalTile, flower2, flower1);
    const rules: RulesConfig = { ...DEFAULT_RULES, deadWallReserve: 0 };
    const state = stateWith({
      rules,
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
    // Both chained flowers exposed, in exposure order.
    expect(ids(result.players[2].flowers)).toEqual([flower1.id, flower2.id]);
    expect(result.phase.type).toBe('awaiting-discard');
    if (result.phase.type === 'awaiting-discard') {
      expect(result.phase.drawnTile?.id).toBe(finalTile.id);
    }
    expect(result.players[2].hand.concealedTiles.some((t) => t.id === finalTile.id)).toBe(true);
    expect(result.wall).toEqual([headFiller]);
    expect(result.currentTurnSeat).toBe(2);
  });

  it('a flower chain that hits the reserve mid-chain during a KONG replacement ends the hand immediately, kong meld intact, no discard', () => {
    const discardedTile = tile('east');
    const flower1 = tile('flower1');
    const headFiller = tile('wan1');
    // remaining before the claim = 2 (> reserve 1, so the kong itself is
    // legal); the first tail draw (flower1) succeeds, but the second tail
    // draw attempt is blocked by the reserve.
    const wall = wallOf(headFiller, flower1);
    const rules: RulesConfig = { ...DEFAULT_RULES, deadWallReserve: 1 };
    const state = stateWith({
      rules,
      wall,
      dealerSeat: 0,
      repeatCount: 2,
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

    expect(result.phase.type).toBe('hand-over');
    if (result.phase.type === 'hand-over') {
      expect(result.phase.result.kind).toBe('exhaustive-draw');
      expect(result.phase.result.nextDealerSeat).toBe(0); // dealerRepeatsOnDraw defaults true
      expect(result.phase.result.nextRepeatCount).toBe(3);
    }
    // The kong meld was already formed before the blocked replacement draw
    // was attempted, and RULES.md's edge-case ledger #1 says the flower stays
    // exposed with no discard on this exhaustion path.
    expect(result.players[2].hand.melds).toHaveLength(1);
    expect(result.players[2].hand.melds[0].kind).toBe('kong');
    expect(ids(result.players[2].flowers)).toEqual([flower1.id]);
    expect(result.wall).toEqual([headFiller]);
  });
});

// ================================================================================
// 2. minTaiToWin boundary (non-default value)
// ================================================================================

describe('minTaiToWin boundary at a non-default value', () => {
  it('self-draw hu is accepted when handTai exactly equals minTaiToWin', () => {
    const { sixteen, winningTile } = completeSixteenPlusOne();
    const rules: RulesConfig = { ...DEFAULT_RULES, minTaiToWin: 1 }; // selfDrawTai default 1 === 1
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
    const result = expectOk(applyAction(state, { type: 'declare-hu', seat: 0 }));
    expect(result.phase.type).toBe('hand-over');
    if (result.phase.type === 'hand-over' && result.phase.result.kind === 'win') {
      expect(result.phase.result.winners[0].handTai).toBe(1);
    } else {
      throw new Error('expected a win result');
    }
  });

  it('self-draw hu is rejected when handTai is exactly one below minTaiToWin', () => {
    const { sixteen, winningTile } = completeSixteenPlusOne();
    const rules: RulesConfig = { ...DEFAULT_RULES, minTaiToWin: 2 }; // selfDrawTai default 1 === 2 - 1
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

  it('discard-hu handTai is structurally always 0 (only selfDraw/robKong tai slots have real values today): ' +
    'succeeds at minTaiToWin=0, is rejected at minTaiToWin=1 even for a genuinely complete hand', () => {
    const zeroRules: RulesConfig = { ...DEFAULT_RULES, minTaiToWin: 0 };
    const stateZero = stateWith({
      rules: zeroRules,
      phase: { type: 'awaiting-claims', discarderSeat: 0, discardedTile: tile('east'), responses: {} },
      players: [
        defaultPlayerState(deadHandTiles()),
        playerStateFromHand(waitingOnHand('east')),
        defaultPlayerState(deadHandTiles()),
        defaultPlayerState(deadHandTiles()),
      ],
    });
    const acceptedClaim = expectOk(applyAction(stateZero, { type: 'claim', seat: 1, claim: { type: 'hu' } }));
    expect(acceptedClaim.phase.type).toBe('awaiting-claims'); // claim recorded, window still collecting (1 of 3)
    if (acceptedClaim.phase.type === 'awaiting-claims') {
      expect(acceptedClaim.phase.responses[1]).toEqual({ type: 'hu', seat: 1 });
    }

    const oneRules: RulesConfig = { ...DEFAULT_RULES, minTaiToWin: 1 };
    const stateOne = stateWith({
      rules: oneRules,
      phase: { type: 'awaiting-claims', discarderSeat: 0, discardedTile: tile('east'), responses: {} },
      players: [
        defaultPlayerState(deadHandTiles()),
        playerStateFromHand(waitingOnHand('east')),
        defaultPlayerState(deadHandTiles()),
        defaultPlayerState(deadHandTiles()),
      ],
    });
    const rejectedClaim = applyAction(stateOne, { type: 'claim', seat: 1, claim: { type: 'hu' } });
    expectRuleErrorCode(rejectedClaim, 'below-minimum-tai');
  });
});

// ================================================================================
// 3. resolveClaimWindow immutability, per branch
// ================================================================================

describe('resolveClaimWindow immutability per branch', () => {
  it('does not mutate the penultimate state when the final response triggers a hu-claim resolution', () => {
    const discardedTile = tile('east');
    const state = stateWith({
      phase: { type: 'awaiting-claims', discarderSeat: 0, discardedTile, responses: {} },
      players: [
        defaultPlayerState(deadHandTiles()),
        playerStateFromHand(waitingOnHand('east')),
        defaultPlayerState(deadHandTiles()),
        defaultPlayerState(deadHandTiles()),
      ],
    });
    let s: GameState | RuleError = applyAction(state, { type: 'claim', seat: 1, claim: { type: 'hu' } });
    s = expectOk(s);
    s = applyAction(s, { type: 'pass', seat: 2 });
    const penultimate = expectOk(s);
    const snapshot = JSON.parse(JSON.stringify(penultimate)) as GameState;

    applyAction(penultimate, { type: 'pass', seat: 3 }); // triggers resolveHuClaims

    expect(penultimate).toEqual(snapshot);
  });

  it('does not mutate the penultimate state when the final response triggers a pung-claim resolution', () => {
    const discardedTile = tile('east');
    const state = stateWith({
      phase: { type: 'awaiting-claims', discarderSeat: 0, discardedTile, responses: {} },
      players: [
        defaultPlayerState(deadHandTiles()),
        defaultPlayerState(deadHandTiles()),
        playerStateFromHand(pungEligibleHand('east')),
        defaultPlayerState(deadHandTiles()),
      ],
    });
    let s: GameState | RuleError = applyAction(state, { type: 'pass', seat: 1 });
    s = expectOk(s);
    s = applyAction(s, { type: 'claim', seat: 2, claim: { type: 'pung' } });
    const penultimate = expectOk(s);
    const snapshot = JSON.parse(JSON.stringify(penultimate)) as GameState;

    applyAction(penultimate, { type: 'pass', seat: 3 }); // triggers resolveNonHuClaim (pung branch)

    expect(penultimate).toEqual(snapshot);
  });

  it('does not mutate the penultimate state when the final response triggers a chow-claim resolution', () => {
    const discardedTile = tile('tong5');
    const chow = chowEligibleHand('tong4', 'tong6');
    const state = stateWith({
      phase: { type: 'awaiting-claims', discarderSeat: 0, discardedTile, responses: {} },
      players: [
        defaultPlayerState(deadHandTiles()),
        playerStateFromHand(chow.hand),
        defaultPlayerState(deadHandTiles()),
        defaultPlayerState(deadHandTiles()),
      ],
    });
    let s: GameState | RuleError = applyAction(state, { type: 'pass', seat: 2 });
    s = expectOk(s);
    s = applyAction(s, {
      type: 'claim',
      seat: 1,
      claim: { type: 'chow', tileIds: [chow.lo.id, chow.hi.id] },
    });
    const penultimate = expectOk(s);
    const snapshot = JSON.parse(JSON.stringify(penultimate)) as GameState;

    applyAction(penultimate, { type: 'pass', seat: 3 }); // triggers resolveNonHuClaim (chow branch)

    expect(penultimate).toEqual(snapshot);
  });

  it('does not mutate the penultimate state when the final response triggers a kong-from-discard resolution with a flower-chained replacement', () => {
    const discardedTile = tile('east');
    const flower1 = tile('flower1');
    const finalTile = tile('wan9');
    const headFiller = tile('wan1');
    const wall = wallOf(headFiller, finalTile, flower1);
    const rules: RulesConfig = { ...DEFAULT_RULES, deadWallReserve: 0 };
    const state = stateWith({
      rules,
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
    const penultimate = expectOk(s);
    const snapshot = JSON.parse(JSON.stringify(penultimate)) as GameState;

    applyAction(penultimate, { type: 'pass', seat: 3 }); // triggers resolveNonHuClaim (kong-from-discard + flower chain)

    expect(penultimate).toEqual(snapshot);
  });

  it('does not mutate the penultimate state when the final response triggers no-claims resolution', () => {
    const discardedTile = tile('east');
    const state = stateWith({
      phase: { type: 'awaiting-claims', discarderSeat: 0, discardedTile, responses: {} },
    });
    let s: GameState | RuleError = applyAction(state, { type: 'pass', seat: 1 });
    s = expectOk(s);
    s = applyAction(s, { type: 'pass', seat: 2 });
    const penultimate = expectOk(s);
    const snapshot = JSON.parse(JSON.stringify(penultimate)) as GameState;

    applyAction(penultimate, { type: 'pass', seat: 3 }); // triggers resolveNoClaims

    expect(penultimate).toEqual(snapshot);
  });
});

// ================================================================================
// 4. illegal-claim for pung / kong due to insufficient matching concealed tiles
// ================================================================================

describe('illegal-claim rejections for pung and kong (insufficient concealed tiles)', () => {
  it('pung claim rejected illegal-claim when the claimant holds fewer than 2 matching concealed tiles', () => {
    const discardedTile = tile('east');
    const state = stateWith({
      phase: { type: 'awaiting-claims', discarderSeat: 0, discardedTile, responses: {} },
      players: [
        defaultPlayerState(deadHandTiles()),
        defaultPlayerState(deadHandTiles()), // exactly one 'east' concealed: insufficient for pung
        defaultPlayerState(deadHandTiles()),
        defaultPlayerState(deadHandTiles()),
      ],
    });
    const result = applyAction(state, { type: 'claim', seat: 1, claim: { type: 'pung' } });
    expectRuleErrorCode(result, 'illegal-claim');
  });

  it('kong claim rejected illegal-claim (distinct from no-replacement-available) when the claimant holds only 2 matching concealed tiles', () => {
    const discardedTile = tile('east');
    const state = stateWith({
      wall: wallOf(...fillerTiles(40)), // ample wall: this must NOT be a reserve rejection
      phase: { type: 'awaiting-claims', discarderSeat: 0, discardedTile, responses: {} },
      players: [
        defaultPlayerState(deadHandTiles()),
        playerStateFromHand(pungEligibleHand('east')), // only 2 concealed 'east', not 3
        defaultPlayerState(deadHandTiles()),
        defaultPlayerState(deadHandTiles()),
      ],
    });
    const result = applyAction(state, { type: 'claim', seat: 1, claim: { type: 'kong' } });
    expectRuleErrorCode(result, 'illegal-claim');
  });
});

// ================================================================================
// 5. sacredDiscard.enabled=false: zero barring across ALL seats, including a
//    pre-existing bar on an unrelated seat left untouched.
// ================================================================================

describe('sacredDiscard.enabled=false leaves every barred flag untouched', () => {
  it('no barred flags change: a seat that could have won stays unbarred, and a pre-existing bar on another seat is neither cleared nor altered', () => {
    const discardedTile = tile('east');
    const rules: RulesConfig = { ...DEFAULT_RULES, sacredDiscard: { enabled: false, scope: 'until-next-self-discard' } };
    const state = stateWith({
      rules,
      phase: { type: 'awaiting-claims', discarderSeat: 0, discardedTile, responses: {} },
      players: [
        defaultPlayerState(deadHandTiles()),
        playerStateFromHand(waitingOnHand('east')), // could have won; rule disabled, must not bar
        { ...defaultPlayerState(deadHandTiles()), barred: true }, // pre-existing, unrelated bar
        defaultPlayerState(deadHandTiles()),
      ],
    });

    let s: GameState | RuleError = applyAction(state, { type: 'pass', seat: 1 });
    s = expectOk(s);
    s = applyAction(s, { type: 'pass', seat: 2 });
    s = expectOk(s);
    const result = expectOk(applyAction(s, { type: 'pass', seat: 3 }));

    expect(result.players[0].barred).toBe(false);
    expect(result.players[1].barred).toBe(false);
    expect(result.players[2].barred).toBe(true); // untouched, not spuriously cleared
    expect(result.players[3].barred).toBe(false);
  });
});

// ================================================================================
// 6. Mid-game `draw` action: flower-chain hitting the reserve ends the hand
//    immediately (distinct from the startHandFromWall opening-draw variant,
//    which is the only flower-into-exhaustion path the prior two files test).
// ================================================================================

describe('mid-game draw: flower-chain hitting the reserve ends the hand immediately', () => {
  it('a flower drawn mid-turn with no legal replacement ends the hand in a draw; the flower stays exposed and the hand never grows to 17', () => {
    const flower1 = tile('flower1');
    const rules: RulesConfig = { ...DEFAULT_RULES, deadWallReserve: 0 };
    const wall = wallOf(flower1); // the sole head draw is itself a flower; reserve(0) blocks any tail draw
    const state = stateWith({
      rules,
      wall,
      dealerSeat: 0,
      currentTurnSeat: 1,
      repeatCount: 1,
      phase: { type: 'awaiting-draw' },
    });

    const result = expectOk(applyAction(state, { type: 'draw', seat: 1 }));

    expect(result.phase.type).toBe('hand-over');
    if (result.phase.type === 'hand-over') {
      expect(result.phase.result.kind).toBe('exhaustive-draw');
      expect(result.phase.result.nextDealerSeat).toBe(0);
      expect(result.phase.result.nextRepeatCount).toBe(2);
    }
    expect(ids(result.players[1].flowers)).toEqual([flower1.id]);
    expect(result.players[1].hand.concealedTiles).toHaveLength(16); // flower never entered the concealed hand
    expect(result.wall).toEqual([]);
  });
});

// ================================================================================
// 7. hu also outranks kong (not just pung) on the same discard
// ================================================================================

describe('claim priority: hu outranks a simultaneous kong claim', () => {
  it('hu claim wins over a kong claim on the same discard', () => {
    const discardedTile = tile('east');
    const state = stateWith({
      phase: { type: 'awaiting-claims', discarderSeat: 0, discardedTile, responses: {} },
      players: [
        defaultPlayerState(deadHandTiles()),
        playerStateFromHand(waitingOnHand('east')),
        defaultPlayerState(deadHandTiles()),
        playerStateFromHand(kongEligibleHand('east')),
      ],
    });
    let s: GameState | RuleError = applyAction(state, { type: 'claim', seat: 1, claim: { type: 'hu' } });
    s = expectOk(s);
    s = applyAction(s, { type: 'pass', seat: 2 });
    s = expectOk(s);
    s = applyAction(s, { type: 'claim', seat: 3, claim: { type: 'kong' } });
    const result = expectOk(s);
    expect(result.phase.type).toBe('hand-over');
    if (result.phase.type === 'hand-over' && result.phase.result.kind === 'win') {
      expect(result.phase.result.winners).toHaveLength(1);
      expect(result.phase.result.winners[0].seat).toBe(1);
    } else {
      throw new Error('expected a win result');
    }
  });
});

// ================================================================================
// 8. multipleWinners=true where the dealer is one of several simultaneous
//    winners (previously untested combination: the builder's existing
//    multipleWinners test always had the dealer as the discarder, so the
//    dealer never appeared among the winners themselves).
// ================================================================================

describe('multipleWinners=true with the dealer as one of several winners', () => {
  it('dealer among multiple hu winners repeats, and only the dealer-involved leg carries dealer tai', () => {
    const discardedTile = tile('east');
    const rules: RulesConfig = { ...DEFAULT_RULES, multipleWinners: true };
    const state = stateWith({
      rules,
      dealerSeat: 0,
      repeatCount: 0,
      phase: { type: 'awaiting-claims', discarderSeat: 1, discardedTile, responses: {} },
      players: [
        playerStateFromHand(waitingOnHand('east')), // seat 0 = dealer, a winner
        defaultPlayerState(deadHandTiles()), // discarder
        playerStateFromHand(waitingOnHand('east')), // seat 2, another winner
        defaultPlayerState(deadHandTiles()),
      ],
    });

    let s: GameState | RuleError = applyAction(state, { type: 'claim', seat: 0, claim: { type: 'hu' } });
    s = expectOk(s);
    s = applyAction(s, { type: 'claim', seat: 2, claim: { type: 'hu' } });
    s = expectOk(s);
    const result = expectOk(applyAction(s, { type: 'pass', seat: 3 }));

    expect(result.phase.type).toBe('hand-over');
    if (result.phase.type !== 'hand-over' || result.phase.result.kind !== 'win') {
      throw new Error('expected a win result');
    }
    expect(result.phase.result.winners.map((w) => w.seat).sort()).toEqual([0, 2]);
    expect(result.phase.result.nextDealerSeat).toBe(0); // dealer was among the winners -> repeats
    expect(result.phase.result.nextRepeatCount).toBe(1);

    const dealerTai = computeDealerTai(0, rules);
    const legToDealer = result.phase.result.legs.find((l) => l.payeeSeat === 0);
    const legToSeat2 = result.phase.result.legs.find((l) => l.payeeSeat === 2);
    expect(legToDealer?.amount).toBe(rules.points.basePoints + dealerTai * rules.points.perTai);
    expect(legToSeat2?.amount).toBe(rules.points.basePoints); // neither payer(1) nor winner(2) is the dealer
  });
});
