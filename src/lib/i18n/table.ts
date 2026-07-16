/**
 * Table-chrome user-facing strings (English) — status strip labels, phase
 * narration, and hand-over copy for the in-progress/finished game table.
 * This is NOT game-domain vocabulary (seat labels, tai/ranking-points,
 * action names) — that stays in src/lib/theme/frc.ts. i18n-ready: keep
 * every user-facing string here, none inline in components.
 */

import type { RuleErrorCode } from '../../engine/game-state';

export const TABLE_STRINGS = {
  // Status strip
  wallLabel: 'Wall',
  handLabel: 'Hand',
  currentTurnLabel: 'Current turn',
  dealerLabel: 'Dealer',
  repeatLabel: 'Repeat',
  nextDealerLabel: 'Next dealer',

  // Hand-over copy
  winsSuffix: 'wins',
  winTypeSelfDraw: 'self-drawn',
  winTypeDiscard: 'off the discard',
  winTypeRobbedKong: 'by robbing the kong',
  paysWord: 'pays',
  handEndsInDraw: 'The hand ends in a draw',
  huHeading: 'HU!',

  // Phase narration / claim window
  barredBadge: 'Barred',
  dealerBadge: 'Dealer',

  // Chow tile selection
  chowSelectPrompt: 'Select 2 tiles from your hand to complete the chow',
  chowSelectConfirm: 'Confirm Chow',
  selectionCancelButton: 'Cancel',

  // Kong declarations
  addedKongButton: 'Kong (Added)',
  concealedKongButton: 'Kong (Concealed)',
  addedKongSelectPrompt: 'Select a tile to add to an exposed pung',
  concealedKongSelectPrompt: 'Select one tile of the set to declare as a concealed kong',

  // Next hand / match complete
  nextHandButton: 'Next Hand',
  backToHomeButton: 'Back to Home',

  // Match points HUD / settlement / standings
  pointsUnitLabel: 'pts',
  settlementHeading: 'Settlement',
  standingsHeading: 'Final Standings',
  championLabel: 'Champion',

  // Rob kong prompt
  robWindowNote: "Passing means you can't win off a discard or rob until your next discard",
  robWaitingDeclarer: 'Rob window open —',
  robWaitingBystander: 'Rob window open —',
  concealedKongDeclaredNote: 'A concealed kong was declared',
  robKongPromptLabel: 'Rob kong',

  // Claim action bar
  claimActionsLabel: 'Claim actions',

  // Toasts
  benignRaceMessage: 'That window already closed',
} as const;

const RULE_ERROR_MESSAGES: Readonly<Record<RuleErrorCode, string>> = {
  'wrong-phase': "You can't do that right now",
  'wrong-seat': "It's not your turn",
  'hand-is-over': 'This hand has already ended',
  'already-responded': "You've already responded",
  'tile-not-in-hand': "That tile isn't in your hand anymore",
  'illegal-claim': "You can't make that claim",
  'illegal-kong': "You can't declare that kong",
  'barred-by-sacred-discard': "You can't win on this tile right now",
  'below-minimum-tai': "That hand doesn't have enough ranking points to win",
  'not-a-winning-hand': "That's not a winning hand",
  'no-replacement-available': 'No replacement tile is available',
};

/** Short, player-facing copy for a server-rejected action. Exhaustive over RuleErrorCode. */
export function ruleErrorMessage(code: RuleErrorCode): string {
  return RULE_ERROR_MESSAGES[code];
}

/** "waiting on {n} player(s)..." — falls back to "some" when the count is unknown. */
export function waitingOnPlayersNarration(count: number | undefined): string {
  if (count === undefined) return 'waiting on some player(s)...';
  return `waiting on ${count} player${count === 1 ? '' : 's'}...`;
}

/**
 * "{payerName} pays {payeeName} {amount}" — amount should already be
 * display-formatted (payment-leg amounts are match points, pool-scale; use
 * frc.ts's `formatMatchPoints` plus `TABLE_STRINGS.pointsUnitLabel`, never
 * `formatTai` — tai and match points are different units, see frc.ts's
 * `formatMatchPoints` doc comment).
 */
export function paymentLegNarration(payerName: string, payeeName: string, amount: string): string {
  return `${payerName} ${TABLE_STRINGS.paysWord} ${payeeName} ${amount}`;
}

const PLACE_LABELS: Readonly<Record<1 | 2 | 3 | 4, string>> = {
  1: '1st',
  2: '2nd',
  3: '3rd',
  4: '4th',
};

/** Ordinal place label ("1st".."4th") for a standings row (matches SeatStanding.place's 1|2|3|4 shape). */
export function placeLabel(place: 1 | 2 | 3 | 4): string {
  return PLACE_LABELS[place];
}
