/**
 * Independent tester verification pass for the kong / robbing-the-kong
 * orchestration wired into game-state.ts (Sub-plan B), additive to
 * game-state.kong.test.ts (builder, 25 tests). This file targets the
 * house-critical robbing-the-kong rule (RULES.md §7) with maximum scrutiny:
 *
 * 1. Pending-concealed-kong precision: the window-skipped path
 *    (robConcealedKong=false) and the window-opened-then-all-pass path
 *    (robConcealedKong=true) must produce a byte-identical resulting meld +
 *    concealed hand, and the window-skip path must never spuriously bar
 *    anyone (no window was ever opened for them).
 * 2. Added-kong revert precision in a multi-meld hand: only the robbed kong
 *    meld reverts (to its exact original 3 tiles, in original order); every
 *    other meld and the remaining concealed tiles are byte-identical to the
 *    pre-kong state.
 * 3. Eligibility filtering at the exact minTaiToWin boundary, combined with a
 *    pre-barred candidate.
 * 4. declare-rob eligibility is the window-open snapshot (eligibleRobbers),
 *    never re-derived from live canWin data.
 * 5. Full determinism of an ADDED-kong + successful-rob sequence (the
 *    builder's own full-determinism test only covers a concealed kong),
 *    checked at every step, not just start/end.
 * 6. Two kongs declared in the same turn: the second kong's rob window must
 *    evaluate against current (unchanged) opponent hands independently of the
 *    first kong's (empty) eligibility, and the final hand must be
 *    structurally exact.
 * 7. Robbed-kong payment-leg exactness, hand-computed independently, across a
 *    dealer-uninvolved and a dealer-involved leg.
 * 8. Tile conservation checked after every individual action (not just
 *    before/after) across both the all-pass and rob outcomes of a
 *    multi-responder window.
 * 9. A sacred-discard bar earned in an earlier, ordinary discard-claim window
 *    correctly excludes that seat from a same-kind added-kong rob window
 *    later in the same hand, driven through the real applyAction sequence
 *    (draw -> discard -> claim-window passes -> next turn -> draw -> kong).
 */

import { describe, expect, it } from 'vitest';
import {
  applyAction,
  isRuleError,
  type GameState,
  type PlayerState,
  type RuleError,
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
import type { PlayerHand, PlayerMeld } from './actions';
import { computeHandTai } from './scoring';
import { DEFAULT_RULES, type RulesConfig } from './rules-config';

// --- Test-local shorthand tile builder (duplicated per-file convention, see
// game-state.kong.test.ts / game-state.test.ts) ---
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
  return { id: `${kindKey(kind)}-krt${idCounter}`, kind };
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
  for (let i = 0; i < count; i++) {
    result.push(tile(FILLER_SPECS[i % FILLER_SPECS.length]));
  }
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

function addedKongReadyHand(spec: string): { hand: PlayerHand; addedTile: Tile } {
  const pungMeld: PlayerMeld = { kind: 'pung', concealed: false, tiles: hand(spec, spec, spec) };
  const addedTile = tile(spec);
  const concealed = [addedTile, ...fillerTiles(13)];
  return { hand: { concealedTiles: concealed, melds: [pungMeld] }, addedTile };
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

function expectRuleErrorCode(result: GameState | RuleError, code: RuleError['code']): void {
  expect(isRuleError(result)).toBe(true);
  if (isRuleError(result)) {
    expect(result.code).toBe(code);
  }
}

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

function winningTileIdOf(state: GameState): string | null {
  if (state.phase.type === 'hand-over' && state.phase.result.kind === 'win') {
    return state.phase.result.winners[0].winningTile.id;
  }
  return null;
}

// ================================================================================
// 1. Pending concealed kong: byte-identical meld across the skipped-window
//    and the opened-then-all-pass window paths.
// ================================================================================

describe('pending concealed kong: byte-identical result across the skipped-window and all-pass-window paths', () => {
  it('robConcealedKong=false (window skipped) and robConcealedKong=true+all-pass (window opened) produce an identical resulting hand; only the latter bars the passer', () => {
    const fourTong8 = [tile('tong8'), tile('tong8'), tile('tong8'), tile('tong8')];
    const filler = fillerTiles(13);
    const concealedKongHand: PlayerHand = { concealedTiles: [...fourTong8, ...filler], melds: [] };
    const kind: TileKind = { category: 'suit', suit: 'tong', rank: 8 };

    // Path A: robConcealedKong=false (default) — the config gate skips the
    // window entirely inside findRobbers, even though seat1 could rob.
    const wallA = wallOf(...fillerTiles(20), tile('wan5'));
    const stateA = stateWith({
      wall: wallA,
      currentTurnSeat: 0,
      phase: { type: 'awaiting-discard', drawnTile: null },
      players: [
        playerStateFromHand(concealedKongHand),
        playerStateFromHand(waitingOnHand('tong8')),
        defaultPlayerState(deadHandTiles()),
        defaultPlayerState(deadHandTiles()),
      ],
    });
    const resultA = expectOk(applyAction(stateA, { type: 'declare-concealed-kong', seat: 0, kind }));
    expect(resultA.phase.type).toBe('awaiting-discard'); // window was skipped
    expect(resultA.players[1].barred).toBe(false); // no window ever opened for them; must not be barred

    // Path B: robConcealedKong=true — the window opens (seat1 eligible), then
    // everyone passes; the meld is formed in resolveRobKongAllPass instead.
    const rulesB: RulesConfig = { ...DEFAULT_RULES, robKong: { enabled: true, robConcealedKong: true } };
    const wallB = wallOf(...fillerTiles(20), tile('wan6'));
    const stateB = stateWith({
      rules: rulesB,
      wall: wallB,
      currentTurnSeat: 0,
      phase: { type: 'awaiting-discard', drawnTile: null },
      players: [
        playerStateFromHand(concealedKongHand),
        playerStateFromHand(waitingOnHand('tong8')),
        defaultPlayerState(deadHandTiles()),
        defaultPlayerState(deadHandTiles()),
      ],
    });
    const declaredB = expectOk(applyAction(stateB, { type: 'declare-concealed-kong', seat: 0, kind }));
    expect(declaredB.phase.type).toBe('awaiting-rob-kong'); // window opened this time
    const resultB = expectOk(applyAction(declaredB, { type: 'pass', seat: 1 }));
    expect(resultB.phase.type).toBe('awaiting-discard');
    expect(resultB.players[1].barred).toBe(true); // eligible-but-declined: barred (§7.2 step 4)

    // Byte-identical resulting meld + concealed hand across both branches
    // (only the wall/replacement tile differs, deliberately excluded here).
    expect(resultA.players[0].hand.melds).toEqual(resultB.players[0].hand.melds);
    expect(resultA.players[0].hand.melds).toHaveLength(1);
    expect(resultA.players[0].hand.melds[0].kind).toBe('kong');
    expect(resultA.players[0].hand.melds[0].concealed).toBe(true);
    // Exactly the original 4 tiles, in their original order — not 3, not 5, no substitution.
    expect(ids(resultA.players[0].hand.melds[0].tiles)).toEqual(ids(fourTong8));
    // Both paths append their own (different-wall) replacement draw as the
    // last concealed tile; everything before that must be exactly `filler`,
    // in order, and identical between the two branches.
    expect(resultA.players[0].hand.concealedTiles).toHaveLength(filler.length + 1);
    expect(resultB.players[0].hand.concealedTiles).toHaveLength(filler.length + 1);
    expect(resultA.players[0].hand.concealedTiles.slice(0, -1).map((t) => t.id)).toEqual(
      filler.map((t) => t.id),
    );
    expect(resultB.players[0].hand.concealedTiles.slice(0, -1).map((t) => t.id)).toEqual(
      filler.map((t) => t.id),
    );
  });
});

// ================================================================================
// 2. Added-kong revert precision in a multi-meld hand.
// ================================================================================

describe('added-kong revert precision: multi-meld hand, byte-identical elsewhere', () => {
  it('reverts only the robbed kong meld, to exactly its original 3 pung tiles in original order; the other meld and remaining concealed tiles are untouched', () => {
    const westPungTiles = hand('west', 'west', 'west');
    const westPungMeld: PlayerMeld = { kind: 'pung', concealed: false, tiles: westPungTiles };
    const tong8PungTiles = hand('tong8', 'tong8', 'tong8');
    const tong8PungMeld: PlayerMeld = { kind: 'pung', concealed: false, tiles: tong8PungTiles };
    const addedTile = tile('tong8');
    const filler = fillerTiles(10); // must-act: 17 - 3*2 = 11 concealed = addedTile + 10 filler
    const preHand: PlayerHand = {
      concealedTiles: [addedTile, ...filler],
      melds: [westPungMeld, tong8PungMeld],
    };

    const wall = wallOf(...fillerTiles(20), tile('wan9'));
    const state = stateWith({
      wall,
      dealerSeat: 2, // neither declarer(0) nor robber(1) — isolate from dealer-tai noise
      currentTurnSeat: 0,
      phase: { type: 'awaiting-discard', drawnTile: null },
      players: [
        playerStateFromHand(preHand),
        playerStateFromHand(waitingOnHand('tong8')),
        defaultPlayerState(deadHandTiles()),
        defaultPlayerState(deadHandTiles()),
      ],
    });

    const declared = expectOk(applyAction(state, { type: 'declare-added-kong', seat: 0, tileId: addedTile.id }));
    expect(declared.phase.type).toBe('awaiting-rob-kong');
    const result = expectOk(applyAction(declared, { type: 'declare-rob', seat: 1 }));
    expect(result.phase.type).toBe('hand-over');

    expect(result.players[0].hand.melds).toHaveLength(2);
    // The west pung: byte-identical, completely untouched by the tong8 kong/rob.
    expect(result.players[0].hand.melds[0]).toEqual(westPungMeld);
    // The tong8 kong reverted to a pung of exactly the original 3 tiles, in original order.
    expect(result.players[0].hand.melds[1].kind).toBe('pung');
    expect(result.players[0].hand.melds[1].concealed).toBe(false);
    expect(ids(result.players[0].hand.melds[1].tiles)).toEqual(ids(tong8PungTiles));
    // Remaining concealed tiles: exactly the original filler, addedTile removed (transferred to the robber), order preserved.
    expect(ids(result.players[0].hand.concealedTiles)).toEqual(ids(filler));
  });
});

// ================================================================================
// 3. Eligibility filtering at the exact minTaiToWin boundary.
// ================================================================================

describe('eligibility filtering: exact minTaiToWin boundary combined with a pre-barred candidate', () => {
  it('minTaiToWin===robKongTai includes the non-barred boundary candidate (the barred one stays excluded); minTaiToWin===robKongTai+1 excludes the sole remaining candidate and skips the window entirely', () => {
    // (a) seat1 barred+eligible-by-hand -> excluded; seat3 eligible-by-hand,
    // not barred, minTaiToWin exactly equals robKongTai -> included.
    const { hand: hA, addedTile: addedTileA } = addedKongReadyHand('tong8');
    const wallA = wallOf(...fillerTiles(20), tile('wan5'));
    const rulesA: RulesConfig = { ...DEFAULT_RULES, minTaiToWin: DEFAULT_RULES.robKongTai };
    const stateA = stateWith({
      rules: rulesA,
      wall: wallA,
      currentTurnSeat: 0,
      phase: { type: 'awaiting-discard', drawnTile: null },
      players: [
        playerStateFromHand(hA),
        { hand: waitingOnHand('tong8'), flowers: [], discards: [], barred: true },
        defaultPlayerState(deadHandTiles()),
        playerStateFromHand(waitingOnHand('tong8')),
      ],
    });
    const resultA = expectOk(applyAction(stateA, { type: 'declare-added-kong', seat: 0, tileId: addedTileA.id }));
    expect(resultA.phase.type).toBe('awaiting-rob-kong');
    if (resultA.phase.type !== 'awaiting-rob-kong') throw new Error('expected awaiting-rob-kong');
    expect(resultA.phase.eligibleRobbers).toEqual([3]); // seat1 excluded (barred), seat3 included (boundary met exactly)

    // (b) Drop the threshold one tai past robKongTai: seat3 (the sole
    // remaining eligible-by-hand candidate, since seat1 is already barred)
    // now also falls below minimum -> the window is skipped entirely and the
    // kong stands immediately.
    const { hand: hB, addedTile: addedTileB } = addedKongReadyHand('tong8');
    const replacementB = tile('wan6');
    const wallB = wallOf(...fillerTiles(20), replacementB);
    const rulesB: RulesConfig = { ...DEFAULT_RULES, minTaiToWin: DEFAULT_RULES.robKongTai + 1 };
    const stateB = stateWith({
      rules: rulesB,
      wall: wallB,
      currentTurnSeat: 0,
      phase: { type: 'awaiting-discard', drawnTile: null },
      players: [
        playerStateFromHand(hB),
        { hand: waitingOnHand('tong8'), flowers: [], discards: [], barred: true },
        defaultPlayerState(deadHandTiles()),
        playerStateFromHand(waitingOnHand('tong8')),
      ],
    });
    const resultB = expectOk(applyAction(stateB, { type: 'declare-added-kong', seat: 0, tileId: addedTileB.id }));
    expect(resultB.phase.type).toBe('awaiting-discard');
    if (resultB.phase.type === 'awaiting-discard') {
      expect(resultB.phase.drawnTile?.id).toBe(replacementB.id);
    }
    expect(resultB.players[0].hand.melds[0].kind).toBe('kong');
    expect(resultB.players[0].hand.melds[0].tiles).toHaveLength(4);
  });
});

// ================================================================================
// 4. declare-rob eligibility is the window-open snapshot, never re-derived.
// ================================================================================

describe('declare-rob eligibility is fixed by the window-open snapshot, not recomputed from live hand data', () => {
  it('rejects declare-rob from a seat holding a genuinely winning hand on kongTile but absent from eligibleRobbers', () => {
    const kongTile = tile('tong8');
    // Declarer's hand as it would genuinely look mid-window: already promoted
    // (declare-added-kong runs promoteAddedKong before opening the window),
    // i.e. an exposed kong meld containing kongTile.
    const declarerHand: PlayerHand = {
      concealedTiles: fillerTiles(13),
      melds: [{ kind: 'kong', concealed: false, tiles: [...hand('tong8', 'tong8', 'tong8'), kongTile] }],
    };
    const state = stateWith({
      currentTurnSeat: 0,
      phase: {
        type: 'awaiting-rob-kong',
        declarerSeat: 0,
        kongTile,
        kongType: 'added',
        pendingConcealedKongTiles: null,
        eligibleRobbers: [1], // seat3 deliberately absent, despite a winning hand below
        responses: {},
      },
      players: [
        playerStateFromHand(declarerHand),
        playerStateFromHand(waitingOnHand('tong8')), // the seat actually named in the snapshot
        defaultPlayerState(deadHandTiles()),
        playerStateFromHand(waitingOnHand('tong8')), // would ALSO legitimately win on kongTile, but excluded from the snapshot
      ],
    });

    // seat3 holds a winning hand on kongTile yet is rejected: eligibility is
    // whatever findRobbers computed at window-open time, never re-derived per response.
    expectRuleErrorCode(applyAction(state, { type: 'declare-rob', seat: 3 }), 'wrong-seat');
    // The declarer itself is obviously never eligible either.
    expectRuleErrorCode(applyAction(state, { type: 'declare-rob', seat: 0 }), 'wrong-seat');
    // The genuinely-listed seat succeeds.
    const result = expectOk(applyAction(state, { type: 'declare-rob', seat: 1 }));
    expect(result.phase.type).toBe('hand-over');
  });
});

// ================================================================================
// 5. Full determinism: added-kong + successful rob, checked at every step.
// ================================================================================

describe('full determinism: added-kong + successful rob replay', () => {
  it('two independently-constructed-but-content-identical states replay an identical declare-added-kong + pass + declare-rob sequence to deep-equal states at every step', () => {
    function buildScenario(): { state: GameState; addedTile: Tile } {
      const { hand: h, addedTile } = addedKongReadyHand('tong8');
      const wall = wallOf(...fillerTiles(20), tile('wan5'));
      const state = stateWith({
        wall,
        dealerSeat: 2,
        repeatCount: 1,
        currentTurnSeat: 0,
        phase: { type: 'awaiting-discard', drawnTile: null },
        players: [
          playerStateFromHand(h),
          playerStateFromHand(waitingOnHand('tong8')),
          defaultPlayerState(deadHandTiles()),
          playerStateFromHand(waitingOnHand('tong8')),
        ],
      });
      return { state, addedTile };
    }

    idCounter = 0;
    const a = buildScenario();
    idCounter = 0;
    const b = buildScenario();
    expect(a.state).toEqual(b.state);
    expect(a.addedTile).toEqual(b.addedTile);

    const declaredA = expectOk(applyAction(a.state, { type: 'declare-added-kong', seat: 0, tileId: a.addedTile.id }));
    const declaredB = expectOk(applyAction(b.state, { type: 'declare-added-kong', seat: 0, tileId: b.addedTile.id }));
    expect(declaredA).toEqual(declaredB);
    if (declaredA.phase.type !== 'awaiting-rob-kong') throw new Error('expected awaiting-rob-kong');
    expect(declaredA.phase.eligibleRobbers).toEqual([1, 3]); // multiple robbers -> proximity tie-break exercised too

    const passedA = expectOk(applyAction(declaredA, { type: 'pass', seat: 3 }));
    const passedB = expectOk(applyAction(declaredB, { type: 'pass', seat: 3 }));
    expect(passedA).toEqual(passedB);

    const resultA = expectOk(applyAction(passedA, { type: 'declare-rob', seat: 1 }));
    const resultB = expectOk(applyAction(passedB, { type: 'declare-rob', seat: 1 }));
    expect(resultA).toEqual(resultB);
    expect(resultA.phase.type).toBe('hand-over');
  });
});

// ================================================================================
// 6. Two kongs in one turn: the second kong's rob window evaluates current
//    opponent hands independently, and the final hand is structurally exact.
// ================================================================================

describe('multiple kongs in one turn: rob window evaluates current opponent hands and reverts precisely', () => {
  it('kong #1 (added, tong8) stands with no rob; kong #2 (added, wan5) on the same turn, using kong #1\'s replacement tile, opens its own rob window and gets robbed', () => {
    const tong8PungTiles = hand('tong8', 'tong8', 'tong8');
    const tong8PungMeld: PlayerMeld = { kind: 'pung', concealed: false, tiles: tong8PungTiles };
    const wan5PungTiles = hand('wan5', 'wan5', 'wan5');
    const wan5PungMeld: PlayerMeld = { kind: 'pung', concealed: false, tiles: wan5PungTiles };
    const addedTile1 = tile('tong8'); // kong #1's 4th tile, already in hand pre-turn
    const filler = fillerTiles(10);
    const preHand: PlayerHand = {
      concealedTiles: [addedTile1, ...filler], // 11 = 17 - 3*2
      melds: [tong8PungMeld, wan5PungMeld],
    };
    const wan5FourthTile = tile('wan5'); // kong #1's replacement draw -> also kong #2's 4th tile
    const wall = wallOf(...fillerTiles(20), wan5FourthTile); // tail: wan5FourthTile drawn first

    const state = stateWith({
      wall,
      dealerSeat: 2,
      currentTurnSeat: 0,
      phase: { type: 'awaiting-discard', drawnTile: null },
      players: [
        playerStateFromHand(preHand),
        playerStateFromHand(waitingOnHand('wan5')), // eligible ONLY for kong #2, not kong #1
        defaultPlayerState(deadHandTiles()),
        defaultPlayerState(deadHandTiles()),
      ],
    });

    // Kong #1: tong8. Opponent (seat1) is not tenpai on tong8 -> no rob; the
    // replacement draw (wan5FourthTile) lands directly in seat0's hand.
    const afterKong1 = expectOk(applyAction(state, { type: 'declare-added-kong', seat: 0, tileId: addedTile1.id }));
    expect(afterKong1.phase.type).toBe('awaiting-discard');
    if (afterKong1.phase.type !== 'awaiting-discard') throw new Error('expected awaiting-discard');
    expect(afterKong1.phase.drawnTile?.id).toBe(wan5FourthTile.id);
    expect(afterKong1.players[0].hand.melds).toHaveLength(2);
    expect(afterKong1.players[0].hand.melds[0]).toEqual({
      kind: 'kong',
      concealed: false,
      tiles: [...tong8PungTiles, addedTile1],
    });
    expect(afterKong1.players[0].hand.melds[1]).toEqual(wan5PungMeld); // untouched by kong #1

    // Kong #2: wan5, using the just-drawn replacement tile. Opponent seat1's
    // hand is unchanged since the start of the turn -> still tenpai on wan5 ->
    // eligible to rob THIS kong specifically (evaluated fresh, not inherited
    // from kong #1's empty eligibility).
    const afterKong2 = expectOk(
      applyAction(afterKong1, { type: 'declare-added-kong', seat: 0, tileId: wan5FourthTile.id }),
    );
    expect(afterKong2.phase.type).toBe('awaiting-rob-kong');
    if (afterKong2.phase.type !== 'awaiting-rob-kong') throw new Error('expected awaiting-rob-kong');
    expect(afterKong2.phase.eligibleRobbers).toEqual([1]);
    expect(afterKong2.players[0].hand.melds).toHaveLength(2); // both kongs now formed (pre-rob)
    expect(afterKong2.players[0].hand.melds[0].tiles).toHaveLength(4); // kong #1, stands, untouched by kong #2
    expect(afterKong2.players[0].hand.melds[1].tiles).toHaveLength(4); // kong #2, just formed, about to be robbed

    const result = expectOk(applyAction(afterKong2, { type: 'declare-rob', seat: 1 }));
    expect(result.phase.type).toBe('hand-over');
    if (result.phase.type !== 'hand-over' || result.phase.result.kind !== 'win') {
      throw new Error('expected a win result');
    }
    expect(result.phase.result.winners[0]).toEqual({
      seat: 1,
      winType: 'robbed-kong',
      handTai: DEFAULT_RULES.robKongTai,
      winningTile: expect.objectContaining({ id: wan5FourthTile.id }),
    });

    // Final structural correctness: kong #1 stands untouched (4 tiles), kong
    // #2 reverted to its original 3-tile pung (exact tiles, exact order), and
    // the declarer's remaining concealed tiles are exactly the original filler.
    expect(result.players[0].hand.melds).toHaveLength(2);
    expect(result.players[0].hand.melds[0]).toEqual({
      kind: 'kong',
      concealed: false,
      tiles: [...tong8PungTiles, addedTile1],
    });
    expect(result.players[0].hand.melds[1]).toEqual({ kind: 'pung', concealed: false, tiles: wan5PungTiles });
    expect(ids(result.players[0].hand.concealedTiles)).toEqual(ids(filler));
  });
});

// ================================================================================
// 7. Robbed-kong payment-leg exactness, hand-computed independently.
// ================================================================================

describe('robbed-kong scoring: exact tai contribution and payment amount', () => {
  it('computeHandTai for winType robbed-kong contributes exactly robKongTai, never selfDrawTai', () => {
    const rules: RulesConfig = { ...DEFAULT_RULES, selfDrawTai: 7, robKongTai: 4 }; // deliberately distinct values
    expect(computeHandTai({ winType: 'robbed-kong' }, rules)).toBe(4);
    expect(computeHandTai({ winType: 'self-draw' }, rules)).toBe(7);
    expect(computeHandTai({ winType: 'discard' }, rules)).toBe(0);
  });

  it('payment amount for a robbed kong with neither declarer nor robber as dealer carries zero dealer tai, hand-computed exactly', () => {
    const { hand: h, addedTile } = addedKongReadyHand('tong8');
    const wall = wallOf(...fillerTiles(20), tile('wan5'));
    const customRules: RulesConfig = {
      ...DEFAULT_RULES,
      robKongTai: 3,
      points: { ...DEFAULT_RULES.points, basePoints: 5, perTai: 2 },
    };
    const state = stateWith({
      rules: customRules,
      wall,
      dealerSeat: 2, // neither declarer(0) nor robber(1)
      repeatCount: 4, // must NOT matter here since the dealer is uninvolved in this leg
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
    // Hand-computed independently: basePoints(5) + robKongTai(3)*pointsPerTai(2) = 11. No dealer tai (dealer is seat2).
    expect(result.phase.result.legs).toEqual([{ payerSeat: 0, payeeSeat: 1, amount: 11 }]);
  });

  it('payment amount for a robbed kong where the declarer (payer) is the dealer carries dealer tai, hand-computed exactly', () => {
    const { hand: h, addedTile } = addedKongReadyHand('tong8');
    const wall = wallOf(...fillerTiles(20), tile('wan5'));
    const customRules: RulesConfig = {
      ...DEFAULT_RULES,
      robKongTai: 3,
      dealerBaseTai: 1,
      dealerRepeatBonusTaiPerRepeat: 2,
      points: { ...DEFAULT_RULES.points, basePoints: 5, perTai: 2 },
    };
    const state = stateWith({
      rules: customRules,
      wall,
      dealerSeat: 0, // declarer(0) is the dealer/payer
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
    // dealerTai = 1 + 2*2 = 5. legTai = robKongTai(3) + dealerTai(5) = 8. amount = basePoints(5) + 8*pointsPerTai(2) = 21.
    expect(result.phase.result.legs).toEqual([{ payerSeat: 0, payeeSeat: 1, amount: 21 }]);
  });
});

// ================================================================================
// 8. Tile conservation checked after every individual action, both outcomes.
// ================================================================================

describe('tile conservation after every individual action in a multi-responder rob window', () => {
  it('conserves all tiles after each step: declare -> pass(one) -> pass(other) [all-pass outcome]', () => {
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
    const before = allTileIdsIn(state).sort();

    const declared = expectOk(applyAction(state, { type: 'declare-added-kong', seat: 0, tileId: addedTile.id }));
    expect(allTileIdsIn(declared).sort()).toEqual(before);

    const afterPass1 = expectOk(applyAction(declared, { type: 'pass', seat: 1 }));
    expect(allTileIdsIn(afterPass1).sort()).toEqual(before);

    const afterPass2 = expectOk(applyAction(afterPass1, { type: 'pass', seat: 3 }));
    expect(allTileIdsIn(afterPass2).sort()).toEqual(before); // replacement draw included, still conserved
  });

  it('conserves all tiles after each step: declare -> pass(one) -> rob(other) [rob outcome]', () => {
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
    const before = allTileIdsIn(state).sort();

    const declared = expectOk(applyAction(state, { type: 'declare-added-kong', seat: 0, tileId: addedTile.id }));
    expect(allTileIdsIn(declared).sort()).toEqual(before);

    const afterPass1 = expectOk(applyAction(declared, { type: 'pass', seat: 1 }));
    expect(allTileIdsIn(afterPass1).sort()).toEqual(before);

    const result = expectOk(applyAction(afterPass1, { type: 'declare-rob', seat: 3 }));
    const winningTileId = winningTileIdOf(result);
    expect(winningTileId).not.toBeNull();
    expect(allTileIdsIn(result).sort()).toEqual(before.filter((id) => id !== winningTileId));
  });
});

// ================================================================================
// 9. Sacred-discard bar carried over from an earlier claim window correctly
//    excludes a later kong-rob candidate.
// ================================================================================

describe('sacred-discard bar carried over from an earlier claim window correctly excludes a later kong-rob candidate', () => {
  it('a seat barred by passing a winning discard claim is excluded from a same-kind added-kong rob window later in the hand, driven through the real action sequence', () => {
    const T = tile('tong8'); // seat3 discards this; seat1 could have won on it but will pass
    const seat3Hand = [...deadHandTiles(), T]; // must-act (17 concealed, 0 melds)
    const pungMeld: PlayerMeld = { kind: 'pung', concealed: false, tiles: hand('tong8', 'tong8', 'tong8') };
    const seat0PreHand: PlayerHand = { concealedTiles: fillerTiles(13), melds: [pungMeld] }; // at-rest: 16-3=13
    const addedTile = tile('tong8'); // seat0 will draw this later, completing kong #1
    const wall = wallOf(addedTile, ...fillerTiles(30)); // head[0] = addedTile

    const state0 = stateWith({
      wall,
      dealerSeat: 0,
      currentTurnSeat: 3,
      phase: { type: 'awaiting-discard', drawnTile: T },
      players: [
        playerStateFromHand(seat0PreHand),
        playerStateFromHand(waitingOnHand('tong8')), // seat1: will pass on T, then get barred
        defaultPlayerState(deadHandTiles()),
        defaultPlayerState(seat3Hand),
      ],
    });

    const discarded = expectOk(applyAction(state0, { type: 'discard', seat: 3, tileId: T.id }));
    expect(discarded.phase.type).toBe('awaiting-claims');

    let s: GameState | RuleError = applyAction(discarded, { type: 'pass', seat: 0 });
    s = expectOk(s);
    s = applyAction(s, { type: 'pass', seat: 1 }); // seat1 could have won on T -> will be barred
    s = expectOk(s);
    const afterClaimWindow = expectOk(applyAction(s, { type: 'pass', seat: 2 }));

    expect(afterClaimWindow.players[1].barred).toBe(true);
    expect(afterClaimWindow.currentTurnSeat).toBe(0); // nextSeat(3) === 0
    expect(afterClaimWindow.phase.type).toBe('awaiting-draw');

    const afterDraw = expectOk(applyAction(afterClaimWindow, { type: 'draw', seat: 0 }));
    expect(afterDraw.phase.type).toBe('awaiting-discard');
    if (afterDraw.phase.type !== 'awaiting-discard') throw new Error('expected awaiting-discard');
    expect(afterDraw.phase.drawnTile?.id).toBe(addedTile.id);
    expect(afterDraw.players[1].barred).toBe(true); // still barred; this was not their own turn

    const afterKong = expectOk(
      applyAction(afterDraw, { type: 'declare-added-kong', seat: 0, tileId: addedTile.id }),
    );
    // seat1 is the only seat structurally eligible to rob tong8 (waitingOnHand),
    // but they remain barred from the earlier claim window -> the rob window
    // is skipped entirely and the kong stands immediately.
    expect(afterKong.phase.type).toBe('awaiting-discard');
    expect(afterKong.players[0].hand.melds).toHaveLength(1);
    expect(afterKong.players[0].hand.melds[0].kind).toBe('kong');
    expect(afterKong.players[0].hand.melds[0].tiles).toHaveLength(4);
    expect(afterKong.players[1].barred).toBe(true); // unaffected by the skipped window
  });
});
