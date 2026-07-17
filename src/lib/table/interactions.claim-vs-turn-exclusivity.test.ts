import { describe, expect, it } from 'vitest';
import { deriveInteractions } from './interactions';
import { SEATS, type Seat } from '../../engine/seats';
import type { ClientGameView, ClientPhaseView, ClientPlayerView } from '../protocol';

/**
 * Regression guard for the Round-1 UI overhaul's `ClaimActionBar` merge
 * (own-turn declarations + claim-on-discard offers unified into one
 * floating component — see src/components/table/claim-action-bar.tsx).
 *
 * That component trusts `InteractionModel` to never hand it a
 * simultaneously-populated `claimBar` AND `canDraw`/`ownTurnDeclarations` —
 * it has no runtime guard of its own against that combination, it just
 * renders whatever it's given. This file asserts the invariant holds for
 * every phase type x seat combination the model can be constructed from, so
 * a future change to `deriveInteractions` that accidentally lets both
 * populate at once (which would render BOTH button clusters stacked in the
 * same floating anchor) fails loudly here instead of only visually.
 */

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
    matchPoints: 0,
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

function allPhases(): readonly ClientPhaseView[] {
  return [
    { type: 'awaiting-draw' },
    { type: 'awaiting-discard', drawnTileForViewer: null },
    {
      type: 'awaiting-discard',
      drawnTileForViewer: { id: 'drawn-1', kind: { category: 'suit', suit: 'wan', rank: 1 as const } },
    },
    {
      type: 'awaiting-claims',
      discarderSeat: 0,
      discardedTile: { id: 'disc-1', kind: { category: 'suit', suit: 'wan', rank: 1 as const } },
      respondedSeats: [],
    },
    {
      type: 'awaiting-claims',
      discarderSeat: 2,
      discardedTile: { id: 'disc-2', kind: { category: 'suit', suit: 'tiao', rank: 5 as const } },
      respondedSeats: [1],
    },
    {
      type: 'awaiting-rob-kong',
      declarerSeat: 1,
      kongTileVisible: { id: 'kong-1', kind: { category: 'dragon', dragon: 'red' } },
      youMayRob: true,
      youHaveResponded: false,
      stillWaitingCount: 2,
    },
    { type: 'hand-over' },
  ];
}

describe('deriveInteractions — claimBar vs own-turn-declarations mutual exclusivity', () => {
  it('never populates claimBar together with canDraw or ownTurnDeclarations, for any phase x seat x turn combo', () => {
    let sawClaimBar = false;
    let sawOwnTurn = false;

    for (const phase of allPhases()) {
      for (const currentTurnSeat of SEATS) {
        for (const viewerSeat of SEATS) {
          const model = deriveInteractions(makeView({ viewerSeat, currentTurnSeat, phase }));
          const hasClaimBar = model.claimBar !== null;
          const hasOwnTurn = model.canDraw || model.ownTurnDeclarations.length > 0;

          if (hasClaimBar) sawClaimBar = true;
          if (hasOwnTurn) sawOwnTurn = true;

          expect(
            hasClaimBar && hasOwnTurn,
            `phase=${phase.type} currentTurnSeat=${currentTurnSeat} viewerSeat=${viewerSeat} ` +
              `claimBar=${JSON.stringify(model.claimBar)} canDraw=${model.canDraw} ownTurnDeclarations=${JSON.stringify(model.ownTurnDeclarations)}`,
          ).toBe(false);
        }
      }
    }

    // Sanity check on the sweep itself: both branches must actually have
    // fired at least once, or the "never both" assertion above would be
    // vacuously true.
    expect(sawClaimBar).toBe(true);
    expect(sawOwnTurn).toBe(true);
  });

  it('never populates claimBar together with a non-null robPrompt', () => {
    for (const phase of allPhases()) {
      for (const currentTurnSeat of SEATS) {
        for (const viewerSeat of SEATS) {
          const model = deriveInteractions(makeView({ viewerSeat, currentTurnSeat, phase }));
          if (model.claimBar !== null) {
            expect(model.robPrompt).toBeNull();
          }
          if (model.robPrompt !== null) {
            expect(model.claimBar).toBeNull();
          }
        }
      }
    }
  });
});
