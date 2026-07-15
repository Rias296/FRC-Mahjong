import { describe, expect, it } from 'vitest';
import { toClientView } from './views';
import type { GameState, PlayerState, WinnerResult } from '../engine/game-state';
import {
  kindKey,
  type DragonName,
  type FlowerNumber,
  type Rank,
  type SuitName,
  type Tile,
  type TileKind,
  type WindName,
} from '../engine/tiles';
import type { Seat } from '../engine/seats';
import type { Wall } from '../engine/wall';
import type { PlayerHand, PlayerMeld } from '../engine/actions';
import { DEFAULT_RULES } from '../engine/rules-config';
import type { PaymentLeg, SeatTotals } from '../engine/scoring';

// --- Test-local tile builder (duplicated per-file convention, see game-state.test.ts) ---
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
  return { id: `${kindKey(kind)}-test${idCounter}`, kind };
}
function hand(...specs: string[]): Tile[] {
  return specs.map(tile);
}
function wallOf(...tiles: Tile[]): Wall {
  return tiles;
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

function defaultPlayerState(handTiles: Tile[]): PlayerState {
  return { hand: { concealedTiles: handTiles, melds: [] }, flowers: [], discards: [], barred: false };
}

function playerStateFromHand(h: PlayerHand, extra?: Partial<PlayerState>): PlayerState {
  return { hand: h, flowers: [], discards: [], barred: false, ...extra };
}

function stateWith(overrides: Partial<GameState>): GameState {
  const base: GameState = {
    seed: 1,
    rules: DEFAULT_RULES,
    dealerSeat: 0,
    repeatCount: 0,
    wall: wallOf(...fillerTiles(40)),
    players: [
      defaultPlayerState(fillerTiles(16)),
      defaultPlayerState(fillerTiles(16)),
      defaultPlayerState(fillerTiles(16)),
      defaultPlayerState(fillerTiles(16)),
    ],
    currentTurnSeat: 0,
    phase: { type: 'awaiting-draw' },
  };
  return { ...base, ...overrides };
}

const PLAYERS = [
  { seat: 0 as Seat, displayName: 'Alice' },
  { seat: 1 as Seat, displayName: 'Bob' },
  { seat: 2 as Seat, displayName: 'Carol' },
  { seat: 3 as Seat, displayName: 'Dave' },
];

const SAMPLE_MATCH_POINTS: SeatTotals = [10, -20, 5, 5];

function view(state: GameState, viewerSeat: Seat | null, seq = 1, matchPoints: SeatTotals = SAMPLE_MATCH_POINTS) {
  return toClientView(state, viewerSeat, PLAYERS, 'ABC123', 'in-progress', 3, 'east', seq, matchPoints);
}

describe('toClientView: top-level fields', () => {
  it('passes through seq, roomCode, status, handNumber, prevailingWind, viewerSeat, wallRemaining', () => {
    const state = stateWith({ wall: wallOf(...fillerTiles(12)) });
    const result = view(state, 1 as Seat, 42);

    expect(result.seq).toBe(42);
    expect(result.roomCode).toBe('ABC123');
    expect(result.status).toBe('in-progress');
    expect(result.handNumber).toBe(3);
    expect(result.prevailingWind).toBe('east');
    expect(result.viewerSeat).toBe(1);
    expect(result.wallRemaining).toBe(12);
  });

  it('never exposes wall contents, only the count', () => {
    const state = stateWith({});
    const result = view(state, 0 as Seat);
    expect(result).not.toHaveProperty('wall');
    expect(typeof result.wallRemaining).toBe('number');
  });

  it('maps display names by seat and fills a fallback name if missing', () => {
    const state = stateWith({});
    const result = toClientView(
      state,
      null,
      [{ seat: 0 as Seat, displayName: 'Solo' }],
      'X',
      'in-progress',
      1,
      null,
      1,
      [0, 0, 0, 0],
    );
    expect(result.players[0].displayName).toBe('Solo');
    expect(result.players[1].displayName).toBe('Seat 1');
  });

  it('sets occupied true for every seated player and false for absent seats', () => {
    const state = stateWith({});
    const result = toClientView(
      state,
      null,
      [
        { seat: 0 as Seat, displayName: 'Alice' },
        { seat: 2 as Seat, displayName: 'Carol' },
      ],
      'X',
      'waiting-for-players',
      null,
      null,
      1,
      [0, 0, 0, 0],
    );
    expect(result.players[0].occupied).toBe(true);
    expect(result.players[1].occupied).toBe(false);
    expect(result.players[2].occupied).toBe(true);
    expect(result.players[3].occupied).toBe(false);
  });
});

describe('toClientView: player redaction', () => {
  it('shows full concealed tiles + own barred flag for the viewer own seat', () => {
    const ownHand = hand('wan1', 'wan2', 'wan3');
    const state = stateWith({
      players: [
        playerStateFromHand({ concealedTiles: ownHand, melds: [] }, { barred: true }),
        defaultPlayerState(fillerTiles(16)),
        defaultPlayerState(fillerTiles(16)),
        defaultPlayerState(fillerTiles(16)),
      ],
    });
    const result = view(state, 0 as Seat);
    const me = result.players[0];

    expect(me.isViewer).toBe(true);
    expect(me.concealedTiles).not.toBeNull();
    expect(me.concealedTiles?.map((t) => t.id)).toEqual(ownHand.map((t) => t.id));
    expect(me.concealedCount).toBe(3);
    expect(me.barredVisible).toBe(true);
  });

  it('hides an opponent hand behind null + concealedCount, and always nulls their barred flag even when barred=true', () => {
    const oppHand = hand('wan1', 'wan2', 'wan3', 'wan4', 'wan5');
    const state = stateWith({
      players: [
        defaultPlayerState(fillerTiles(16)),
        playerStateFromHand({ concealedTiles: oppHand, melds: [] }, { barred: true }),
        defaultPlayerState(fillerTiles(16)),
        defaultPlayerState(fillerTiles(16)),
      ],
    });
    const result = view(state, 0 as Seat);
    const opp = result.players[1];

    expect(opp.isViewer).toBe(false);
    expect(opp.concealedTiles).toBeNull();
    expect(opp.concealedCount).toBe(5);
    expect(opp.barredVisible).toBeNull();
  });

  it('always publicly exposes flowers and discards for every seat, including opponents', () => {
    const flowerTile = tile('flower1');
    const discardTile = tile('wan9');
    const state = stateWith({
      players: [
        defaultPlayerState(fillerTiles(16)),
        { hand: { concealedTiles: fillerTiles(16), melds: [] }, flowers: [flowerTile], discards: [discardTile], barred: false },
        defaultPlayerState(fillerTiles(16)),
        defaultPlayerState(fillerTiles(16)),
      ],
    });
    const result = view(state, 0 as Seat);
    expect(result.players[1].flowers.map((t) => t.id)).toEqual([flowerTile.id]);
    expect(result.players[1].discards.map((t) => t.id)).toEqual([discardTile.id]);
  });

  it('masks an opponent concealed kong with 4 placeholder tiles that reveal nothing about the real tile', () => {
    const realKongTile = tile('green'); // green dragon, distinct from the placeholder's fixed red-dragon kind
    const kongMeld: PlayerMeld = {
      kind: 'kong',
      concealed: true,
      tiles: [realKongTile, tile('green'), tile('green'), tile('green')],
    };
    const state = stateWith({
      players: [
        defaultPlayerState(fillerTiles(13)),
        { hand: { concealedTiles: fillerTiles(4), melds: [kongMeld] }, flowers: [], discards: [], barred: false },
        defaultPlayerState(fillerTiles(16)),
        defaultPlayerState(fillerTiles(16)),
      ],
    });
    const result = view(state, 0 as Seat);
    const meld = result.players[1].melds[0];

    expect(meld.kind).toBe('kong');
    expect(meld.concealed).toBe(true);
    expect(meld.tiles).toHaveLength(4);
    for (const t of meld.tiles) {
      expect(t.kind).not.toEqual(realKongTile.kind); // real kind is 'dragon-green', placeholder is 'dragon-red'
      expect(t.id).not.toBe(realKongTile.id);
    }
  });

  it('shows the viewer their own concealed kong tiles for real (not masked)', () => {
    const realKongTile = tile('white');
    const kongMeld: PlayerMeld = {
      kind: 'kong',
      concealed: true,
      tiles: [realKongTile, tile('white'), tile('white'), tile('white')],
    };
    const state = stateWith({
      players: [
        { hand: { concealedTiles: fillerTiles(4), melds: [kongMeld] }, flowers: [], discards: [], barred: false },
        defaultPlayerState(fillerTiles(16)),
        defaultPlayerState(fillerTiles(16)),
        defaultPlayerState(fillerTiles(16)),
      ],
    });
    const result = view(state, 0 as Seat);
    const meld = result.players[0].melds[0];
    expect(meld.tiles.map((t) => t.id)).toEqual(kongMeld.tiles.map((t) => t.id));
  });

  it('shows an EXPOSED kong (added or claimed) to everyone regardless of concealed flag not being set', () => {
    const exposedKongTile = tile('east');
    const kongMeld: PlayerMeld = {
      kind: 'kong',
      concealed: false,
      tiles: [exposedKongTile, tile('east'), tile('east'), tile('east')],
    };
    const state = stateWith({
      players: [
        defaultPlayerState(fillerTiles(13)),
        { hand: { concealedTiles: fillerTiles(4), melds: [kongMeld] }, flowers: [], discards: [], barred: false },
        defaultPlayerState(fillerTiles(16)),
        defaultPlayerState(fillerTiles(16)),
      ],
    });
    const result = view(state, 0 as Seat);
    const meld = result.players[1].melds[0];
    expect(meld.tiles.map((t) => t.id)).toEqual(kongMeld.tiles.map((t) => t.id));
  });

  it('works for a null (spectator) viewer: every seat isViewer=false, every hand hidden', () => {
    const state = stateWith({});
    const result = view(state, null);
    for (const p of result.players) {
      expect(p.isViewer).toBe(false);
      expect(p.concealedTiles).toBeNull();
      expect(p.barredVisible).toBeNull();
    }
  });
});

describe('toClientView: phase redaction — awaiting-draw', () => {
  it('exposes only the type', () => {
    const state = stateWith({ phase: { type: 'awaiting-draw' } });
    const result = view(state, 0 as Seat);
    expect(result.phase).toEqual({ type: 'awaiting-draw' });
  });
});

describe('toClientView: phase redaction — awaiting-discard', () => {
  it('shows the drawn tile only to the current-turn viewer', () => {
    const drawnTile = tile('wan5');
    const state = stateWith({ currentTurnSeat: 2 as Seat, phase: { type: 'awaiting-discard', drawnTile } });

    const forCurrentTurnViewer = view(state, 2 as Seat);
    expect(forCurrentTurnViewer.phase?.type).toBe('awaiting-discard');
    expect(forCurrentTurnViewer.phase?.drawnTileForViewer).toEqual({ id: drawnTile.id, kind: drawnTile.kind });

    const forOtherViewer = view(state, 0 as Seat);
    expect(forOtherViewer.phase?.drawnTileForViewer).toBeUndefined();

    const forSpectator = view(state, null);
    expect(forSpectator.phase?.drawnTileForViewer).toBeUndefined();
  });

  it('shows drawnTileForViewer: null for the current-turn viewer when drawnTile is null (post-claim)', () => {
    const state = stateWith({ currentTurnSeat: 1 as Seat, phase: { type: 'awaiting-discard', drawnTile: null } });
    const result = view(state, 1 as Seat);
    expect(result.phase).toEqual({ type: 'awaiting-discard', drawnTileForViewer: null });
  });
});

describe('toClientView: phase redaction — awaiting-claims', () => {
  it('reports respondedSeats (who responded) but never what they claimed', () => {
    const discardedTile = tile('tong4');
    const state = stateWith({
      phase: {
        type: 'awaiting-claims',
        discarderSeat: 0 as Seat,
        discardedTile,
        responses: { 1: 'pass', 2: { type: 'hu', seat: 2 as Seat } },
      },
    });
    const result = view(state, 3 as Seat);
    expect(result.phase).toEqual({
      type: 'awaiting-claims',
      discarderSeat: 0,
      discardedTile: { id: discardedTile.id, kind: discardedTile.kind },
      respondedSeats: [1, 2],
    });
    // No claim content anywhere in the redacted shape.
    expect(JSON.stringify(result.phase)).not.toContain('hu');
  });

  it('publicly exposes the discarded tile to every viewer including spectators', () => {
    const discardedTile = tile('tiao7');
    const state = stateWith({
      phase: { type: 'awaiting-claims', discarderSeat: 0 as Seat, discardedTile, responses: {} },
    });
    const result = view(state, null);
    expect(result.phase?.discardedTile).toEqual({ id: discardedTile.id, kind: discardedTile.kind });
  });
});

describe('toClientView: phase redaction — awaiting-rob-kong', () => {
  it('never broadcasts the full eligibleRobbers list; only exposes youMayRob (per-viewer) and stillWaitingCount (a count, not the list)', () => {
    const kongTile = tile('east');
    const state = stateWith({
      phase: {
        type: 'awaiting-rob-kong',
        declarerSeat: 0 as Seat,
        kongTile,
        kongType: 'added',
        pendingConcealedKongTiles: null,
        eligibleRobbers: [1, 3],
        responses: { 1: 'pass' },
      },
    });

    const asEligibleUnresponded = view(state, 3 as Seat);
    expect(asEligibleUnresponded.phase?.youMayRob).toBe(true);
    expect(asEligibleUnresponded.phase?.stillWaitingCount).toBe(1);
    expect(JSON.stringify(asEligibleUnresponded.phase)).not.toContain('eligibleRobbers');

    const asIneligible = view(state, 2 as Seat);
    expect(asIneligible.phase?.youMayRob).toBe(false);
  });

  it('added kong: kongTileVisible is real for everyone (declarer, robber, bystander) since it is already public', () => {
    const kongTile = tile('south');
    const state = stateWith({
      phase: {
        type: 'awaiting-rob-kong',
        declarerSeat: 0 as Seat,
        kongTile,
        kongType: 'added',
        pendingConcealedKongTiles: null,
        eligibleRobbers: [1, 3],
        responses: {},
      },
    });

    for (const viewer of [0, 1, 2, 3, null] as (Seat | null)[]) {
      const result = view(state, viewer);
      expect(result.phase?.kongTileVisible).toEqual({ id: kongTile.id, kind: kongTile.kind });
    }
  });

  it('concealed kong: kongTileVisible is real only for the declarer and eligible robbers, null for bystanders', () => {
    const kongTile = tile('north');
    const state = stateWith({
      phase: {
        type: 'awaiting-rob-kong',
        declarerSeat: 0 as Seat,
        kongTile,
        kongType: 'concealed',
        pendingConcealedKongTiles: [kongTile, tile('north'), tile('north'), tile('north')],
        eligibleRobbers: [1, 3],
        responses: {},
      },
    });

    const declarerView = view(state, 0 as Seat);
    expect(declarerView.phase?.kongTileVisible).toEqual({ id: kongTile.id, kind: kongTile.kind });

    const robberView = view(state, 1 as Seat);
    expect(robberView.phase?.kongTileVisible).toEqual({ id: kongTile.id, kind: kongTile.kind });

    const bystanderView = view(state, 2 as Seat);
    expect(bystanderView.phase?.kongTileVisible).toBeNull();

    const spectatorView = view(state, null);
    expect(spectatorView.phase?.kongTileVisible).toBeNull();
  });
});

describe('toClientView: player redaction — adversarial (tester round)', () => {
  it(
    'masks an opponent concealed kong of the EXACT sentinel kind (red dragon) — proves masking ' +
      'is driven purely by meld.concealed && !isViewer, never by a value-equality check against ' +
      'the sentinel placeholder kind itself',
    () => {
      const realKongTile = tile('red'); // deliberately the SAME kind as HIDDEN_KONG_PLACEHOLDER_KIND
      const kongMeld: PlayerMeld = {
        kind: 'kong',
        concealed: true,
        tiles: [realKongTile, tile('red'), tile('red'), tile('red')],
      };
      const state = stateWith({
        players: [
          defaultPlayerState(fillerTiles(13)),
          { hand: { concealedTiles: fillerTiles(4), melds: [kongMeld] }, flowers: [], discards: [], barred: false },
          defaultPlayerState(fillerTiles(16)),
          defaultPlayerState(fillerTiles(16)),
        ],
      });

      const opponentResult = view(state, 0 as Seat);
      const oppMeld = opponentResult.players[1].melds[0];
      expect(oppMeld.kind).toBe('kong');
      expect(oppMeld.concealed).toBe(true);
      expect(oppMeld.tiles.map((t) => t.id)).toEqual(['hidden-0', 'hidden-1', 'hidden-2', 'hidden-3']);
      for (const realTile of kongMeld.tiles) {
        expect(oppMeld.tiles.some((t) => t.id === realTile.id)).toBe(false);
      }

      // Flip: shown to its OWNER, the same meld must reveal the real ids for real —
      // proving the decision is isViewer-driven, not kind-driven.
      const ownerMeld = view(state, 1 as Seat).players[1].melds[0];
      expect(ownerMeld.tiles.map((t) => t.id)).toEqual(kongMeld.tiles.map((t) => t.id));
    },
  );

  it(
    'still hides an opponent barred=true flag even in a hand-over state where the bar was set ' +
      'earlier in the (now-finished) hand — barred state is never revealed for non-viewer seats ' +
      'regardless of phase; verifying this is the current, consistent behavior (not merely an ' +
      'artifact of only testing awaiting-* phases)',
    () => {
      const winners: WinnerResult[] = [{ seat: 2 as Seat, winType: 'discard', handTai: 3, winningTile: tile('wan5') }];
      const legs: PaymentLeg[] = [{ payerSeat: 0 as Seat, payeeSeat: 2 as Seat, amount: 3 }];
      const state = stateWith({
        players: [
          defaultPlayerState(fillerTiles(16)),
          { hand: { concealedTiles: fillerTiles(16), melds: [] }, flowers: [], discards: [], barred: true },
          defaultPlayerState(fillerTiles(13)),
          defaultPlayerState(fillerTiles(16)),
        ],
        phase: {
          type: 'hand-over',
          result: { kind: 'win', winners, legs, nextDealerSeat: 1 as Seat, nextRepeatCount: 0 },
        },
      });

      const bystander = view(state, 0 as Seat);
      expect(bystander.players[1].barredVisible).toBeNull();

      // The barred player's OWN view still sees their true flag — confirms this is the
      // deliberate "never leak opponents' bar" rule operating identically post-hand-over,
      // not an accidental always-null bug that would also hide it from the owner.
      const ownView = view(state, 1 as Seat);
      expect(ownView.players[1].barredVisible).toBe(true);
    },
  );

  it(
    'CRITICAL (regression): stillWaitingCount exposes only the COUNT of eligible-and-unresponded ' +
      'seats, never the seat list — closing the previous waitingOnSeats leak where ' +
      'eligibleRobbers.filter(seat => unresponded) was broadcast byte-for-byte identical to ' +
      'eligibleRobbers to EVERY viewer, including bystanders who are not eligible and ' +
      'unauthenticated spectators. This test proves the fix: with 2 of the 4 seats ' +
      '(eligibleRobbers=[1,3]) eligible-and-pending, every viewer — including a non-eligible ' +
      'bystander and a spectator — sees stillWaitingCount === 2 and the response body never ' +
      'contains the raw seat numbers in any field that would reveal WHICH seats are eligible.',
    () => {
      const kongTile = tile('east');
      const state = stateWith({
        phase: {
          type: 'awaiting-rob-kong',
          declarerSeat: 0 as Seat,
          kongTile,
          kongType: 'added',
          pendingConcealedKongTiles: null,
          eligibleRobbers: [1, 3],
          responses: {}, // nobody has responded yet: stillWaitingCount === eligibleRobbers.length
        },
      });

      for (const viewer of [0, 1, 2, 3, null] as (Seat | null)[]) {
        const result = view(state, viewer);
        expect(result.phase?.stillWaitingCount).toBe(2);
        // The redacted phase must never mention eligibleRobbers or carry a seat list that
        // would reveal WHICH seats are eligible-and-pending.
        expect(result.phase).not.toHaveProperty('waitingOnSeats');
        expect(result.phase).not.toHaveProperty('eligibleRobbers');
        expect(JSON.stringify(result.phase)).not.toContain('eligibleRobbers');
      }

      // Concretely: bystander seat 2 (never eligible, has no stake in this window) learns only
      // that 2 players are still deciding — not who. This is the closed version of the leak the
      // rest of this file's redaction rules (barredVisible, concealed-hand masking) already
      // enforce for every OTHER seat.
      const bystanderResult = view(state, 2 as Seat);
      expect(bystanderResult.phase?.youMayRob).toBe(false);
      expect(bystanderResult.phase?.stillWaitingCount).toBe(2);
    },
  );

  it(
    'CLOSING VERIFICATION: with only ONE eligible-and-pending seat, the two non-eligible bystander ' +
      'seats receive BYTE-IDENTICAL phase views for the shared fields — proving stillWaitingCount ' +
      'never lets a bystander narrow eligibility down to a specific seat by elimination, even in ' +
      'the tightest case (1 eligible seat among the 3 non-discarder seats)',
    () => {
      const kongTile = tile('west');
      const state = stateWith({
        phase: {
          type: 'awaiting-rob-kong',
          declarerSeat: 0 as Seat,
          kongTile,
          kongType: 'added',
          pendingConcealedKongTiles: null,
          eligibleRobbers: [3], // only seat 3 is eligible; seats 1 and 2 are bystanders
          responses: {},
        },
      });

      const bystander1 = view(state, 1 as Seat);
      const bystander2 = view(state, 2 as Seat);
      const spectator = view(state, null);

      // Every non-eligible viewer — including an unauthenticated spectator —
      // sees exactly the same shared-field values. There is nothing in any of
      // these views that differs between bystander seat 1 and bystander seat
      // 2, so neither can use their own view (nor could they, without an
      // impossible cross-account comparison) to deduce "it's specifically
      // seat 3" rather than some other non-viewer seat.
      for (const result of [bystander1, bystander2, spectator]) {
        expect(result.phase?.youMayRob).toBe(false);
        expect(result.phase?.stillWaitingCount).toBe(1);
        expect(result.phase?.declarerSeat).toBe(0);
      }
      expect(JSON.stringify(bystander1.phase)).toBe(JSON.stringify(bystander2.phase));
      expect(JSON.stringify(bystander1.phase)).toBe(JSON.stringify(spectator.phase));

      // The only viewer who can distinguish themselves is the eligible seat
      // itself, learning ONLY their own status (self-knowledge, not a leak
      // about anyone else).
      const eligibleView = view(state, 3 as Seat);
      expect(eligibleView.phase?.youMayRob).toBe(true);
    },
  );

  it(
    'CLOSING VERIFICATION: no cross-contamination between phase-view shapes — an awaiting-rob-kong ' +
      'view never carries awaiting-claims-only fields (respondedSeats) and vice versa, so a client ' +
      'cannot cross-reference the two phase kinds to reconstruct eligibility',
    () => {
      const kongTile = tile('south');
      const robKongState = stateWith({
        phase: {
          type: 'awaiting-rob-kong',
          declarerSeat: 0 as Seat,
          kongTile,
          kongType: 'added',
          pendingConcealedKongTiles: null,
          eligibleRobbers: [1, 3],
          responses: { 1: 'pass' },
        },
      });
      const robKongView = view(robKongState, 2 as Seat);
      expect(robKongView.phase).not.toHaveProperty('respondedSeats');
      expect(JSON.stringify(robKongView.phase)).not.toContain('respondedSeats');

      const discardedTile = tile('wan3');
      const claimsState = stateWith({
        phase: {
          type: 'awaiting-claims',
          discarderSeat: 0 as Seat,
          discardedTile,
          responses: { 1: 'pass' },
        },
      });
      const claimsView = view(claimsState, 2 as Seat);
      expect(claimsView.phase).not.toHaveProperty('stillWaitingCount');
      expect(claimsView.phase).not.toHaveProperty('youMayRob');
      expect(JSON.stringify(claimsView.phase)).not.toContain('stillWaitingCount');
    },
  );
});

describe('toClientView: top-level fields — currentTurnSeat, dealerSeat, repeatCount', () => {
  it('exposes currentTurnSeat, dealerSeat, and repeatCount identically to every viewer including a null-seat spectator', () => {
    const state = stateWith({ currentTurnSeat: 2 as Seat, dealerSeat: 3 as Seat, repeatCount: 2 });

    for (const viewer of [0, 1, 2, 3, null] as (Seat | null)[]) {
      const result = view(state, viewer);
      expect(result.currentTurnSeat).toBe(2);
      expect(result.dealerSeat).toBe(3);
      expect(result.repeatCount).toBe(2);
    }
  });

  it(
    'CRITICAL: these three fields are byte-identical across every viewer for every phase type, not ' +
      'just awaiting-draw — proves they are never accidentally routed through any of the ' +
      'per-viewer-branching logic used elsewhere in redactPhase/redactPlayer',
    () => {
      const kongTile = tile('east');
      const phases: Array<GameState['phase']> = [
        { type: 'awaiting-draw' },
        { type: 'awaiting-discard', drawnTile: tile('wan1') },
        {
          type: 'awaiting-claims',
          discarderSeat: 0 as Seat,
          discardedTile: tile('tong5'),
          responses: { 1: 'pass' },
        },
        {
          type: 'awaiting-rob-kong',
          declarerSeat: 0 as Seat,
          kongTile,
          kongType: 'added',
          pendingConcealedKongTiles: null,
          eligibleRobbers: [1, 3],
          responses: { 1: 'pass' },
        },
        {
          type: 'hand-over',
          result: { kind: 'exhaustive-draw', nextDealerSeat: 1 as Seat, nextRepeatCount: 0 },
        },
      ];

      for (const phase of phases) {
        const state = stateWith({ currentTurnSeat: 1 as Seat, dealerSeat: 2 as Seat, repeatCount: 4, phase });
        const views = ([0, 1, 2, 3, null] as (Seat | null)[]).map((viewer) => view(state, viewer));
        for (const v of views) {
          expect(v.currentTurnSeat).toBe(1);
          expect(v.dealerSeat).toBe(2);
          expect(v.repeatCount).toBe(4);
        }
      }
    },
  );
});

describe('toClientView: currentTurnSeat/dealerSeat/repeatCount null-handling contract with status', () => {
  it(
    'CRITICAL: currentTurnSeat/dealerSeat/repeatCount are non-null for EVERY non-waiting status ' +
      '(in-progress AND finished) — a finished game keeps the last hand\'s real GameState (the ' +
      'route never fabricates a null-phase view for "finished"), so views.ts must agree with that ' +
      'contract for both statuses, not just "in-progress"',
    () => {
      const state = stateWith({
        currentTurnSeat: 3 as Seat,
        dealerSeat: 1 as Seat,
        repeatCount: 5,
        phase: {
          type: 'hand-over',
          result: { kind: 'exhaustive-draw', nextDealerSeat: 1 as Seat, nextRepeatCount: 6 },
        },
      });

      const finishedView = toClientView(state, null, PLAYERS, 'ABC123', 'finished', 9, 'north', 100, [0, 0, 0, 0]);
      expect(finishedView.status).toBe('finished');
      expect(finishedView.currentTurnSeat).toBe(3);
      expect(finishedView.dealerSeat).toBe(1);
      expect(finishedView.repeatCount).toBe(5);

      const inProgressView = toClientView(state, null, PLAYERS, 'ABC123', 'in-progress', 9, 'north', 100, [0, 0, 0, 0]);
      expect(inProgressView.currentTurnSeat).toBe(3);
      expect(inProgressView.dealerSeat).toBe(1);
      expect(inProgressView.repeatCount).toBe(5);
    },
  );

  it(
    'views.ts itself has no code path that produces null for these three fields — they are a direct, ' +
      'unconditional passthrough of state.currentTurnSeat/dealerSeat/repeatCount, which are non-optional ' +
      'GameState fields; the ONLY null-producing code path in the whole app is the separate ' +
      'waitingForPlayersView branch in src/app/api/games/[code]/state/route.ts, which never calls ' +
      'toClientView at all. This test pins that views.ts is unconditional so a future edit cannot ' +
      'silently reintroduce a null branch here without failing this assertion.',
    () => {
      const state = stateWith({ currentTurnSeat: 0 as Seat, dealerSeat: 0 as Seat, repeatCount: 0 });
      const result = view(state, 0 as Seat);
      expect(result.currentTurnSeat).not.toBeNull();
      expect(result.dealerSeat).not.toBeNull();
      expect(result.repeatCount).not.toBeNull();
    },
  );
});

describe('toClientView: phase redaction — awaiting-rob-kong — youHaveResponded', () => {
  it('sets youHaveResponded true only for an eligible robber with a recorded response', () => {
    const kongTile = tile('east');
    const state = stateWith({
      phase: {
        type: 'awaiting-rob-kong',
        declarerSeat: 0 as Seat,
        kongTile,
        kongType: 'added',
        pendingConcealedKongTiles: null,
        eligibleRobbers: [1, 3],
        responses: { 1: 'pass' },
      },
    });

    const respondedRobber = view(state, 1 as Seat);
    expect(respondedRobber.phase?.youHaveResponded).toBe(true);

    const unrespondedRobber = view(state, 3 as Seat);
    expect(unrespondedRobber.phase?.youHaveResponded).toBeUndefined();
  });

  it('leaves youHaveResponded undefined for the declarer, bystanders, and spectators', () => {
    const kongTile = tile('south');
    const state = stateWith({
      phase: {
        type: 'awaiting-rob-kong',
        declarerSeat: 0 as Seat,
        kongTile,
        kongType: 'added',
        pendingConcealedKongTiles: null,
        eligibleRobbers: [1, 3],
        responses: { 1: 'pass', 3: 'pass' },
      },
    });

    const declarerView = view(state, 0 as Seat);
    expect(declarerView.phase?.youHaveResponded).toBeUndefined();

    const bystanderView = view(state, 2 as Seat);
    expect(bystanderView.phase?.youHaveResponded).toBeUndefined();

    const spectatorView = view(state, null);
    expect(spectatorView.phase?.youHaveResponded).toBeUndefined();
  });

  it('youHaveResponded reveals nothing about which other seats have responded', () => {
    const kongTile = tile('west');
    const state = stateWith({
      phase: {
        type: 'awaiting-rob-kong',
        declarerSeat: 0 as Seat,
        kongTile,
        kongType: 'added',
        pendingConcealedKongTiles: null,
        eligibleRobbers: [1, 3],
        // Only seat 1 has responded; seat 3 has not.
        responses: { 1: 'pass' },
      },
    });

    // The responded robber sees their own true flag.
    const respondedRobber = view(state, 1 as Seat);
    expect(respondedRobber.phase?.youHaveResponded).toBe(true);
    expect(JSON.stringify(respondedRobber.phase)).not.toContain('eligibleRobbers');

    // The OTHER eligible robber (unresponded) sees no trace of seat 1's response.
    const otherRobber = view(state, 3 as Seat);
    expect(otherRobber.phase?.youHaveResponded).toBeUndefined();
    expect(otherRobber.phase).not.toHaveProperty('responses');
    expect(JSON.stringify(otherRobber.phase)).not.toContain('"pass"');

    // A bystander sees nothing about anyone's response.
    const bystander = view(state, 2 as Seat);
    expect(bystander.phase?.youHaveResponded).toBeUndefined();
    expect(JSON.stringify(bystander.phase)).not.toContain('youHaveResponded');
  });

  it(
    'CRITICAL: with A responding "rob" (not just "pass"), B\'s (unresponded) view carries no ' +
      'youHaveResponded key at all (strict property-absence, not merely an undefined value) — the ' +
      "field must be literally OMITTED from the object (matching the field's own JSDoc: 'Only set " +
      "true, never false'), not present-but-undefined, and RESPONSE CONTENT ('rob' vs 'pass') must " +
      'never leak into ANY field visible to B',
    () => {
      const kongTile = tile('north');
      const state = stateWith({
        phase: {
          type: 'awaiting-rob-kong',
          declarerSeat: 0 as Seat,
          kongTile,
          kongType: 'added',
          pendingConcealedKongTiles: null,
          eligibleRobbers: [1, 3],
          // Seat 1 (A) robbed; seat 3 (B) has not responded at all.
          responses: { 1: 'rob' },
        },
      });

      const bRobberView = view(state, 3 as Seat);
      // Strict: the key must not exist on the object, not merely be `undefined`.
      expect(bRobberView.phase).not.toHaveProperty('youHaveResponded');
      expect(bRobberView.phase?.youMayRob).toBe(true);
      expect(bRobberView.phase?.stillWaitingCount).toBe(1);
      expect(JSON.stringify(bRobberView.phase)).not.toContain('rob"'); // no "rob" claim-content leak
      expect(JSON.stringify(bRobberView.phase)).not.toContain('responses');

      const aRobberView = view(state, 1 as Seat);
      expect(aRobberView.phase).toHaveProperty('youHaveResponded', true);

      // Bystander (never eligible): strict property-absence too, matching the
      // "only set true, never false" contract for a non-eligible seat.
      const bystanderView = view(state, 2 as Seat);
      expect(bystanderView.phase).not.toHaveProperty('youHaveResponded');

      // Declarer: strict property-absence — the declarer is never in
      // eligibleRobbers (findRobbers excludes the kong declarer by
      // construction, per src/engine/game-state.ts), so youMayRob is false
      // and youHaveResponded must likewise be entirely absent.
      const declarerView = view(state, 0 as Seat);
      expect(declarerView.phase?.youMayRob).toBe(false);
      expect(declarerView.phase).not.toHaveProperty('youHaveResponded');

      // Spectator: same strict absence.
      const spectatorView = view(state, null);
      expect(spectatorView.phase).not.toHaveProperty('youHaveResponded');
    },
  );
});

describe('toClientView: phase redaction — hand-over', () => {
  it('exposes the full HandResult to every viewer, no redaction', () => {
    const winners: WinnerResult[] = [
      { seat: 1 as Seat, winType: 'discard', handTai: 2, winningTile: tile('red') },
    ];
    const legs: PaymentLeg[] = [{ payerSeat: 0 as Seat, payeeSeat: 1 as Seat, amount: 5 }];
    const state = stateWith({
      phase: {
        type: 'hand-over',
        result: { kind: 'win', winners, legs, nextDealerSeat: 1 as Seat, nextRepeatCount: 0 },
      },
    });

    for (const viewer of [0, 1, 2, 3, null] as (Seat | null)[]) {
      const result = view(state, viewer);
      expect(result.phase).toEqual({
        type: 'hand-over',
        result: { kind: 'win', winners, legs, nextDealerSeat: 1, nextRepeatCount: 0 },
      });
    }
  });

  it('exposes an exhaustive-draw result identically to every viewer', () => {
    const state = stateWith({
      phase: { type: 'hand-over', result: { kind: 'exhaustive-draw', nextDealerSeat: 2 as Seat, nextRepeatCount: 1 } },
    });
    const result = view(state, null);
    expect(result.phase).toEqual({
      type: 'hand-over',
      result: { kind: 'exhaustive-draw', nextDealerSeat: 2, nextRepeatCount: 1 },
    });
  });
});

describe('toClientView: matchPoints — fully public, no redaction', () => {
  it('assigns each seat its own matchPoints entry, identically across the viewer, every opponent, and a spectator', () => {
    const state = stateWith({});
    const matchPoints: SeatTotals = [15, -30, 20, -5];

    for (const viewer of [0, 1, 2, 3, null] as (Seat | null)[]) {
      const result = view(state, viewer, 1, matchPoints);
      expect(result.players.map((p) => p.matchPoints)).toEqual([15, -30, 20, -5]);
    }
  });

  it('never gates matchPoints on isViewer/occupied the way concealedTiles/barredVisible are gated', () => {
    const state = stateWith({});
    const matchPoints: SeatTotals = [7, -7, 3, -3];

    const asViewer = view(state, 0 as Seat, 1, matchPoints);
    const asOpponent = view(state, 1 as Seat, 1, matchPoints);
    const asSpectator = view(state, null, 1, matchPoints);

    // Seat 0's matchPoints value is identical no matter who is looking,
    // unlike seat 0's concealedTiles (real for the viewer, null otherwise).
    expect(asViewer.players[0].matchPoints).toBe(7);
    expect(asOpponent.players[0].matchPoints).toBe(7);
    expect(asSpectator.players[0].matchPoints).toBe(7);

    expect(asViewer.players[0].concealedTiles).not.toBeNull();
    expect(asOpponent.players[0].concealedTiles).toBeNull();
    expect(asSpectator.players[0].concealedTiles).toBeNull();
  });
});
