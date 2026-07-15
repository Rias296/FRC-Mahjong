import { describe, expect, it } from 'vitest';
import { computeSelectionWindowSignature, deriveInteractions } from './interactions';
import { SEATS, nextSeat, type Seat } from '../../engine/seats';
import type { ClientGameView, ClientPhaseView, ClientPlayerView } from '../protocol';

function player(seat: Seat, isViewer: boolean): ClientPlayerView {
  return {
    seat,
    displayName: `Player ${seat}`,
    isViewer,
    occupied: true,
    concealedTiles: isViewer ? [] : null,
    concealedCount: 16,
    melds: [],
    flowers: [],
    discards: [],
    barredVisible: isViewer ? false : null,
  };
}

function makeView(opts: {
  readonly viewerSeat: Seat | null;
  readonly currentTurnSeat: Seat | null;
  readonly phase: ClientPhaseView | null;
  readonly status?: ClientGameView['status'];
}): ClientGameView {
  const { viewerSeat, currentTurnSeat, phase, status = 'in-progress' } = opts;
  return {
    seq: 1,
    roomCode: 'ABCDEF',
    status,
    handNumber: 1,
    prevailingWind: 'east',
    players: SEATS.map((seat) => player(seat, seat === viewerSeat)),
    wallRemaining: 60,
    phase,
    viewerSeat,
    currentTurnSeat,
    dealerSeat: 0,
    repeatCount: 0,
  };
}

describe('deriveInteractions — awaiting-draw', () => {
  it('offers draw only to the seat matching currentTurnSeat', () => {
    for (const turnSeat of SEATS) {
      for (const viewerSeat of SEATS) {
        const view = makeView({
          viewerSeat,
          currentTurnSeat: turnSeat,
          phase: { type: 'awaiting-draw' },
        });
        const model = deriveInteractions(view);
        expect(model.canDraw).toBe(viewerSeat === turnSeat);
      }
    }
  });
});

describe('deriveInteractions — awaiting-discard', () => {
  it("enables discard and offers hu, added-kong, and concealed-kong unconditionally on viewer's turn", () => {
    const view = makeView({
      viewerSeat: 0,
      currentTurnSeat: 0,
      phase: { type: 'awaiting-discard', drawnTileForViewer: null },
    });
    const model = deriveInteractions(view);
    expect(model.canDiscard).toBe(true);
    expect(model.ownTurnDeclarations).toEqual(['hu', 'added-kong', 'concealed-kong']);
  });

  it('offers nothing on another seat\'s turn', () => {
    const view = makeView({
      viewerSeat: 0,
      currentTurnSeat: 1,
      phase: { type: 'awaiting-discard', drawnTileForViewer: null },
    });
    const model = deriveInteractions(view);
    expect(model.canDiscard).toBe(false);
    expect(model.ownTurnDeclarations).toEqual([]);
  });
});

describe('deriveInteractions — ownTurnDeclarations exhaustiveness', () => {
  it('is non-empty iff phase.type === "awaiting-discard" AND currentTurnSeat === viewerSeat, across every phase type x seat combo', () => {
    const phasesByType: Record<string, ClientPhaseView> = {
      'awaiting-draw': { type: 'awaiting-draw' },
      'awaiting-discard': { type: 'awaiting-discard', drawnTileForViewer: null },
      'awaiting-claims': {
        type: 'awaiting-claims',
        discarderSeat: 0,
        discardedTile: { id: 't1', kind: { category: 'suit', suit: 'wan', rank: 1 as const } },
        respondedSeats: [],
      },
      'awaiting-rob-kong': {
        type: 'awaiting-rob-kong',
        declarerSeat: 0,
        kongTileVisible: null,
        youMayRob: false,
        youHaveResponded: false,
        stillWaitingCount: 1,
      },
      'hand-over': { type: 'hand-over' },
    };

    for (const [phaseType, phase] of Object.entries(phasesByType)) {
      for (const turnSeat of SEATS) {
        for (const viewerSeat of SEATS) {
          const view = makeView({ viewerSeat, currentTurnSeat: turnSeat, phase });
          const model = deriveInteractions(view);
          const expectNonEmpty = phaseType === 'awaiting-discard' && turnSeat === viewerSeat;
          expect(
            model.ownTurnDeclarations.length > 0,
            `phase=${phaseType} turnSeat=${turnSeat} viewerSeat=${viewerSeat}`,
          ).toBe(expectNonEmpty);
          if (expectNonEmpty) {
            expect(model.ownTurnDeclarations).toEqual(['hu', 'added-kong', 'concealed-kong']);
          }
        }
      }
    }
  });

  it('stays empty when currentTurnSeat === viewerSeat but the viewer is a spectator (viewerSeat null) even during awaiting-discard', () => {
    const view = makeView({
      viewerSeat: null,
      currentTurnSeat: 0,
      phase: { type: 'awaiting-discard', drawnTileForViewer: null },
    });
    expect(deriveInteractions(view).ownTurnDeclarations).toEqual([]);
  });
});

describe('deriveInteractions — awaiting-claims', () => {
  const discarderSeat: Seat = 0;
  const discardedTile = { id: 'wan-5-copy1', kind: { category: 'suit' as const, suit: 'wan' as const, rank: 5 as const } };

  function claimsPhase(respondedSeats: readonly Seat[]): ClientPhaseView {
    return {
      type: 'awaiting-claims',
      discarderSeat,
      discardedTile,
      respondedSeats,
    };
  }

  it('shows the claim bar only to unresponded non-discarder seats', () => {
    const discarderView = makeView({ viewerSeat: discarderSeat, currentTurnSeat: 1, phase: claimsPhase([]) });
    expect(deriveInteractions(discarderView).claimBar).toBeNull();

    const respondedSeat: Seat = 1;
    const respondedView = makeView({
      viewerSeat: respondedSeat,
      currentTurnSeat: 1,
      phase: claimsPhase([respondedSeat]),
    });
    expect(deriveInteractions(respondedView).claimBar).toBeNull();

    const unrespondedSeat: Seat = 2;
    const unrespondedView = makeView({
      viewerSeat: unrespondedSeat,
      currentTurnSeat: 1,
      phase: claimsPhase([]),
    });
    expect(deriveInteractions(unrespondedView).claimBar).not.toBeNull();
  });

  it('offers chow only to the seat immediately after the discarder', () => {
    const nonDiscarderSeats = SEATS.filter((s) => s !== discarderSeat);
    for (const seat of nonDiscarderSeats) {
      const view = makeView({ viewerSeat: seat, currentTurnSeat: 1, phase: claimsPhase([]) });
      const model = deriveInteractions(view);
      const shouldOfferChow = nextSeat(discarderSeat) === seat;
      expect(model.claimBar?.offer.includes('chow')).toBe(shouldOfferChow);
      expect(model.claimBar?.offer).toEqual(
        expect.arrayContaining(['hu', 'pung', 'kong', 'pass']),
      );
    }
  });

  it('hides the bar once viewerSeat appears in respondedSeats', () => {
    const seat: Seat = 2;
    const view = makeView({ viewerSeat: seat, currentTurnSeat: 1, phase: claimsPhase([seat]) });
    expect(deriveInteractions(view).claimBar).toBeNull();
  });

  it('composes the EXACT offer array (order + contents) for every discarder seat 0..3, catching off-by-one wraparound (esp. discarder=3 -> nextSeat=0)', () => {
    for (const discarder of SEATS) {
      for (const seat of SEATS) {
        if (seat === discarder) continue; // discarder never sees a claim bar (covered separately)
        const phase: ClientPhaseView = {
          type: 'awaiting-claims',
          discarderSeat: discarder,
          discardedTile,
          respondedSeats: [],
        };
        const view = makeView({ viewerSeat: seat, currentTurnSeat: discarder, phase });
        const model = deriveInteractions(view);
        const isAdjacent = nextSeat(discarder) === seat;
        const expected = isAdjacent ? ['hu', 'pung', 'kong', 'chow', 'pass'] : ['hu', 'pung', 'kong', 'pass'];
        expect(model.claimBar?.offer).toEqual(expected);
      }
    }
  });

  it('discarder=3 wraps to seat 0 for the chow offer (explicit wraparound case)', () => {
    const phase: ClientPhaseView = {
      type: 'awaiting-claims',
      discarderSeat: 3,
      discardedTile,
      respondedSeats: [],
    };
    const view = makeView({ viewerSeat: 0, currentTurnSeat: 3, phase });
    const model = deriveInteractions(view);
    expect(model.claimBar?.offer).toEqual(['hu', 'pung', 'kong', 'chow', 'pass']);
  });

  it('a non-adjacent non-discarder seat gets hu/pung/kong/pass but explicitly NOT chow (exact array, not just .includes)', () => {
    // discarder=1 (South); nextSeat(1)=2 (West) is the only chow-eligible seat.
    // Seat 3 (North) and seat 0 (East) are non-discarder, non-adjacent.
    for (const nonAdjacentSeat of [0, 3] as const) {
      const phase: ClientPhaseView = {
        type: 'awaiting-claims',
        discarderSeat: 1,
        discardedTile,
        respondedSeats: [],
      };
      const view = makeView({ viewerSeat: nonAdjacentSeat, currentTurnSeat: 1, phase });
      const model = deriveInteractions(view);
      expect(model.claimBar?.offer).toEqual(['hu', 'pung', 'kong', 'pass']);
      expect(model.claimBar?.offer.includes('chow')).toBe(false);
    }
  });
});

describe('deriveInteractions — awaiting-rob-kong', () => {
  const declarerSeat: Seat = 0;
  const kongTile = { id: 'wan-9-copy1', kind: { category: 'suit' as const, suit: 'wan' as const, rank: 9 as const } };

  function robPhase(overrides: Partial<ClientPhaseView>): ClientPhaseView {
    return {
      type: 'awaiting-rob-kong',
      declarerSeat,
      kongTileVisible: kongTile,
      youMayRob: false,
      youHaveResponded: false,
      stillWaitingCount: 2,
      ...overrides,
    };
  }

  it("offers rob/pass (robPrompt='choose') iff youMayRob and not youHaveResponded", () => {
    const seat: Seat = 1;

    const eligibleUnresponded = makeView({
      viewerSeat: seat,
      currentTurnSeat: declarerSeat,
      phase: robPhase({ youMayRob: true, youHaveResponded: false }),
    });
    expect(deriveInteractions(eligibleUnresponded).robPrompt).toBe('choose');

    const eligibleResponded = makeView({
      viewerSeat: seat,
      currentTurnSeat: declarerSeat,
      phase: robPhase({ youMayRob: true, youHaveResponded: true }),
    });
    expect(deriveInteractions(eligibleResponded).robPrompt).not.toBe('choose');

    const ineligible = makeView({
      viewerSeat: seat,
      currentTurnSeat: declarerSeat,
      phase: robPhase({ youMayRob: false, youHaveResponded: false }),
    });
    expect(deriveInteractions(ineligible).robPrompt).not.toBe('choose');
  });

  it('renders waiting-declarer for the declarer and waiting-bystander for everyone else with no rob prompt', () => {
    const declarerView = makeView({
      viewerSeat: declarerSeat,
      currentTurnSeat: declarerSeat,
      phase: robPhase({ youMayRob: false, youHaveResponded: false }),
    });
    expect(deriveInteractions(declarerView).robPrompt).toBe('waiting-declarer');

    const bystanderSeat: Seat = 3;
    const bystanderView = makeView({
      viewerSeat: bystanderSeat,
      currentTurnSeat: declarerSeat,
      phase: robPhase({ youMayRob: false, youHaveResponded: false }),
    });
    expect(deriveInteractions(bystanderView).robPrompt).toBe('waiting-bystander');
  });
});

describe('deriveInteractions — hand-over', () => {
  it('offers next-hand while status is in-progress and match-complete when status is finished', () => {
    const inProgress = makeView({
      viewerSeat: 0,
      currentTurnSeat: null,
      phase: { type: 'hand-over' },
      status: 'in-progress',
    });
    expect(deriveInteractions(inProgress).handOver).toBe('next-hand');

    const finished = makeView({
      viewerSeat: 0,
      currentTurnSeat: null,
      phase: { type: 'hand-over' },
      status: 'finished',
    });
    expect(deriveInteractions(finished).handOver).toBe('match-complete');
  });
});

describe('deriveInteractions — spectator (viewerSeat === null)', () => {
  it('yields zero interactions in every phase, including handOver', () => {
    const phases: readonly ClientPhaseView[] = [
      { type: 'awaiting-draw' },
      { type: 'awaiting-discard', drawnTileForViewer: null },
      {
        type: 'awaiting-claims',
        discarderSeat: 0,
        discardedTile: { id: 't1', kind: { category: 'suit', suit: 'wan', rank: 1 as const } },
        respondedSeats: [],
      },
      {
        type: 'awaiting-rob-kong',
        declarerSeat: 0,
        kongTileVisible: null,
        youMayRob: false,
        youHaveResponded: false,
        stillWaitingCount: 1,
      },
      { type: 'hand-over' },
    ];

    for (const phase of phases) {
      for (const status of ['in-progress', 'finished'] as const) {
        const view = makeView({ viewerSeat: null, currentTurnSeat: 0, phase, status });
        const model = deriveInteractions(view);
        expect(model.canDraw).toBe(false);
        expect(model.canDiscard).toBe(false);
        expect(model.ownTurnDeclarations).toEqual([]);
        expect(model.claimBar).toBeNull();
        expect(model.robPrompt).toBeNull();
        expect(model.handOver).toBeNull();
      }
    }
  });
});

describe('computeSelectionWindowSignature', () => {
  // Regression test: a prior implementation keyed the selection-reset off
  // JSON.stringify(view.phase), which changes every time ANY other seat
  // responds within an already-open window (respondedSeats,
  // youHaveResponded, stillWaitingCount all mutate mid-window) — wiping an
  // in-progress chow/kong tile selection the instant an unrelated player
  // passed on the same discard. The signature must stay stable while only
  // those fields change, and must change when the actual window changes.

  it('awaiting-claims: stays stable as other seats respond to the same discard (respondedSeats growing)', () => {
    const base = (responded: readonly Seat[]) =>
      makeView({
        viewerSeat: 3,
        currentTurnSeat: 0,
        phase: {
          type: 'awaiting-claims',
          discarderSeat: 0,
          discardedTile: { id: 'tile-42', kind: { category: 'suit', suit: 'tong', rank: 5 as const } },
          respondedSeats: responded,
        },
      });

    const before = computeSelectionWindowSignature(base([]));
    const afterOneResponded = computeSelectionWindowSignature(base([1]));
    const afterTwoResponded = computeSelectionWindowSignature(base([1, 2]));

    expect(afterOneResponded).toBe(before);
    expect(afterTwoResponded).toBe(before);
  });

  it('awaiting-claims: changes when the discarded tile (a genuinely new window) changes', () => {
    const windowA = makeView({
      viewerSeat: 3,
      currentTurnSeat: 0,
      phase: {
        type: 'awaiting-claims',
        discarderSeat: 0,
        discardedTile: { id: 'tile-A', kind: { category: 'suit', suit: 'tong', rank: 5 as const } },
        respondedSeats: [],
      },
    });
    const windowB = makeView({
      viewerSeat: 3,
      currentTurnSeat: 1,
      phase: {
        type: 'awaiting-claims',
        discarderSeat: 1,
        discardedTile: { id: 'tile-B', kind: { category: 'suit', suit: 'tong', rank: 6 as const } },
        respondedSeats: [],
      },
    });

    expect(computeSelectionWindowSignature(windowA)).not.toBe(computeSelectionWindowSignature(windowB));
  });

  it('awaiting-rob-kong: stays stable as youHaveResponded/stillWaitingCount change for the same declaration', () => {
    const base = (youHaveResponded: boolean, stillWaitingCount: number) =>
      makeView({
        viewerSeat: 1,
        currentTurnSeat: 0,
        phase: {
          type: 'awaiting-rob-kong',
          declarerSeat: 0,
          kongTileVisible: { id: 'kong-tile-1', kind: { category: 'dragon', dragon: 'red' } },
          youMayRob: true,
          youHaveResponded,
          stillWaitingCount,
        },
      });

    const before = computeSelectionWindowSignature(base(false, 2));
    const afterSelfResponded = computeSelectionWindowSignature(base(true, 2));
    const afterOthersResponded = computeSelectionWindowSignature(base(true, 1));

    expect(afterSelfResponded).toBe(before);
    expect(afterOthersResponded).toBe(before);
  });

  it('awaiting-rob-kong: changes when the declarer or kong tile (a new declaration) changes', () => {
    const declarationA = makeView({
      viewerSeat: 1,
      currentTurnSeat: 0,
      phase: {
        type: 'awaiting-rob-kong',
        declarerSeat: 0,
        kongTileVisible: { id: 'kong-A', kind: { category: 'dragon', dragon: 'red' } },
        youMayRob: true,
        youHaveResponded: false,
        stillWaitingCount: 1,
      },
    });
    const declarationB = makeView({
      viewerSeat: 1,
      currentTurnSeat: 2,
      phase: {
        type: 'awaiting-rob-kong',
        declarerSeat: 2,
        kongTileVisible: { id: 'kong-B', kind: { category: 'dragon', dragon: 'green' } },
        youMayRob: true,
        youHaveResponded: false,
        stillWaitingCount: 1,
      },
    });

    expect(computeSelectionWindowSignature(declarationA)).not.toBe(computeSelectionWindowSignature(declarationB));
  });

  it('awaiting-discard: changes on a genuinely new draw for the same seat, stable otherwise', () => {
    const drawA = makeView({
      viewerSeat: 0,
      currentTurnSeat: 0,
      phase: { type: 'awaiting-discard', drawnTileForViewer: { id: 'drawn-A', kind: { category: 'suit', suit: 'wan', rank: 1 as const } } },
    });
    const drawASame = makeView({
      viewerSeat: 0,
      currentTurnSeat: 0,
      phase: { type: 'awaiting-discard', drawnTileForViewer: { id: 'drawn-A', kind: { category: 'suit', suit: 'wan', rank: 1 as const } } },
    });
    const drawB = makeView({
      viewerSeat: 0,
      currentTurnSeat: 0,
      phase: { type: 'awaiting-discard', drawnTileForViewer: { id: 'drawn-B', kind: { category: 'suit', suit: 'wan', rank: 2 as const } } },
    });

    expect(computeSelectionWindowSignature(drawA)).toBe(computeSelectionWindowSignature(drawASame));
    expect(computeSelectionWindowSignature(drawA)).not.toBe(computeSelectionWindowSignature(drawB));
  });

  it('changes across different phase types entirely', () => {
    const drawPhase = makeView({ viewerSeat: 0, currentTurnSeat: 0, phase: { type: 'awaiting-draw' } });
    const discardPhase = makeView({
      viewerSeat: 0,
      currentTurnSeat: 0,
      phase: { type: 'awaiting-discard', drawnTileForViewer: null },
    });
    const nullPhase = makeView({ viewerSeat: 0, currentTurnSeat: null, phase: null, status: 'waiting-for-players' });

    const sigs = new Set([
      computeSelectionWindowSignature(drawPhase),
      computeSelectionWindowSignature(discardPhase),
      computeSelectionWindowSignature(nullPhase),
    ]);
    expect(sigs.size).toBe(3);
  });
});
