/**
 * Pure derivation of what interactive surfaces the viewer should be offered,
 * given the current ClientGameView. No React, no fetch, no side effects.
 *
 * Server-authoritative design (see CLAUDE.md): this module never replicates
 * engine legality. It offers buttons wherever contextually sensible (e.g. all
 * three own-turn declarations unconditionally on the viewer's discard turn)
 * and lets the server's RuleError response reject illegal attempts.
 */

import { nextSeat, type Seat } from '../../engine/seats';
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
