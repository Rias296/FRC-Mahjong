/**
 * Wire protocol types shared by the server (route handlers, views.ts) and a
 * future client. Pure types only — no runtime logic, no imports from
 * '@libsql/client' or any other server-only module — so this file is safe to
 * import from client code without pulling in server dependencies.
 *
 * Engine/DB canonical terms only (tile, pung, kong, chow, hu, tai, flower);
 * FRC display-name theming is applied on top of these at the UI layer via
 * src/lib/theme/frc.ts, never baked in here.
 */

import type { Seat } from '../engine/seats';
import type { TileKind } from '../engine/tiles';
import type { GameAction, HandResult, RuleError } from '../engine/game-state';
import type { RulesConfig } from '../engine/rules-config';

export type { RuleError };

export type PrevailingWind = 'east' | 'south' | 'west' | 'north';

export interface ClientTile {
  readonly id: string;
  readonly kind: TileKind;
}

export interface ClientMeld {
  readonly kind: 'chow' | 'pung' | 'kong';
  /** True only for a concealed kong; when true AND viewer !== owner, tiles below are masked. */
  readonly concealed: boolean;
  /** For an opponent's concealed kong, this is 4 placeholder entries (see views.ts spec). */
  readonly tiles: readonly ClientTile[];
}

export interface ClientPlayerView {
  readonly seat: Seat;
  readonly displayName: string;
  readonly isViewer: boolean;
  /** True iff a real player row exists for this seat (i.e. someone has joined it). */
  readonly occupied: boolean;
  /** Full tiles if isViewer, null (see concealedCount) otherwise. */
  readonly concealedTiles: readonly ClientTile[] | null;
  /** Always present; the count, for opponents' hidden hands. */
  readonly concealedCount: number;
  readonly melds: readonly ClientMeld[];
  readonly flowers: readonly ClientTile[];
  readonly discards: readonly ClientTile[];
  /** The viewer's OWN barred flag if isViewer, else null (never leak opponents' bar state). */
  readonly barredVisible: boolean | null;
  /**
   * Server-derived running match-points total for this seat: the sum of every
   * completed hand's payment legs in the current match so far (see
   * src/engine/scoring.ts's `sumPaymentLegs`). Fully public — payment legs
   * are already exposed unredacted via `ClientPhaseView.result` on every
   * hand-over, so this aggregate carries zero additional leak surface and is
   * identical across viewer/opponent/spectator views.
   */
  readonly matchPoints: number;
}

/**
 * A redacted mirror of the engine's Phase union - see views.ts's toClientView
 * for the exact per-phase-type redaction rules.
 */
export interface ClientPhaseView {
  readonly type: 'awaiting-draw' | 'awaiting-discard' | 'awaiting-claims' | 'awaiting-rob-kong' | 'hand-over';
  /** Only meaningful in awaiting-discard when isViewer's turn. */
  readonly drawnTileForViewer?: ClientTile | null;
  readonly discarderSeat?: Seat;
  readonly discardedTile?: ClientTile;
  /** awaiting-claims: who has responded (not what they claimed). */
  readonly respondedSeats?: readonly Seat[];
  readonly declarerSeat?: Seat;
  /** awaiting-rob-kong: visible per the redaction rules. */
  readonly kongTileVisible?: ClientTile | null;
  /** awaiting-rob-kong: true iff viewer is in eligibleRobbers. */
  readonly youMayRob?: boolean;
  /**
   * awaiting-rob-kong ONLY: true iff the viewer is in eligibleRobbers AND has
   * already submitted a rob/pass response. Undefined for the declarer,
   * bystanders, spectators, and every other phase type — never reveals
   * anything about whether OTHER seats have responded.
   */
  readonly youHaveResponded?: boolean;
  /**
   * awaiting-rob-kong: COUNT of eligible-and-unresponded seats (not the list —
   * revealing which seats are eligible-and-pending would leak rob-kong
   * eligibility, i.e. real hand-relationship information, to every viewer
   * including bystanders and spectators). A count is safe: it tells the UI
   * "N players are still deciding" without identifying who.
   */
  readonly stillWaitingCount?: number;
  /** hand-over: fully public. */
  readonly result?: HandResult;
}

// --- Ranked ladder ---------------------------------------------------------------

/**
 * The wire mirror of `src/server/ranked.ts`'s `RankedResultSeat`/
 * `RankedResultView`. Deliberately never carries an exact RP total for any
 * seat (only `rpDelta`, the per-match change) — see that module's doc
 * comment for the full redaction rationale. `tier` is a `TierBand` string
 * ('bronze' | 'silver' | 'expert' | 'platinum' | 'gold' | 'apex') kept as
 * `string` here so this file (imported by future client code) never needs to
 * import `src/lib/ranked/config.ts`'s server-adjacent types.
 */
export interface ClientRankedResultSeat {
  readonly seat: Seat;
  readonly placement: 1 | 2 | 3 | 4;
  readonly tier: string;
  readonly division: 1 | 2 | 3 | null;
  readonly rpDelta: number;
  readonly promotedToApex: boolean;
}

export type ClientRankedResultView =
  | { readonly status: 'unranked' }
  | { readonly status: 'pending' }
  | { readonly status: 'settled'; readonly seats: readonly ClientRankedResultSeat[] };

export interface CreateProfileRequest {
  readonly displayName: string;
}

export interface CreateProfileResponse {
  readonly profileId: string;
  readonly profileToken: string;
}

export interface ProfileMeResponse {
  readonly profileId: string;
  readonly displayName: string;
  readonly rankPoints: number;
  readonly tier: string;
  readonly division: 1 | 2 | 3 | null;
}

export interface ApexLeaderboardEntry {
  readonly profileId: string;
  readonly displayName: string;
  readonly rankPoints: number;
  readonly apexAttainedAt: number;
}

export interface ApexLeaderboardResponse {
  readonly foundingOrder: readonly ApexLeaderboardEntry[];
  readonly rpOrder: readonly ApexLeaderboardEntry[];
}

export interface ClientGameView {
  readonly seq: number;
  readonly roomCode: string;
  readonly status: 'waiting-for-players' | 'in-progress' | 'finished';
  readonly handNumber: number | null;
  readonly prevailingWind: PrevailingWind | null;
  readonly players: readonly ClientPlayerView[];
  readonly wallRemaining: number | null;
  readonly phase: ClientPhaseView | null;
  readonly viewerSeat: Seat | null;
  /** Null iff `phase` is null (status is waiting-for-players). */
  readonly currentTurnSeat: Seat | null;
  /** Null iff `phase` is null (status is waiting-for-players). */
  readonly dealerSeat: Seat | null;
  /** Null iff `phase` is null (status is waiting-for-players). */
  readonly repeatCount: number | null;
  /** Only meaningfully present when `status === 'finished'`. */
  readonly ranked?: ClientRankedResultView;
  /**
   * Server-authoritative turn-timer fields (see `src/server/turn-timer.ts`
   * and `RulesConfig.turnTimerSeconds`). Additive/optional so existing
   * callers that don't pass a `timing` argument to `toClientView` are
   * unaffected. `turnDeadline` is the epoch-ms instant the currently-open
   * decision window expires — null when there is no active window
   * (hand-over/no-hand), the timer is disabled (`turnTimerSeconds <= 0`), or
   * the game isn't `in-progress`. `serverNow` is the server's epoch-ms clock
   * at response time, so a client can compute a skew-corrected countdown
   * instead of trusting its own clock. `turnTimerSeconds` mirrors the game's
   * configured value (null only if genuinely unknown, e.g. no hand yet).
   */
  readonly turnDeadline?: number | null;
  readonly serverNow?: number;
  readonly turnTimerSeconds?: number | null;
}

export interface CreateGameRequest {
  readonly displayName: string;
  readonly rules?: Partial<RulesConfig>;
  readonly profileToken?: string;
}

export interface CreateGameResponse {
  readonly roomCode: string;
  readonly seat: 0;
  readonly playerToken: string;
  readonly rules: RulesConfig;
  readonly status: string;
}

export interface JoinGameRequest {
  readonly displayName: string;
  readonly profileToken?: string;
}

export interface JoinGameResponse {
  readonly roomCode: string;
  readonly seat: Seat;
  readonly playerToken: string;
  readonly rules: RulesConfig;
  readonly status: string;
}

export interface SubmitActionRequest {
  readonly action: GameAction;
}

export interface SubmitActionResponse {
  readonly seq: number;
  readonly view: ClientGameView;
}

// --- isValidGameAction --------------------------------------------------------

/**
 * A structural (not deep-semantic) runtime type guard for the wire-shape of
 * a `GameAction`, matching the exact discriminated union in
 * `src/engine/game-state.ts`. This exists because request bodies cross the
 * wire as untrusted JSON — `JSON.parse`'s result is `unknown`, not
 * `GameAction` — and the engine's own `applyAction` dispatch assumes a
 * structurally-valid action (its exhaustiveness-guard `throw` is reserved for
 * genuine engine-invariant violations, not attacker/bug-controlled input; see
 * game-state.ts's file doc comment). Route handlers MUST validate with this
 * (or an equivalent check) before ever calling `submitAction`/`applyAction`.
 *
 * Deliberately shallow beyond what's needed to avoid a downstream throw:
 * - `declare-concealed-kong`'s `kind` is only checked to be a non-null
 *   object, not deep-validated against every `TileKind` variant — a
 *   structurally-wrong-but-object-shaped `kind` is safely rejected downstream
 *   by the engine's own `canConcealedKong` check, which returns a proper
 *   `RuleError` (never throws) for that case.
 * - `claim`'s `tileIds` (chow only) is checked for length-2 + string
 *   elements, not that the strings are real tile ids — again safely
 *   RuleError'd downstream by `canChow`'s matching logic.
 *
 * Semantically-valid-but-rule-violating actions (e.g. discarding a tile not
 * in hand) are NOT this guard's job — those correctly surface as a
 * `RuleError` from `applyAction` itself, a distinct failure category from
 * "doesn't even match the wire shape".
 *
 * Also rejects any action carrying a `timedOut` key. `timedOut` is a
 * server-only audit tag (see `src/server/turn-timer.ts`'s
 * `LoggedGameAction`) applied exclusively by the server's own turn-timer
 * enforcement when it auto-acts on a player's behalf after their decision
 * window expires. It must never be forgeable by a client: a POSTed action
 * carrying `timedOut` is rejected outright here, before it ever reaches
 * `submitAction`, regardless of the action's `type`.
 */
const VALID_ACTION_TYPES: readonly GameAction['type'][] = [
  'draw',
  'discard',
  'declare-hu',
  'claim',
  'pass',
  'declare-added-kong',
  'declare-concealed-kong',
  'declare-rob',
];

const VALID_SEATS: readonly Seat[] = [0, 1, 2, 3];

const VALID_CLAIM_TYPES: readonly ('hu' | 'pung' | 'kong' | 'chow')[] = ['hu', 'pung', 'kong', 'chow'];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isValidSeat(value: unknown): value is Seat {
  return typeof value === 'number' && (VALID_SEATS as readonly number[]).includes(value);
}

function isValidClaimSpec(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  const claimType = value.type;
  if (typeof claimType !== 'string' || !(VALID_CLAIM_TYPES as readonly string[]).includes(claimType)) {
    return false;
  }
  if (claimType === 'chow') {
    const tileIds = value.tileIds;
    return Array.isArray(tileIds) && tileIds.length === 2 && tileIds.every((id) => typeof id === 'string');
  }
  return true;
}

export function isValidGameAction(value: unknown): value is GameAction {
  if (!isPlainObject(value)) return false;
  // A wire-forged 'timedOut' tag must never be accepted from a client — see
  // this function's doc comment. Checked before anything else so it rejects
  // regardless of `type`/shape.
  if ('timedOut' in value) return false;
  const { type, seat } = value;
  if (typeof type !== 'string' || !(VALID_ACTION_TYPES as readonly string[]).includes(type)) return false;
  if (!isValidSeat(seat)) return false;

  switch (type) {
    case 'draw':
    case 'declare-hu':
    case 'pass':
    case 'declare-rob':
      return true;
    case 'discard':
    case 'declare-added-kong':
      return typeof value.tileId === 'string';
    case 'declare-concealed-kong':
      return isPlainObject(value.kind);
    case 'claim':
      return isValidClaimSpec(value.claim);
    default:
      return false;
  }
}

// --- isValidRulesOverride ------------------------------------------------------

/**
 * A runtime type guard for a client-supplied `Partial<RulesConfig>` override
 * at game-creation time. This exists for the same reason as
 * `isValidGameAction`: a `Partial<RulesConfig>` crossing the wire as JSON has
 * no runtime type guarantees, and `createGame`'s `mergeRules` does a bare
 * spread merge with no validation. Unlike a malformed `GameAction` (which
 * fails fast on the very next call), a malformed rules override gets
 * PERSISTED as the game's immutable `rules_config` for its entire lifetime —
 * a field like `deadWallReserve: "banana"` wouldn't throw, it would silently
 * corrupt every downstream numeric comparison in the engine for that game.
 * Route handlers MUST validate with this before calling `createGame` when a
 * `rules` override is present.
 *
 * Rejects any key not in `RulesConfig`'s known shape, to prevent an
 * arbitrary-JSON injection into the stored rules blob.
 */
const NUMERIC_RULES_KEYS = [
  'deadWallReserve',
  'minTaiToWin',
  'basePoints',
  'pointsPerTai',
  'selfDrawTai',
  'robKongTai',
  'dealerBaseTai',
  'dealerRepeatBonusTaiPerRepeat',
  'turnTimerSeconds',
] as const;

const BOOLEAN_RULES_KEYS = ['multipleWinners', 'dealerRepeatsOnDraw'] as const;

const VALID_SACRED_DISCARD_SCOPES: readonly string[] = ['until-next-self-discard', 'entire-hand'];

const KNOWN_RULES_KEYS: readonly string[] = [
  ...NUMERIC_RULES_KEYS,
  ...BOOLEAN_RULES_KEYS,
  'robKong',
  'sacredDiscard',
  'points',
];

function isValidRobKongOverride(value: unknown): boolean {
  if (!isPlainObject(value) || Array.isArray(value)) return false;
  for (const key of Object.keys(value)) {
    if (key !== 'enabled' && key !== 'robConcealedKong') return false;
  }
  if ('enabled' in value && typeof value.enabled !== 'boolean') return false;
  if ('robConcealedKong' in value && typeof value.robConcealedKong !== 'boolean') return false;
  return true;
}

function isValidPointsOverride(value: unknown): boolean {
  if (!isPlainObject(value) || Array.isArray(value)) return false;
  for (const key of Object.keys(value)) {
    if (key !== 'startingPoints' && key !== 'basePoints' && key !== 'perTai') return false;
  }
  if ('startingPoints' in value && !(typeof value.startingPoints === 'number' && Number.isFinite(value.startingPoints))) {
    return false;
  }
  if ('basePoints' in value && !(typeof value.basePoints === 'number' && Number.isFinite(value.basePoints))) {
    return false;
  }
  if ('perTai' in value && !(typeof value.perTai === 'number' && Number.isFinite(value.perTai))) {
    return false;
  }
  return true;
}

function isValidSacredDiscardOverride(value: unknown): boolean {
  if (!isPlainObject(value) || Array.isArray(value)) return false;
  for (const key of Object.keys(value)) {
    if (key !== 'enabled' && key !== 'scope') return false;
  }
  if ('enabled' in value && typeof value.enabled !== 'boolean') return false;
  if ('scope' in value && !VALID_SACRED_DISCARD_SCOPES.includes(value.scope as string)) return false;
  return true;
}

export function isValidRulesOverride(value: unknown): value is Partial<RulesConfig> {
  if (value === undefined) return true;
  if (!isPlainObject(value) || Array.isArray(value)) return false;

  for (const key of Object.keys(value)) {
    if (!KNOWN_RULES_KEYS.includes(key)) return false;
  }

  for (const key of NUMERIC_RULES_KEYS) {
    if (key in value && !(typeof value[key] === 'number' && Number.isFinite(value[key]))) return false;
  }
  for (const key of BOOLEAN_RULES_KEYS) {
    if (key in value && typeof value[key] !== 'boolean') return false;
  }
  if ('robKong' in value && !isValidRobKongOverride(value.robKong)) return false;
  if ('sacredDiscard' in value && !isValidSacredDiscardOverride(value.sacredDiscard)) return false;
  if ('points' in value && !isValidPointsOverride(value.points)) return false;

  return true;
}

// --- isValidProfileToken -------------------------------------------------------

/**
 * A minimal structural guard for a client-supplied `profileToken` on
 * `CreateGameRequest`/`JoinGameRequest`: `undefined` (no profile linkage
 * requested) is valid; anything present must be a non-empty string. Route
 * handlers MUST validate with this before ever calling
 * `resolveProfileToken` — same "validate untrusted wire input at the exact
 * boundary" discipline as `isValidGameAction`/`isValidRulesOverride`.
 */
export function isValidProfileToken(value: unknown): value is string | undefined {
  if (value === undefined) return true;
  return typeof value === 'string' && value.trim().length > 0;
}

/** Same minimal structural guard, for `CreateProfileRequest.displayName`. */
export function isValidDisplayName(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
