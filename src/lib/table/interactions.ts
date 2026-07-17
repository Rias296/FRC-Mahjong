/**
 * Pure derivation of what interactive surfaces the viewer should be offered,
 * given the current ClientGameView. No React, no fetch, no side effects.
 *
 * Server-authoritative design (see CLAUDE.md): this module never replicates
 * engine legality. It offers buttons wherever contextually sensible (e.g. all
 * three own-turn declarations unconditionally on the viewer's discard turn)
 * and lets the server's RuleError response reject illegal attempts.
 */

import { nextSeat, SEATS, type Seat } from '../../engine/seats';
import type { ClientGameView, ClientPhaseView } from '../protocol';

export type ClaimOffer = 'hu' | 'pung' | 'kong' | 'chow' | 'pass';

export type OwnTurnDeclaration = 'hu' | 'added-kong' | 'concealed-kong';

export interface InteractionModel {
  readonly canDraw: boolean;
  readonly canDiscard: boolean;
  readonly ownTurnDeclarations: readonly OwnTurnDeclaration[];
  readonly claimBar: { readonly offer: readonly ClaimOffer[] } | null;
  readonly robPrompt: 'choose' | 'waiting-declarer' | 'waiting-bystander' | null;
  readonly handOver: 'next-hand' | 'match-complete' | null;
}

const EMPTY_DECLARATIONS: readonly OwnTurnDeclaration[] = [];
const ALL_DECLARATIONS: readonly OwnTurnDeclaration[] = ['hu', 'added-kong', 'concealed-kong'];

const ZERO_INTERACTIONS: InteractionModel = {
  canDraw: false,
  canDiscard: false,
  ownTurnDeclarations: EMPTY_DECLARATIONS,
  claimBar: null,
  robPrompt: null,
  handOver: null,
};

function deriveHandOver(
  phase: ClientPhaseView | null,
  status: ClientGameView['status'],
): 'next-hand' | 'match-complete' | null {
  if (phase === null || phase.type !== 'hand-over') return null;
  if (status === 'in-progress') return 'next-hand';
  if (status === 'finished') return 'match-complete';
  return null;
}

function deriveClaimBar(
  phase: ClientPhaseView,
  viewerSeat: Seat,
): { readonly offer: readonly ClaimOffer[] } | null {
  if (phase.type !== 'awaiting-claims') return null;
  const discarderSeat = phase.discarderSeat;
  if (discarderSeat === undefined || discarderSeat === viewerSeat) return null;
  const respondedSeats = phase.respondedSeats ?? [];
  if (respondedSeats.includes(viewerSeat)) return null;

  const offer: ClaimOffer[] = ['hu', 'pung', 'kong'];
  if (nextSeat(discarderSeat) === viewerSeat) offer.push('chow');
  offer.push('pass');
  return { offer };
}

function deriveRobPrompt(
  phase: ClientPhaseView,
  viewerSeat: Seat,
): 'choose' | 'waiting-declarer' | 'waiting-bystander' | null {
  if (phase.type !== 'awaiting-rob-kong') return null;
  if (phase.youMayRob === true && phase.youHaveResponded !== true) return 'choose';
  if (phase.declarerSeat === viewerSeat) return 'waiting-declarer';
  return 'waiting-bystander';
}

/**
 * Every seat that still has an open, unresolved claim decision on the
 * current discard — everyone except the discarder and everyone already in
 * `respondedSeats`, both fully public/unredacted wire fields (see
 * `views.ts`'s `redactPhase`, unlike `awaiting-rob-kong`'s eligible-robber
 * identities, which ARE redacted — see `deriveRobPrompt`'s doc territory).
 * Empty for every phase type other than `awaiting-claims`.
 *
 * This exists because the engine (`game-state.ts`'s `handleDiscard`) never
 * reassigns `currentTurnSeat` away from the discarder when a claim window
 * opens — it stays pinned to the one seat with nothing left to decide, so
 * `currentTurnSeat` alone cannot answer "who currently has an open window"
 * during `awaiting-claims` the way it correctly can for
 * `awaiting-draw`/`awaiting-discard`. See `isOpponentTimerSeat`'s doc
 * comment for the consumer this was built for (a real bug found in review:
 * the discarder's own view of their opponents, and every already-passed
 * seat's/spectator's view, previously showed the turn-timer countdown ring
 * on the discarder instead of the actual still-deciding claimant(s), or on
 * nobody at all).
 */
export function pendingClaimSeats(view: ClientGameView): readonly Seat[] {
  const phase = view.phase;
  if (phase === null || phase.type !== 'awaiting-claims') return [];
  const discarderSeat = phase.discarderSeat;
  const respondedSeats = phase.respondedSeats ?? [];
  return SEATS.filter((seat) => seat !== discarderSeat && !respondedSeats.includes(seat));
}

/**
 * Which seat's OpponentPanel should show the turn-timer countdown ring for
 * the currently-open decision window (see `turn-timer-ring.tsx`). Phase-aware
 * so it doesn't fall into the `currentTurnSeat`-misattribution bug
 * `pendingClaimSeats` exists to fix: `awaiting-claims` uses the real pending
 * -claimant set (there may be more than one — the ring is a single shared
 * server-anchored deadline for the whole window, so showing it on every
 * still-deciding seat is accurate, not a duplicated timer); every other
 * phase type (including `awaiting-rob-kong`, whose real still-deciding
 * robbers are intentionally redacted — every real player already sees the
 * ring in their own rack instead via `InteractionModel`'s own
 * canDraw/canDiscard/claimBar/robPrompt fields, so this fallback only ever
 * matters for a spectator) keeps the original `currentTurnSeat` comparison,
 * which genuinely is correct there.
 */
export function isOpponentTimerSeat(view: ClientGameView, seat: Seat): boolean {
  if (view.phase?.type === 'awaiting-claims') return pendingClaimSeats(view).includes(seat);
  return view.currentTurnSeat === seat;
}

/**
 * A stable identity for the decision WINDOW the viewer is currently in —
 * NOT a serialization of the whole phase object. `ClientPhaseView` also
 * carries fields that mutate every time any OTHER player responds within a
 * still-open window (`respondedSeats` during awaiting-claims,
 * `youHaveResponded`/`stillWaitingCount` during awaiting-rob-kong). A caller
 * that resets in-progress tile-selection UI on ANY phase-object change (e.g.
 * `JSON.stringify(view.phase)`) will wipe an in-progress chow/kong selection
 * the instant an unrelated seat passes on the same discard. This signature
 * only changes when the window the viewer is actually deciding in changes:
 * a new draw on their own turn, a new discard to claim, or a new rob-kong
 * declaration.
 */
export function computeSelectionWindowSignature(view: ClientGameView): string {
  const phase = view.phase;
  switch (phase?.type) {
    case 'awaiting-draw':
      // Seat-qualified so two consecutive different seats' draw turns (e.g.
      // an entire idle/disconnected turn timing out between two ~1.5s SSE
      // polls) are never mistaken for the same window — mirrors the server
      // twin, computeWindowSignature in src/server/replay.ts.
      return `draw:${view.currentTurnSeat}`;
    case 'awaiting-discard':
      return `discard:${view.currentTurnSeat}:${phase.drawnTileForViewer?.id ?? 'none'}`;
    case 'awaiting-claims':
      return `claims:${phase.discarderSeat}:${phase.discardedTile?.id ?? 'none'}`;
    case 'awaiting-rob-kong':
      return `rob:${phase.declarerSeat}:${phase.kongTileVisible?.id ?? 'concealed'}`;
    default:
      return phase?.type ?? 'none';
  }
}

export function deriveInteractions(view: ClientGameView): InteractionModel {
  if (view.viewerSeat === null) return ZERO_INTERACTIONS;

  const viewerSeat = view.viewerSeat;
  const phase = view.phase;
  const handOver = deriveHandOver(phase, view.status);

  if (phase === null) {
    return { ...ZERO_INTERACTIONS, handOver };
  }

  const canDraw = phase.type === 'awaiting-draw' && view.currentTurnSeat === viewerSeat;
  const canDiscard = phase.type === 'awaiting-discard' && view.currentTurnSeat === viewerSeat;
  const ownTurnDeclarations = canDiscard ? ALL_DECLARATIONS : EMPTY_DECLARATIONS;
  const claimBar = deriveClaimBar(phase, viewerSeat);
  const robPrompt = deriveRobPrompt(phase, viewerSeat);

  return { canDraw, canDiscard, ownTurnDeclarations, claimBar, robPrompt, handOver };
}
