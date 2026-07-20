import { describe, expect, it } from 'vitest';
import { chooseAiAction } from './choose-action';
import type { GameState, Phase } from '../game-state';
import {
  kindKey,
  type DragonName,
  type FlowerNumber,
  type Rank,
  type SuitName,
  type Tile,
  type TileKind,
  type WindName,
} from '../tiles';
import type { PlayerHand, PlayerMeld } from '../actions';
import { DEFAULT_RULES, type RulesConfig } from '../rules-config';
import type { Seat } from '../seats';

// --- Test-local shorthand tile builder (duplicated per-file convention, see game-state.test.ts / rob-kong.test.ts) ---
// Suit tiles: 'wan1'..'wan9', 'tong1'..'tong9', 'tiao1'..'tiao9'.
// Honors: 'east' | 'south' | 'west' | 'north' | 'red' | 'green' | 'white'.
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

function meld(kind: 'chow' | 'pung' | 'kong', concealed: boolean, ...specs: string[]): PlayerMeld {
  return { kind, concealed, tiles: hand(...specs) };
}

function playerHand(concealedTiles: readonly Tile[], melds: readonly PlayerMeld[] = []): PlayerHand {
  return { concealedTiles, melds };
}

interface PlayerStateLike {
  readonly hand: PlayerHand;
  readonly flowers: readonly Tile[];
  readonly discards: readonly Tile[];
  readonly barred: boolean;
}

function playerState(h: PlayerHand, barred = false): PlayerStateLike {
  return { hand: h, flowers: [], discards: [], barred };
}

function deadHandTiles(): Tile[] {
  // Sparse: every kind distinct, suit ranks gapped by 2 — structurally can
  // never wait on anything (see shape.test.ts's hasTenpaiDiscard false fixture).
  return hand(
    'wan1', 'wan3', 'wan5', 'wan7', 'wan9',
    'tong1', 'tong3', 'tong5', 'tong7', 'tong9',
    'tiao1', 'tiao3', 'tiao5', 'tiao7', 'tiao9',
    'east',
  );
}

function fillerWall(count: number): Tile[] {
  const specs = ['wan2', 'wan4', 'wan6', 'wan8', 'tong2', 'tong4', 'tong6', 'tong8'];
  const out: Tile[] = [];
  for (let i = 0; i < count; i++) {
    out.push(tile(specs[i % specs.length]));
  }
  return out;
}

function stateWith(overrides: Partial<GameState> & { players: readonly [PlayerStateLike, PlayerStateLike, PlayerStateLike, PlayerStateLike] }): GameState {
  const base = {
    seed: 1,
    rules: DEFAULT_RULES,
    dealerSeat: 0 as Seat,
    repeatCount: 0,
    wall: fillerWall(30),
    currentTurnSeat: 0 as Seat,
    phase: { type: 'awaiting-draw' } as Phase,
  };
  return { ...base, ...overrides } as GameState;
}

function fourDeadPlayers(): [PlayerStateLike, PlayerStateLike, PlayerStateLike, PlayerStateLike] {
  return [
    playerState(playerHand(deadHandTiles())),
    playerState(playerHand(deadHandTiles())),
    playerState(playerHand(deadHandTiles())),
    playerState(playerHand(deadHandTiles())),
  ];
}

function withPlayer(players: readonly [PlayerStateLike, PlayerStateLike, PlayerStateLike, PlayerStateLike], seat: Seat, p: PlayerStateLike): [PlayerStateLike, PlayerStateLike, PlayerStateLike, PlayerStateLike] {
  const next: [PlayerStateLike, PlayerStateLike, PlayerStateLike, PlayerStateLike] = [...players];
  next[seat] = p;
  return next;
}

// ================================================================================
// Structural "no open decision" cases
// ================================================================================

describe('chooseAiAction: no open decision', () => {
  it('returns null for hand-over', () => {
    const state = stateWith({
      players: fourDeadPlayers(),
      phase: {
        type: 'hand-over',
        result: { kind: 'exhaustive-draw', nextDealerSeat: 1, nextRepeatCount: 0 },
      },
    });
    expect(chooseAiAction(state, 0)).toBeNull();
  });

  it('returns null for a seat whose own turn it is not (awaiting-discard)', () => {
    const state = stateWith({
      players: fourDeadPlayers(),
      currentTurnSeat: 0,
      phase: { type: 'awaiting-discard', drawnTile: null },
    });
    expect(chooseAiAction(state, 1)).toBeNull();
  });

  it('returns null for a seat whose own turn it is not (awaiting-draw)', () => {
    const state = stateWith({ players: fourDeadPlayers(), currentTurnSeat: 2, phase: { type: 'awaiting-draw' } });
    expect(chooseAiAction(state, 0)).toBeNull();
  });

  it('returns the forced draw action for the current turn seat in awaiting-draw', () => {
    const state = stateWith({ players: fourDeadPlayers(), currentTurnSeat: 2, phase: { type: 'awaiting-draw' } });
    const decision = chooseAiAction(state, 2);
    expect(decision).not.toBeNull();
    expect(decision?.action).toEqual({ type: 'draw', seat: 2 });
    expect(decision?.reasoning.length).toBeGreaterThan(0);
  });

  it('returns null for a claim-window seat already present in phase.responses', () => {
    const discardedTile = tile('east');
    const state = stateWith({
      players: fourDeadPlayers(),
      phase: {
        type: 'awaiting-claims',
        discarderSeat: 0,
        discardedTile,
        responses: { 1: 'pass' },
      },
    });
    expect(chooseAiAction(state, 1)).toBeNull();
  });

  it('returns null for the discarder seat itself in the claim window', () => {
    const discardedTile = tile('east');
    const state = stateWith({
      players: fourDeadPlayers(),
      phase: { type: 'awaiting-claims', discarderSeat: 0, discardedTile, responses: {} },
    });
    expect(chooseAiAction(state, 0)).toBeNull();
  });
});

// ================================================================================
// Own turn (awaiting-discard)
// ================================================================================

describe('chooseAiAction: own turn', () => {
  it('self-draw hu is chosen when the drawn tile completes the hand and meets minTaiToWin', () => {
    // NOTE: a self-draw hu and an own-turn kong (concealed or added) can
    // never BOTH be legal on the exact same must-act hand snapshot — a valid
    // win decomposition always consumes every concealed tile with zero
    // leftover (hand.ts's findDecomposition never emits a 4-of-a-kind
    // grouping), while kong eligibility always requires exactly such a
    // leftover (an unconsumed 4th copy). This test verifies hu fires
    // whenever legal; the priority-order is enforced by chooseOwnTurnAction
    // checking hu (step 1) unconditionally before ever inspecting kong
        // eligibility (steps 2-3) — see choose-action.ts.
    const sixteen = hand(
      'wan1', 'wan2', 'wan3', 'wan4', 'wan5', 'wan6', 'wan7', 'wan8', 'wan9',
      'tong1', 'tong2', 'tong3',
      'tiao1', 'tiao1', 'tiao1',
      'east',
    );
    const winningTile = tile('east');
    const state = stateWith({
      currentTurnSeat: 0,
      phase: { type: 'awaiting-discard', drawnTile: winningTile },
      players: withPlayer(fourDeadPlayers(), 0, playerState(playerHand([...sixteen, winningTile]))),
    });
    const decision = chooseAiAction(state, 0);
    expect(decision?.action).toEqual({ type: 'declare-hu', seat: 0 });
  });

  it('does not declare hu when drawnTile is null (post chow/pung claim turn)', () => {
    const state = stateWith({
      currentTurnSeat: 0,
      phase: { type: 'awaiting-discard', drawnTile: null },
      players: withPlayer(fourDeadPlayers(), 0, playerState(playerHand([...deadHandTiles(), tile('wan2')]))),
    });
    const decision = chooseAiAction(state, 0);
    expect(decision?.action.type).toBe('discard');
  });

  it('discards the least-connected tile when no hu/kong applies', () => {
    // 16 dead tiles + 1 isolated 'south' (the 17th, must-act) — 'south' has
    // no duplicates/neighbors and neither does anything else, so this is
    // exercising the plain discard fallback path.
    const seventeen = [...deadHandTiles(), tile('south')];
    const state = stateWith({
      currentTurnSeat: 0,
      phase: { type: 'awaiting-discard', drawnTile: seventeen[16] },
      players: withPlayer(fourDeadPlayers(), 0, playerState(playerHand(seventeen))),
    });
    const decision = chooseAiAction(state, 0);
    expect(decision).not.toBeNull();
    const action = decision?.action;
    expect(action?.type).toBe('discard');
    if (action !== undefined && action.type === 'discard') {
      expect(seventeen.some((t) => t.id === action.tileId)).toBe(true);
    }
  });

  describe('concealed kong safety', () => {
    it('declines a concealed kong that would break the hand\'s current tenpai wait', () => {
      const preKong17 = hand(
        'wan5', 'wan5', 'wan5', 'wan5',
        'wan4', 'wan4', 'wan6', 'wan6',
        'tong1', 'tong2', 'tong3',
        'tiao1', 'tiao1', 'tiao1',
        'red', 'red',
        'green',
      );
      const state = stateWith({
        currentTurnSeat: 0,
        phase: { type: 'awaiting-discard', drawnTile: preKong17[preKong17.length - 1] },
        players: withPlayer(fourDeadPlayers(), 0, playerState(playerHand(preKong17))),
      });
      const decision = chooseAiAction(state, 0);
      expect(decision?.action.type).not.toBe('declare-concealed-kong');
    });

    it('accepts a concealed kong that preserves the wait', () => {
      const preKong17 = hand(
        'north', 'north', 'north', 'north',
        'tong1', 'tong2', 'tong3',
        'tiao1', 'tiao1', 'tiao1',
        'red', 'red', 'red',
        'green', 'green', 'green',
        'wan9',
      );
      const state = stateWith({
        currentTurnSeat: 0,
        phase: { type: 'awaiting-discard', drawnTile: preKong17[preKong17.length - 1] },
        players: withPlayer(fourDeadPlayers(), 0, playerState(playerHand(preKong17))),
      });
      const decision = chooseAiAction(state, 0);
      expect(decision?.action).toEqual({
        type: 'declare-concealed-kong',
        seat: 0,
        kind: kindFromSpec('north'),
      });
    });

    it('accepts a concealed kong when the hand was not tenpai to begin with (nothing to protect)', () => {
      const preKong17 = hand(
        'north', 'north', 'north', 'north',
        'wan1', 'wan3', 'wan5', 'wan7', 'wan9',
        'tong1', 'tong3', 'tong5', 'tong7', 'tong9',
        'tiao1', 'tiao3', 'tiao5',
      );
      const state = stateWith({
        currentTurnSeat: 0,
        phase: { type: 'awaiting-discard', drawnTile: preKong17[preKong17.length - 1] },
        players: withPlayer(fourDeadPlayers(), 0, playerState(playerHand(preKong17))),
      });
      const decision = chooseAiAction(state, 0);
      expect(decision?.action).toEqual({
        type: 'declare-concealed-kong',
        seat: 0,
        kind: kindFromSpec('north'),
      });
    });
  });

  describe('added kong safety', () => {
    it('declines an added kong that would break the hand\'s current tenpai wait', () => {
      const extraWan5 = tile('wan5');
      const concealed14 = [
        extraWan5,
        ...hand(
          'wan4', 'wan6',
          'tong1', 'tong2', 'tong3',
          'tiao1', 'tiao1', 'tiao1',
          'red', 'red', 'red',
          'green', 'north',
        ),
      ];
      const existingPung = meld('pung', false, 'wan5', 'wan5', 'wan5');
      const state = stateWith({
        currentTurnSeat: 0,
        phase: { type: 'awaiting-discard', drawnTile: concealed14[concealed14.length - 1] },
        players: withPlayer(fourDeadPlayers(), 0, playerState(playerHand(concealed14, [existingPung]))),
      });
      const decision = chooseAiAction(state, 0);
      expect(decision?.action.type).not.toBe('declare-added-kong');
    });

    it('accepts an added kong that preserves the wait', () => {
      const extraGreen = tile('green');
      const concealed14 = [
        extraGreen,
        ...hand(
          'tong1', 'tong2', 'tong3',
          'tiao1', 'tiao1', 'tiao1',
          'red', 'red', 'red',
          'north', 'north', 'north',
          'wan9',
        ),
      ];
      const existingPung = meld('pung', false, 'green', 'green', 'green');
      const state = stateWith({
        currentTurnSeat: 0,
        phase: { type: 'awaiting-discard', drawnTile: concealed14[concealed14.length - 1] },
        players: withPlayer(fourDeadPlayers(), 0, playerState(playerHand(concealed14, [existingPung]))),
      });
      const decision = chooseAiAction(state, 0);
      expect(decision?.action).toEqual({
        type: 'declare-added-kong',
        seat: 0,
        tileId: extraGreen.id,
      });
    });

    it('accepts an added kong when the hand was not tenpai to begin with (nothing to protect)', () => {
      const extraGreen = tile('green');
      const concealed14 = [
        extraGreen,
        ...hand(
          'wan1', 'wan3', 'wan5', 'wan7', 'wan9',
          'tong1', 'tong3', 'tong5', 'tong7', 'tong9',
          'tiao1', 'tiao3', 'tiao5',
        ),
      ];
      const existingPung = meld('pung', false, 'green', 'green', 'green');
      const state = stateWith({
        currentTurnSeat: 0,
        phase: { type: 'awaiting-discard', drawnTile: concealed14[concealed14.length - 1] },
        players: withPlayer(fourDeadPlayers(), 0, playerState(playerHand(concealed14, [existingPung]))),
      });
      const decision = chooseAiAction(state, 0);
      expect(decision?.action).toEqual({
        type: 'declare-added-kong',
        seat: 0,
        tileId: extraGreen.id,
      });
    });
  });

  it('never chooses a kong when wallRemaining is at or below deadWallReserve', () => {
    const preKong17 = hand(
      'north', 'north', 'north', 'north',
      'wan1', 'wan3', 'wan5', 'wan7', 'wan9',
      'tong1', 'tong3', 'tong5', 'tong7', 'tong9',
      'tiao1', 'tiao3', 'tiao5',
    );
    const state = stateWith({
      currentTurnSeat: 0,
      wall: fillerWall(DEFAULT_RULES.deadWallReserve), // exactly at the reserve
      phase: { type: 'awaiting-discard', drawnTile: preKong17[preKong17.length - 1] },
      players: withPlayer(fourDeadPlayers(), 0, playerState(playerHand(preKong17))),
    });
    const decision = chooseAiAction(state, 0);
    expect(decision?.action.type).toBe('discard');
  });
});

// ================================================================================
// Claim window (awaiting-claims)
// ================================================================================

describe('chooseAiAction: claim window', () => {
  it('claims hu on a discard that wins, over an available kong/pung/chow on the same discard', () => {
    const concealed16 = hand(
      'wan5', 'wan5', 'wan5', 'wan4', 'wan6',
      'tong1', 'tong2', 'tong3',
      'tiao1', 'tiao1', 'tiao1',
      'tiao4', 'tiao5', 'tiao6',
      'red', 'red',
    );
    const discardedTile = tile('wan5');
    const state = stateWith({
      players: withPlayer(fourDeadPlayers(), 1, playerState(playerHand(concealed16))),
      phase: { type: 'awaiting-claims', discarderSeat: 0, discardedTile, responses: {} },
    });
    const decision = chooseAiAction(state, 1);
    expect(decision?.action).toEqual({ type: 'claim', seat: 1, claim: { type: 'hu' } });
  });

  it('a barred (sacred-discard) seat does not choose hu even though the win-check would otherwise pass', () => {
    const concealed16 = hand(
      'wan1', 'wan2', 'wan3',
      'tong1', 'tong2', 'tong3',
      'tiao1', 'tiao2', 'tiao3',
      'red', 'red', 'red',
      'south', 'south', 'south',
      'east',
    );
    const discardedTile = tile('east');
    const state = stateWith({
      players: withPlayer(fourDeadPlayers(), 1, playerState(playerHand(concealed16), true)),
      phase: { type: 'awaiting-claims', discarderSeat: 0, discardedTile, responses: {} },
    });
    const decision = chooseAiAction(state, 1);
    expect(decision).toBeNull();
  });

  it('does not choose hu when rules.minTaiToWin exceeds the hand\'s actual tai', () => {
    const concealed16 = hand(
      'wan1', 'wan2', 'wan3',
      'tong1', 'tong2', 'tong3',
      'tiao1', 'tiao2', 'tiao3',
      'red', 'red', 'red',
      'south', 'south', 'south',
      'east',
    );
    const discardedTile = tile('east');
    const rules: RulesConfig = { ...DEFAULT_RULES, minTaiToWin: 5 };
    const state = stateWith({
      rules,
      players: withPlayer(fourDeadPlayers(), 1, playerState(playerHand(concealed16))),
      phase: { type: 'awaiting-claims', discarderSeat: 0, discardedTile, responses: {} },
    });
    const decision = chooseAiAction(state, 1);
    expect(decision).toBeNull();
  });

  describe('kong-from-discard safety', () => {
    // minTaiToWin blocks hu throughout this describe block so kong/pung/chow
    // priority can be exercised without hu short-circuiting first (a plain
    // discard win's handTai is 0 under DEFAULT_RULES's TAI_EVALUATORS).
    const noHuRules: RulesConfig = { ...DEFAULT_RULES, minTaiToWin: 1 };

    it('declines a kong claim that would break the claimant\'s current tenpai wait', () => {
      const concealed16 = hand(
        'wan5', 'wan5', 'wan5',
        'wan3', 'wan4', 'wan6', 'wan7',
        'tong1', 'tong2', 'tong3',
        'tiao1', 'tiao1', 'tiao1',
        'red', 'red', 'red',
      );
      const discardedTile = tile('wan5');
      const state = stateWith({
        rules: noHuRules,
        players: withPlayer(fourDeadPlayers(), 1, playerState(playerHand(concealed16))),
        phase: { type: 'awaiting-claims', discarderSeat: 0, discardedTile, responses: {} },
      });
      const decision = chooseAiAction(state, 1);
      expect(decision?.action.type === 'claim' && decision.action.claim.type).not.toBe('kong');
    });

    it('accepts a kong claim that preserves the wait', () => {
      const concealed16 = hand(
        'wan5', 'wan5', 'wan5',
        'wan4', 'wan4', 'wan6', 'wan6',
        'tong1', 'tong2', 'tong3',
        'tiao1', 'tiao1', 'tiao1',
        'red', 'red', 'red',
      );
      const discardedTile = tile('wan5');
      const state = stateWith({
        rules: noHuRules,
        players: withPlayer(fourDeadPlayers(), 1, playerState(playerHand(concealed16))),
        phase: { type: 'awaiting-claims', discarderSeat: 0, discardedTile, responses: {} },
      });
      const decision = chooseAiAction(state, 1);
      expect(decision?.action).toEqual({ type: 'claim', seat: 1, claim: { type: 'kong' } });
    });

    it('accepts a kong claim when the hand was not currently waiting (nothing to protect)', () => {
      const concealed16 = hand(
        'wan5', 'wan5', 'wan5',
        'tong1', 'tong3', 'tong5', 'tong7', 'tong9',
        'tiao1', 'tiao3', 'tiao5', 'tiao7', 'tiao9',
        'east', 'south', 'west',
      );
      const discardedTile = tile('wan5');
      const state = stateWith({
        rules: noHuRules,
        players: withPlayer(fourDeadPlayers(), 1, playerState(playerHand(concealed16))),
        phase: { type: 'awaiting-claims', discarderSeat: 0, discardedTile, responses: {} },
      });
      const decision = chooseAiAction(state, 1);
      expect(decision?.action).toEqual({ type: 'claim', seat: 1, claim: { type: 'kong' } });
    });

    it('never chooses a claim-kong when wallRemaining is at or below deadWallReserve', () => {
      const concealed16 = hand(
        'wan5', 'wan5', 'wan5',
        'tong1', 'tong3', 'tong5', 'tong7', 'tong9',
        'tiao1', 'tiao3', 'tiao5', 'tiao7', 'tiao9',
        'east', 'south', 'west',
      );
      const discardedTile = tile('wan5');
      const state = stateWith({
        rules: noHuRules,
        wall: fillerWall(noHuRules.deadWallReserve),
        players: withPlayer(fourDeadPlayers(), 1, playerState(playerHand(concealed16))),
        phase: { type: 'awaiting-claims', discarderSeat: 0, discardedTile, responses: {} },
      });
      const decision = chooseAiAction(state, 1);
      expect(decision === null || (decision.action.type === 'claim' && decision.action.claim.type !== 'kong')).toBe(
        true,
      );
    });
  });

  describe('pung', () => {
    const noHuRules: RulesConfig = { ...DEFAULT_RULES, minTaiToWin: 1 };

    it('declines a pung that would destroy an existing tenpai wait', () => {
      const concealed16 = hand(
        'wan3', 'wan4', 'wan5', 'wan5', 'wan6', 'wan7',
        'red', 'red',
        'tong1', 'tong2', 'tong3',
        'tiao1', 'tiao2', 'tiao3',
        'green', 'green',
      );
      const discardedTile = tile('wan5');
      const state = stateWith({
        rules: noHuRules,
        players: withPlayer(fourDeadPlayers(), 1, playerState(playerHand(concealed16))),
        phase: { type: 'awaiting-claims', discarderSeat: 0, discardedTile, responses: {} },
      });
      const decision = chooseAiAction(state, 1);
      expect(decision?.action.type === 'claim' && decision.action.claim.type).not.toBe('pung');
    });

    it('accepts a pung when the hand is not currently tenpai and the pung improves shape', () => {
      const concealed16 = hand(
        'south', 'south',
        'wan1', 'wan4', 'wan7',
        'tong1', 'tong4', 'tong7',
        'tiao1', 'tiao4', 'tiao7',
        'east', 'west', 'north',
        'red', 'green',
      );
      const discardedTile = tile('south');
      const state = stateWith({
        rules: noHuRules,
        players: withPlayer(fourDeadPlayers(), 1, playerState(playerHand(concealed16))),
        phase: { type: 'awaiting-claims', discarderSeat: 0, discardedTile, responses: {} },
      });
      const decision = chooseAiAction(state, 1);
      expect(decision?.action).toEqual({ type: 'claim', seat: 1, claim: { type: 'pung' } });
    });
  });

  describe('chow', () => {
    const noHuRules: RulesConfig = { ...DEFAULT_RULES, minTaiToWin: 1 };

    it('is only ever offered to nextSeat(discarderSeat), never a non-adjacent seat', () => {
      const concealed16 = hand(
        'wan4', 'wan6',
        'tong1', 'tong2', 'tong3',
        'tiao1', 'tiao1', 'tiao1',
        'red', 'red', 'red',
        'north', 'north', 'north',
        'wan9', 'wan8',
      );
      const discardedTile = tile('wan5');
      // discarderSeat=0; nextSeat(0)=1. Put the chow-eligible hand at seat 2
      // (non-adjacent) instead, so if the adjacency check were missing, a
      // chow would wrongly be offered.
      const state = stateWith({
        rules: noHuRules,
        players: withPlayer(fourDeadPlayers(), 2, playerState(playerHand(concealed16))),
        phase: { type: 'awaiting-claims', discarderSeat: 0, discardedTile, responses: {} },
      });
      const decision = chooseAiAction(state, 2);
      expect(decision === null || (decision.action.type === 'claim' && decision.action.claim.type !== 'chow')).toBe(
        true,
      );
    });

    it('accepts a chow when it improves shape (hand not currently tenpai)', () => {
      const concealed16 = hand(
        'wan4', 'wan6',
        'tong1', 'tong4', 'tong7',
        'tiao1', 'tiao4', 'tiao7',
        'east', 'west', 'north',
        'red', 'green',
        'wan9', 'tong9', 'tiao9',
      );
      const discardedTile = tile('wan5');
      const state = stateWith({
        rules: noHuRules,
        players: withPlayer(fourDeadPlayers(), 1, playerState(playerHand(concealed16))),
        phase: { type: 'awaiting-claims', discarderSeat: 0, discardedTile, responses: {} },
      });
      const decision = chooseAiAction(state, 1);
      expect(decision?.action.type).toBe('claim');
      if (decision?.action.type === 'claim' && decision.action.claim.type === 'chow') {
        const idSet = new Set(decision.action.claim.tileIds);
        expect(idSet.has(concealed16[0].id)).toBe(true); // wan4
        expect(idSet.has(concealed16[1].id)).toBe(true); // wan6
      } else {
        throw new Error('expected a chow claim');
      }
    });

    it('the chosen chow action carries the exact tile-id pair of the first improving option', () => {
      // wan3,wan4,wan6,wan7 all present -> 3 legal chow windows against a
      // wan5 discard ([3,4], [4,6], [6,7]); canChow returns them in that
      // fixed order. All three trivially "improve" here (hand not tenpai,
      // any chow adds +100 meld-count). The FIRST option in canChow's own
      // order — [wan3, wan4] — must be the one chosen.
      const concealed16 = hand(
        'wan3', 'wan4', 'wan6', 'wan7',
        'tong1', 'tong4', 'tong7',
        'tiao1', 'tiao4', 'tiao7',
        'east', 'west',
        'red', 'green',
        'tong9', 'tiao9',
      );
      const discardedTile = tile('wan5');
      const state = stateWith({
        rules: noHuRules,
        players: withPlayer(fourDeadPlayers(), 1, playerState(playerHand(concealed16))),
        phase: { type: 'awaiting-claims', discarderSeat: 0, discardedTile, responses: {} },
      });
      const decision = chooseAiAction(state, 1);
      expect(decision?.action).toEqual({
        type: 'claim',
        seat: 1,
        claim: { type: 'chow', tileIds: [concealed16[0].id, concealed16[1].id] }, // wan3, wan4
      });
    });

    it('declines when the only chow option does not improve shape (hand not currently tenpai)', () => {
      // Two complete concealed triplets (wan4x3, wan6x3 — 200 shapeScore) that
      // the chow would each break down to a bare pair (20 each — 40 total):
      // postScore = 100*(meldCount 1) + 40 = 140, strictly less than
      // preScore = 100*0 + 200 = 200. The rest of the hand is a sparse/dead
      // filler (0 shapeScore, not tenpai) so this exercises the
      // not-currently-waiting/shapeScore branch of claimImproves, not the
      // tenpai-preservation branch.
      const concealed16 = hand(
        'wan4', 'wan4', 'wan4', 'wan6', 'wan6', 'wan6',
        'tong1', 'tong3', 'tong5', 'tong7', 'tong9',
        'tiao1', 'tiao3', 'tiao5', 'tiao7', 'tiao9',
      );
      const discardedTile = tile('wan5');
      const rulesBlockHu: RulesConfig = { ...DEFAULT_RULES, minTaiToWin: 1 };
      const state = stateWith({
        rules: rulesBlockHu,
        players: withPlayer(fourDeadPlayers(), 1, playerState(playerHand(concealed16))),
        phase: { type: 'awaiting-claims', discarderSeat: 0, discardedTile, responses: {} },
      });
      const decision = chooseAiAction(state, 1);
      expect(decision === null || (decision.action.type === 'claim' && decision.action.claim.type !== 'chow')).toBe(
        true,
      );
    });
  });
});

// ================================================================================
// Rob-kong window
// ================================================================================

describe('chooseAiAction: rob-kong window', () => {
  function robKongPhase(overrides: Partial<Extract<Phase, { type: 'awaiting-rob-kong' }>> = {}): Phase {
    return {
      type: 'awaiting-rob-kong',
      declarerSeat: 0,
      kongTile: tile('east'),
      kongType: 'added',
      pendingConcealedKongTiles: null,
      eligibleRobbers: [1],
      responses: {},
      ...overrides,
    };
  }

  it('always declares rob when the seat is an eligible robber and unresponded', () => {
    const state = stateWith({ players: fourDeadPlayers(), phase: robKongPhase() });
    const decision = chooseAiAction(state, 1);
    expect(decision?.action).toEqual({ type: 'declare-rob', seat: 1 });
    expect(decision?.reasoning.length).toBeGreaterThan(0);
  });

  it('returns null for the declarer\'s own seat', () => {
    const state = stateWith({ players: fourDeadPlayers(), phase: robKongPhase() });
    expect(chooseAiAction(state, 0)).toBeNull();
  });

  it('returns null for a seat that is not an eligible robber', () => {
    const state = stateWith({ players: fourDeadPlayers(), phase: robKongPhase({ eligibleRobbers: [1] }) });
    expect(chooseAiAction(state, 2)).toBeNull();
  });

  it('returns null for an eligible robber who already responded', () => {
    const state = stateWith({
      players: fourDeadPlayers(),
      phase: robKongPhase({ eligibleRobbers: [1, 3], responses: { 1: 'pass' } }),
    });
    expect(chooseAiAction(state, 1)).toBeNull();
    expect(chooseAiAction(state, 3)?.action).toEqual({ type: 'declare-rob', seat: 3 });
  });
});

// ================================================================================
// Every non-null decision has a non-empty reasoning string
// ================================================================================

describe('AiDecision.reasoning', () => {
  it('is always a non-empty string when a decision is returned', () => {
    const sixteen = hand(
      'wan1', 'wan2', 'wan3', 'wan4', 'wan5', 'wan6', 'wan7', 'wan8', 'wan9',
      'tong1', 'tong2', 'tong3',
      'tiao1', 'tiao1', 'tiao1',
      'east',
    );
    const winningTile = tile('east');
    const state = stateWith({
      currentTurnSeat: 0,
      phase: { type: 'awaiting-discard', drawnTile: winningTile },
      players: withPlayer(fourDeadPlayers(), 0, playerState(playerHand([...sixteen, winningTile]))),
    });
    const decision = chooseAiAction(state, 0);
    expect(decision).not.toBeNull();
    expect(typeof decision?.reasoning).toBe('string');
    expect(decision?.reasoning.length).toBeGreaterThan(0);
  });
});
