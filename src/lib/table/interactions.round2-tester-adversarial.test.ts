/**
 * Tester-round finding, FIXED: `computeSelectionWindowSignature` (this file)
 * is the documented client-side twin of `src/server/replay.ts`'s internal
 * `computeWindowSignature` — the server-authoritative turn-timer round's
 * review explicitly called for comparing the two line-by-line (see the
 * orchestrator brief for this round, item 2).
 *
 * ORIGINAL FINDING: for phase.type === 'awaiting-draw', the two functions
 * disagreed — the server was seat-qualified (`awaiting-draw:${seat}`), the
 * client fell through to the unqualified `default` branch (bare
 * `phase.type`). This mattered because the client only ever compares
 * consecutive DB-polling SSE snapshots (~1.5s interval), not a row-by-row
 * fold: if an entire turn auto-timed-out end-to-end between two poll ticks
 * (a disconnected/idle opponent), the client could observe seat A's
 * awaiting-draw -> seat B's awaiting-draw as its only two snapshots and
 * wrongly treat B's freshly-opened window as a continuation of A's already
 * -expired one — exactly the signature Round 3's turn-timer countdown ring
 * consumes to detect "did a new deadline just start".
 *
 * FIX (orchestrator, immediately after this finding): added an explicit
 * `case 'awaiting-draw': return \`draw:${view.currentTurnSeat}\`;` mirroring
 * the server's seat-qualified form. Both tests below now assert the FIXED
 * (seat-qualified) behavior.
 */
import { describe, expect, it } from 'vitest';
import { computeSelectionWindowSignature } from './interactions';
import type { ClientGameView, ClientPlayerView } from '../protocol';
import type { Seat } from '../../engine/seats';

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

function awaitingDrawView(currentTurnSeat: Seat, viewerSeat: Seat | null): ClientGameView {
  return {
    seq: 1,
    roomCode: 'ABCDEF',
    status: 'in-progress',
    handNumber: 1,
    prevailingWind: 'east',
    players: [0, 1, 2, 3].map((s) => player(s as Seat, s === viewerSeat)),
    wallRemaining: 60,
    phase: { type: 'awaiting-draw' },
    viewerSeat,
    currentTurnSeat,
    dealerSeat: 0,
    repeatCount: 0,
  };
}

function robKongBystanderView(declarerSeat: Seat, kongTileVisible: { id: string } | null): ClientGameView {
  return {
    seq: 1,
    roomCode: 'ABCDEF',
    status: 'in-progress',
    handNumber: 1,
    prevailingWind: 'east',
    players: [0, 1, 2, 3].map((s) => player(s as Seat, s === 3)),
    wallRemaining: 60,
    phase: {
      type: 'awaiting-rob-kong',
      declarerSeat,
      kongTileVisible: kongTileVisible === null ? null : { id: kongTileVisible.id, kind: { category: 'dragon', dragon: 'red' } },
      youMayRob: false,
      stillWaitingCount: 2,
    },
    viewerSeat: 3,
    currentTurnSeat: declarerSeat,
    dealerSeat: 0,
    repeatCount: 0,
  };
}

describe(
  'computeSelectionWindowSignature — SECONDARY GAP: a bystander cannot distinguish two consecutive ' +
    "concealed-kong rob declarations by the SAME seat (both redact kongTileVisible to null, and the " +
    "client's fallback constant 'concealed' loses the real tile identity the server always has access to)",
  () => {
    it(
      'CONFIRMS THE GAP (passes today, documenting current behavior): two different concealed-kong ' +
        'declarations by the same declarer, as seen by an ineligible bystander, produce the SAME signature',
      () => {
        const firstConcealedKong = robKongBystanderView(0, null);
        const secondConcealedKong = robKongBystanderView(0, null);

        // Server-side, these are genuinely different windows (different real
        // kongTile.id folded into computeWindowSignature, which operates on
        // the unredacted GameState) — but the client, redacting the tile to
        // null for a non-eligible bystander, cannot tell them apart.
        expect(computeSelectionWindowSignature(firstConcealedKong)).toBe(
          computeSelectionWindowSignature(secondConcealedKong),
        );
      },
    );

    it('a declarer or eligible robber (who DOES see the real tile) correctly distinguishes them', () => {
      const declarerFirst = { ...robKongBystanderView(0, { id: 'kong-A' }), viewerSeat: 0 as Seat };
      const declarerSecond = { ...robKongBystanderView(0, { id: 'kong-B' }), viewerSeat: 0 as Seat };
      expect(computeSelectionWindowSignature(declarerFirst)).not.toBe(computeSelectionWindowSignature(declarerSecond));
    });
  },
);

describe('computeSelectionWindowSignature — FIXED to match the server twin (see file doc comment)', () => {
  it('distinguishes two different seats’ awaiting-draw windows, matching the server’s computeWindowSignature', () => {
    const seatAWindow = awaitingDrawView(0, 3);
    const seatBWindow = awaitingDrawView(1, 3);

    const sigA = computeSelectionWindowSignature(seatAWindow);
    const sigB = computeSelectionWindowSignature(seatBWindow);

    expect(sigA).not.toBe(sigB);
  });

  it('is seat-qualified (draw:<seat>), not the bare unqualified phase type', () => {
    const seatAWindow = awaitingDrawView(0, 3);
    const seatBWindow = awaitingDrawView(1, 3);

    expect(computeSelectionWindowSignature(seatAWindow)).toBe('draw:0');
    expect(computeSelectionWindowSignature(seatBWindow)).toBe('draw:1');
  });
});
