/**
 * Lobby-chrome user-facing strings (English). Everything here is copy for
 * the home page and the room/[code] waiting-room flow: form labels, button
 * text, toast/error copy, and waiting-room status copy.
 *
 * Game-domain vocabulary (seat labels, status labels, action labels) lives
 * in src/lib/theme/frc.ts and is NOT duplicated here — this file is strictly
 * lobby-chrome copy. i18n-ready: a future zh-Hant translation swaps this
 * module wholesale, so keep every user-facing string here, none inline in
 * components.
 */

export const LOBBY_STRINGS = {
  // Page / branding
  appTitle: 'Taiwan Mahjong FRC',
  appTagline: 'Taiwanese 16-tile mahjong, FRC-robotics themed.',

  // Form labels
  displayNameLabel: 'Display Name',
  displayNamePlaceholder: 'Enter your name',
  roomCodeLabel: 'Room Code',
  roomCodePlaceholder: 'ABC234',

  // Buttons
  createMatchButton: 'Create Match',
  creatingMatchButton: 'Creating…',
  joinMatchButton: 'Join Match',
  joiningMatchButton: 'Joining…',
  copyCodeButton: 'Copy Code',
  copiedButton: 'Copied!',
  retryButton: 'Retry',
  backToHomeButton: 'Back to Home',

  // Validation
  displayNameRequired: 'Enter a display name.',
  roomCodeRequired: 'Enter a room code.',
  roomCodeInvalidFormat: 'That room code doesn’t look right. Double-check it and try again.',

  // create/join failure toasts
  errorRoomFull: 'That match is already full.',
  errorAlreadyStarted: 'That match has already started.',
  errorRoomNotFound: 'No match found with that room code.',
  errorNetwork: 'Couldn’t reach the server. Check your connection and try again.',
  errorServer: 'Something went wrong on our end. Please try again.',
  errorStaleSession: 'Your saved session is no longer valid.',
  errorGeneric: 'Something went wrong. Please try again.',

  // Copy-to-clipboard toasts
  copySuccessToast: 'Room code copied to clipboard.',
  copyFailureToast: 'Couldn’t copy the room code. Copy it manually instead.',

  // Resume-session banner
  resumeSessionPrefix: 'You have a match in progress:',
  resumeSessionLink: 'Rejoin match',

  // Waiting room
  waitingForPlayers: 'Waiting for players…',
  waitingForPlayerPlaceholder: 'Waiting for player…',
  matchStagingHeading: 'Match Staging',
  youBadge: 'You',
  tableOpensWhenFull: 'The table opens as soon as all four seats are filled.',

  // Room page states
  matchNotFoundHeading: 'Match Not Found',
  matchNotFoundBody: 'This match no longer exists, or the room code is incorrect.',
  joinThisMatchHeading: 'Join This Match',
} as const;
