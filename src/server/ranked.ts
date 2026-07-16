/**
 * Ranked-ladder identity + settlement: profile creation/lookup, the public
 * per-game ranked-result view, the Apex leaderboards, and `settleRankedMatch`
 * — the core read-decide-write path that turns a finished match's
 * `SeatTotals` into `rank_history` rows and updated `profiles.rank_points`.
 * Peer module to `games.ts`/`replay.ts`.
 *
 * `settleRankedMatch` follows the same overall concurrency discipline
 * documented in `docs/DECISIONS.md`'s Phase 3 round-1 entry (re-read/
 * re-validate fresh, never blindly retry a stale decision) but via a
 * per-seat, `db.transaction()`-free mechanism — see that function's own doc
 * comment for the full design and why the plan's original literal
 * interactive-transaction mechanism was replaced.
 *
 * ROUND 2 (see `migrations/0004_rank_settlement_resilience.sql` and this
 * module's `settleRankedMatch` doc comment): an independent adversarial pass
 * found 3 further concurrency/robustness bugs in the round-1 per-seat design
 * — a stale-precomputed Apex-promotion flag that could permanently miss a
 * threshold crossing reached only by the COMBINED effect of two concurrent
 * different-game settlements; a "does a `rank_history` row exist" check that
 * treated a crash between the row's insert and the matching `profiles`
 * update as "already fully applied", permanently losing that seat's RP; and
 * no per-seat error isolation, letting one permanently-broken seat (e.g. a
 * deleted linked profile) block the other 3 forever and 500 every future
 * `/state` poll and `/actions` call for that game. All 3 are fixed here; see
 * `settleRankedMatch`'s doc comment for how.
 */

import { LibsqlError, type Client, type Row } from '@libsql/client';
import { randomBytes } from 'node:crypto';
import { listPlayers } from './games';
import { getMatchSnapshot } from './replay';
import { computeStandings } from '../engine/scoring';
import { rankForRp, settleRp } from '../lib/ranked/ladder';
import { APEX_THRESHOLD_RP, type Division, type TierBand } from '../lib/ranked/config';
import { SEATS, type Seat } from '../engine/seats';

/**
 * True for a UNIQUE-constraint violation. Checked via LibsqlError's
 * machine-readable `code` first, falling back to a message match — same
 * convention as `games.ts`/`actions-log.ts`.
 */
function isUniqueConstraintError(err: unknown): boolean {
  if (err instanceof LibsqlError) {
    return err.code.startsWith('SQLITE_CONSTRAINT');
  }
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
}

// --- createProfile / resolveProfileToken / getOwnProfile -----------------------

export interface CreateProfileResult {
  readonly profileId: string;
  readonly secretToken: string;
}

/**
 * Creates a new ranked profile at 0 RP with a fresh, unique secret token —
 * the long-lived cross-match identity a client stores (localStorage) and
 * presents as a bearer token, mirroring the existing per-game join-token
 * pattern (32 random bytes) rather than any accounts/OAuth scheme.
 */
export async function createProfile(db: Client, displayName: string): Promise<CreateProfileResult> {
  const profileId = randomBytes(16).toString('hex');
  const secretToken = randomBytes(32).toString('base64url');
  const now = Date.now();
  await db.execute({
    sql: `INSERT INTO profiles (id, secret_token, display_name, rank_points, apex_attained_at, created_at, updated_at)
          VALUES (?, ?, ?, 0, NULL, ?, ?)`,
    args: [profileId, secretToken, displayName, now, now],
  });
  return { profileId, secretToken };
}

/**
 * Resolves a profile's secret token to its identity. Returns `null` for an
 * unknown token — a normal "not linked" case, never thrown as an error.
 */
export async function resolveProfileToken(
  db: Client,
  secretToken: string,
): Promise<{ profileId: string; displayName: string } | null> {
  const result = await db.execute({
    sql: 'SELECT id, display_name FROM profiles WHERE secret_token = ?',
    args: [secretToken],
  });
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return { profileId: String(row.id), displayName: String(row.display_name) };
}

export interface OwnProfileView {
  readonly profileId: string;
  readonly displayName: string;
  readonly rankPoints: number;
  readonly tier: TierBand;
  readonly division: Division | null;
  readonly apexAttainedAt: number | null;
}

/**
 * The caller's own full profile, including the exact `rankPoints` total —
 * this is the ONE place an exact RP total is ever exposed (private to the
 * profile owner, via their secret token). Tier/division are always derived
 * from `rankPoints`/Apex status via `rankForRp`, never stored — matching
 * this codebase's "GameState is never stored, always replayed/derived"
 * convention, extended to ranked identity.
 */
export async function getOwnProfile(db: Client, secretToken: string): Promise<OwnProfileView | null> {
  const result = await db.execute({
    sql: 'SELECT id, display_name, rank_points, apex_attained_at FROM profiles WHERE secret_token = ?',
    args: [secretToken],
  });
  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  const rankPoints = Number(row.rank_points);
  const apexAttainedAt = row.apex_attained_at === null ? null : Number(row.apex_attained_at);
  const rank = rankForRp(rankPoints, apexAttainedAt !== null);

  return {
    profileId: String(row.id),
    displayName: String(row.display_name),
    rankPoints,
    tier: rank.tier,
    division: 'division' in rank ? rank.division : null,
    apexAttainedAt,
  };
}

// --- getApexLeaderboards --------------------------------------------------------

export interface ApexLeaderboardEntry {
  readonly profileId: string;
  readonly displayName: string;
  readonly rankPoints: number;
  readonly apexAttainedAt: number;
}

function rowToLeaderboardEntry(row: Row): ApexLeaderboardEntry {
  return {
    profileId: String(row.id),
    displayName: String(row.display_name),
    rankPoints: Number(row.rank_points),
    apexAttainedAt: Number(row.apex_attained_at),
  };
}

/**
 * Two orderings over every profile that has ever reached Apex Grandmaster.
 * Exact RP is intentionally public here (a deliberate exception to the
 * private-by-default RP rule elsewhere in this module) — Apex is a public
 * hall-of-fame, not a private stat.
 */
export async function getApexLeaderboards(
  db: Client,
): Promise<{ foundingOrder: readonly ApexLeaderboardEntry[]; rpOrder: readonly ApexLeaderboardEntry[] }> {
  const foundingRows = await db.execute(
    `SELECT id, display_name, rank_points, apex_attained_at FROM profiles
     WHERE apex_attained_at IS NOT NULL ORDER BY apex_attained_at ASC, id ASC`,
  );
  const rpRows = await db.execute(
    `SELECT id, display_name, rank_points, apex_attained_at FROM profiles
     WHERE apex_attained_at IS NOT NULL ORDER BY rank_points DESC, apex_attained_at ASC, id ASC`,
  );
  return {
    foundingOrder: foundingRows.rows.map(rowToLeaderboardEntry),
    rpOrder: rpRows.rows.map(rowToLeaderboardEntry),
  };
}

// --- RankedResultView ------------------------------------------------------------

export interface RankedResultSeat {
  readonly seat: Seat;
  readonly placement: 1 | 2 | 3 | 4;
  readonly tier: TierBand;
  readonly division: Division | null;
  readonly rpDelta: number;
  readonly promotedToApex: boolean;
}

/**
 * The public, per-game ranked-result view. Deliberately NEVER carries
 * `rpBefore`/`rpAfter`/any running RP total for any seat — exact RP is
 * private to the profile owner (see `getOwnProfile`); only the per-match
 * delta/tier/placement cross into a game view. `'unranked'` means this game
 * will never settle (at least one seat is unlinked to a profile); `'pending'`
 * means it will (all 4 seats linked) but hasn't settled yet, whether because
 * the match hasn't finished or because settlement simply hasn't run yet;
 * `'settled'` carries the real per-seat results.
 */
export type RankedResultView =
  | { readonly status: 'unranked' }
  | { readonly status: 'pending' }
  | { readonly status: 'settled'; readonly seats: readonly RankedResultSeat[] };

/**
 * Re-derives `{ tier, division, promotedToApex }` for one settled seat from
 * ONLY what `rank_history` actually stores (`rp_before`, `rp_after`,
 * `tier_after`) — division and promotedToApex are intentionally not stored
 * columns, matching the "derive, don't store" convention:
 *  - `division` is `rankForRp(rpAfter, tierAfter === 'apex')`'s division, if
 *    any (Apex has none).
 *  - `promotedToApex` is true iff this settlement crossed the Apex threshold
 *    for the first time: `tierAfter === 'apex' && rpBefore < APEX_THRESHOLD_RP`.
 *    This is a valid reconstruction of `settleRp`'s own `promotedToApex`
 *    because Apex is sticky and RP-floored at `APEX_THRESHOLD_RP` once
 *    attained (see `settleRp`'s doc comment) — so `rpBefore >=
 *    APEX_THRESHOLD_RP` is true if and only if Apex was already attained
 *    before this match.
 */
function deriveSettledSeatRankFields(
  rpBefore: number,
  rpAfter: number,
  tierAfter: TierBand,
): { readonly tier: TierBand; readonly division: Division | null; readonly promotedToApex: boolean } {
  const apexAttained = tierAfter === 'apex';
  const rank = rankForRp(rpAfter, apexAttained);
  const division = 'division' in rank ? rank.division : null;
  const promotedToApex = apexAttained && rpBefore < APEX_THRESHOLD_RP;
  return { tier: rank.tier, division, promotedToApex };
}

async function getLinkedProfileSeats(db: Client, gameId: string): Promise<ReadonlyMap<Seat, string | null>> {
  const players = await listPlayers(db, gameId);
  const map = new Map<Seat, string | null>();
  for (const p of players) {
    map.set(p.seat, p.profileId);
  }
  return map;
}

/** True iff all 4 seats exist and are each linked to a (non-null) profile. */
function allFourSeatsLinked(seatProfiles: ReadonlyMap<Seat, string | null>): boolean {
  if (seatProfiles.size !== 4) return false;
  for (const seat of SEATS) {
    if (seatProfiles.get(seat) == null) return false;
  }
  return true;
}

/**
 * The public ranked-result view for a game, from whatever has already been
 * persisted — never triggers settlement itself (see `settleRankedMatch` for
 * that). Cheap: at most 2 indexed reads (`rank_history`, then `players` only
 * if fewer than 4 history rows exist).
 *
 * Only treats the game as `'settled'` once all 4 seats' rows exist AND are
 * fully applied (`rp_applied = 1`) — `settleRankedMatch` settles one seat at
 * a time (see its own doc comment), so a partial 1-3-row state, OR a full
 * 4-row state where one row's `profiles` update hasn't actually landed yet
 * (e.g. a crash between that row's `rank_history` INSERT and its `rp_applied`
 * CAS/`profiles` UPDATE), is a real, valid transient case (an in-progress or
 * previously-interrupted settlement), not "done". A row existing is NOT
 * proof its RP was actually applied — only `rp_applied = 1` is. Falling
 * through to the linkage check for either case correctly reports `'pending'`
 * (the normal signal to retry via `settleRankedMatch`), never a broken
 * partial view or a false "settled" that silently hides a lost RP delta.
 */
export async function getRankedResultForGame(db: Client, gameId: string): Promise<RankedResultView> {
  const historyRows = await db.execute({
    sql: `SELECT seat, placement, rp_before, rp_delta, rp_after, tier_after, rp_applied
          FROM rank_history WHERE game_id = ? ORDER BY seat ASC`,
    args: [gameId],
  });

  const fullyApplied = historyRows.rows.length === 4 && historyRows.rows.every((row) => Number(row.rp_applied) === 1);

  if (fullyApplied) {
    const seats: RankedResultSeat[] = historyRows.rows.map((row) => {
      const rpBefore = Number(row.rp_before);
      const rpAfter = Number(row.rp_after);
      const tierAfter = String(row.tier_after) as TierBand;
      const derived = deriveSettledSeatRankFields(rpBefore, rpAfter, tierAfter);
      return {
        seat: Number(row.seat) as Seat,
        placement: Number(row.placement) as 1 | 2 | 3 | 4,
        tier: derived.tier,
        division: derived.division,
        rpDelta: Number(row.rp_delta),
        promotedToApex: derived.promotedToApex,
      };
    });
    return { status: 'settled', seats };
  }

  const seatProfiles = await getLinkedProfileSeats(db, gameId);
  if (!allFourSeatsLinked(seatProfiles)) {
    return { status: 'unranked' };
  }
  return { status: 'pending' };
}

// --- settleRankedMatch -------------------------------------------------------------

/**
 * Settles a finished match's ranked result: exactly once per (game, profile)
 * pair, race-safe against both (a) multiple concurrent callers settling the
 * SAME game, and (b) a DIFFERENT game concurrently settling a profile shared
 * across both games — crash-resumable (a caller that fails partway through,
 * e.g. a killed serverless invocation, leaves a state a LATER call can
 * safely finish, never double-applying what already landed) — and
 * per-seat error-isolated (one permanently-broken seat, e.g. its linked
 * profile row deleted, can never permanently block the other 3, and never
 * causes an unbounded repeated failure — see "per-seat error isolation"
 * below). Safe to call on every observer's `/state` poll — the cheap path
 * (already-settled check) is a single indexed `rank_history` read.
 *
 * DEVIATION FROM THE ORIGINAL PLAN'S LITERAL MECHANISM, same end contract:
 * the plan describes one interactive `db.transaction('write')` writing all 8
 * rows (4 inserts + 4 conditionally-guarded updates) atomically, rolling
 * back the whole attempt on a 0-rows-affected UPDATE. Empirically, THIS
 * codebase's `:memory:` test convention and `@libsql/client`'s local
 * (`sqlite3`) driver make `db.transaction()` unsafe to rely on here:
 *  (a) `:memory:` (the URL every existing test file in this repo uses)
 *      backs each `.transaction()` call with a genuinely SEPARATE, isolated
 *      in-memory database from the client's own `.execute()`/`.batch()`
 *      connection — writes made inside the transaction, and even the
 *      original schema, become invisible to the rest of the client
 *      afterward. Confirmed directly against the real driver, not assumed.
 *  (b) Even against a real file-backed database, concurrent interactive
 *      `db.transaction('write')` calls from the SAME process reliably throw
 *      `SQLITE_BUSY` (immediately, `timeout` notwithstanding) rather than
 *      queueing — exactly the scenario this function's own concurrency
 *      tests need to exercise.
 * Neither failure mode is hypothetical — both were reproduced directly
 * against the real `@libsql/client` driver before choosing this design. This
 * also matches a real signal already in this codebase: zero pre-existing
 * uses of `.transaction(` anywhere (`.batch()`/`.execute()` only), and
 * `migrations/0003_ranked.sql`'s own doc comment on `rank_history`'s UNIQUE
 * constraint already anticipates using it as "a later round's concurrency-
 * safe settlement path['s]" arbiter, not a transaction. Round 2 (below) also
 * empirically re-considered whether combining the per-seat INSERT+UPDATE
 * into a single `db.batch(..., 'write')` round trip was worth adopting: it
 * IS a genuinely atomic single transaction (confirmed the same way — this
 * codebase already relies on that in `createGame`/`runMigrations`), but it
 * does NOT by itself fix any of the round-2 bugs below (the stale-read race
 * happens BEFORE the batch, between the profile SELECT and the batch, no
 * matter how atomic the batch itself is), and would not have removed the
 * need for the `rp_applied` completion marker (round-2 bug 2 requires
 * self-healing a partial state that can also be constructed by any *history*
 * of this code, not just this version's own write path) — so it was not
 * adopted; every write below stays a single, separately-reasoned-about
 * `.execute()`, as round 1 already established.
 *
 * The replacement, per seat, independently:
 *  1. Read the profile's CURRENT `rank_points`/`apex_attained_at` fresh.
 *  2. Compute `settleRp` from that fresh read + this seat's (immutable, once
 *     the match is finished) placement.
 *  3. Attempt `INSERT INTO rank_history (..., rp_applied)` with these exact
 *     computed values and `rp_applied = 0`. This single INSERT is the atomic
 *     arbiter for "did this settlement happen at all": `UNIQUE(game_id,
 *     profile_id)` guarantees AT MOST ONE caller, ever, across all time and
 *     all concurrent racers (same-game OR a resumed-after-crash retry),
 *     successfully claims this exact settlement row for this exact seat.
 *     - On success: this row is now OURS to complete — use OUR freshly
 *       computed `rp_delta`.
 *     - On a UNIQUE violation: another caller (a same-game racer, or a prior
 *       attempt of our own — possibly an INCOMPLETE one, see step 4) already
 *       claimed this row — read it back and use ITS stored `rp_delta` (never
 *       our own possibly-now-stale recomputation: the audit trail's
 *       `rp_delta` and what actually gets applied to `profiles` must always
 *       be the exact same number).
 *  4. ROUND-2 FIX (bug 2 — crash resumability): a `rank_history` row's mere
 *     EXISTENCE is no longer treated as proof its `profiles` update landed.
 *     `rp_applied` is a second atomic arbiter, this time for "did the
 *     `profiles` update for THIS row happen yet": `UPDATE rank_history SET
 *     rp_applied = 1 WHERE id = ? AND rp_applied = 0`. At most one caller,
 *     ever, can see `rowsAffected === 1` for a given row — that caller (and
 *     only that caller) then applies the row's `rp_delta` to `profiles`.
 *     This closes the exact gap the round-1 design left open: a process that
 *     dies between step 3 and this point leaves `rp_applied = 0` durably on
 *     disk, so ANY later call — including one that hits the row via a UNIQUE
 *     violation rather than having inserted it itself — completes the
 *     stalled work instead of silently skipping it (this heals a partial
 *     state left by ANY history of this code, not only ones this exact
 *     version's own write path can produce, which is the correct bar for a
 *     durable audit table).
 *  5. Apply the claimed row's `rp_delta` to `profiles` UNCONDITIONALLY, as a
 *     pure additive delta (`rank_points = rank_points + ?`) — commutative,
 *     so safe under any concurrent interleaving from other games touching
 *     the same profile row; step 4 already resolved the only real race
 *     (whether THIS row's delta gets applied at all). ROUND-2 FIX (bug 1 —
 *     missed Apex promotion): `apex_attained_at` is no longer set from a
 *     precomputed `promotedToApex` flag computed from a stale pre-race read.
 *     It is decided in the SAME atomic `UPDATE` statement, from a `CASE`
 *     expression referencing the row's CURRENT (pre-this-update, per SQL's
 *     own old-row SET-expression evaluation semantics) `rank_points` — i.e.
 *     "is `apex_attained_at` still NULL, and does `rank_points + this
 *     row's delta` reach the threshold?" — evaluated at the instant of the
 *     real, authoritative update, never from a value computed before the
 *     race window. This correctly catches an Apex crossing reached only by
 *     the COMBINED effect of two concurrent different-game settlements, each
 *     of whose own individual stale reads would have undershot the
 *     threshold alone. `RETURNING rank_points, apex_attained_at` gives back
 *     the row's TRUE post-update values in the same atomic statement.
 *  6. Using those TRUE post-update values (never a locally-recomputed flag),
 *     correct `rank_history`'s `rp_before`/`rp_after`/`tier_after` for this
 *     row so the permanent audit trail always reflects what ACTUALLY
 *     happened (a true, gapless before→after chain across every game that
 *     ever touches this profile, and a `tier_after` that's always correct
 *     even when Apex was only reached via a concurrent different game's
 *     combined effect) — this seat's own `rp_delta`/placement (this match's
 *     real, intended reward) is never altered, only the baseline/tier it's
 *     shown composing from and landing in.
 *
 * PER-SEAT ERROR ISOLATION (round-2 fix, bug 3): each seat's steps 1-6 above
 * run in its own try/catch. A seat that has never failed before is a "fresh"
 * seat: on its first-ever failure this call, the loop stops immediately
 * (same as round 1) WITHOUT attempting any other not-yet-tried seat this
 * call, and the failure is durably recorded in `rank_settlement_failures`.
 * A seat that failed on a PRIOR call is a "deferred" seat: it is retried
 * LAST, after every fresh (not-previously-broken) seat has already been
 * attempted — so the healthy 3 seats always get a chance to settle even
 * while a 4th seat is permanently broken, instead of being blocked behind it
 * forever. (A fresh failure still stops the fresh pass immediately, matching
 * the very first call's behavior exactly — only SUBSEQUENT calls, once a
 * seat's brokenness is known, reorder around it.) Either way, if any seat
 * ultimately failed this call, the error is still re-thrown at the end —
 * this function does not swallow a broken game's brokenness — but the seats
 * that succeeded are durably settled regardless, and a fixed seat (e.g. its
 * profile row restored) clears its failure record and resumes normal
 * priority. Route handlers (state/actions/next-hand) wrap their own calls to
 * this function so that a thrown error here never 500s the surrounding
 * response — see those routes' own comments.
 */
export async function settleRankedMatch(db: Client, gameId: string): Promise<RankedResultView> {
  // Cheap already-settled path — no snapshot replay, no per-seat work.
  // Requires rp_applied = 1 on all 4 rows, not merely 4 rows existing: a row
  // can exist with its RP delta never actually applied to `profiles` (e.g. a
  // crash between that seat's rank_history INSERT and its rp_applied
  // CAS/profiles UPDATE in settleOneSeat below), and treating that as "done"
  // would permanently skip re-attempting it — every future caller (including
  // every observer's /state poll) would keep taking this cheap path forever,
  // silently and permanently losing that seat's RP while still reporting
  // 'settled' with a correct-looking rpDelta.
  const existing = await db.execute({
    sql: 'SELECT COUNT(*) AS n FROM rank_history WHERE game_id = ? AND rp_applied = 1',
    args: [gameId],
  });
  if (Number(existing.rows[0].n) === 4) {
    return getRankedResultForGame(db, gameId);
  }

  // Cheap linkage + status check — still no snapshot replay.
  const gameRow = await db.execute({
    sql: 'SELECT status FROM games WHERE id = ?',
    args: [gameId],
  });
  if (gameRow.rows.length === 0) {
    throw new Error(`settleRankedMatch: no game found with id ${gameId}`);
  }
  const status = String(gameRow.rows[0].status);

  const seatProfiles = await getLinkedProfileSeats(db, gameId);
  if (!allFourSeatsLinked(seatProfiles)) {
    return { status: 'unranked' };
  }
  if (status !== 'finished') {
    return { status: 'pending' };
  }

  // Finished + fully linked + not (yet, or fully) settled: replay the match
  // once — placements are deterministic/immutable for a finished match, so
  // this never needs to be re-derived per seat or on any retry.
  const snapshot = await getMatchSnapshot(db, gameId);
  if (snapshot === null) {
    throw new Error(`settleRankedMatch: game ${gameId} is finished but has no action log`);
  }
  const standings = computeStandings(snapshot.matchPoints);

  /**
   * Settles exactly one seat (steps 1-6 of this function's doc comment).
   * Idempotent/self-healing: safe to call again for a seat that's already
   * fully settled (returns immediately) or partially settled by a prior,
   * interrupted attempt (completes it using the row's own stored delta).
   */
  async function settleOneSeat(seat: Seat): Promise<void> {
    const profileId = seatProfiles.get(seat);
    if (profileId == null) {
      // Unreachable: allFourSeatsLinked already guarantees every seat has a
      // non-null profileId.
      throw new Error(`settleRankedMatch: internal error — seat ${seat} unexpectedly unlinked for game ${gameId}`);
    }
    const standing = standings.find((s) => s.seat === seat);
    if (standing === undefined) {
      // Unreachable: computeStandings always ranks all 4 seats.
      throw new Error(`settleRankedMatch: internal error — no standing for seat ${seat}`);
    }

    const profileRow = await db.execute({
      sql: 'SELECT rank_points, apex_attained_at FROM profiles WHERE id = ?',
      args: [profileId],
    });
    if (profileRow.rows.length === 0) {
      throw new Error(`settleRankedMatch: no profile found with id ${profileId} (linked from game ${gameId})`);
    }
    const rpBefore = Number(profileRow.rows[0].rank_points);
    const apexAttainedBefore = profileRow.rows[0].apex_attained_at !== null;

    const result = settleRp({ rpBefore, apexAttainedBefore, place: standing.place });
    const now = Date.now();

    let rowId: string;
    let rpDeltaToApply: number;

    const newRowId = randomBytes(16).toString('hex');
    try {
      await db.execute({
        sql: `INSERT INTO rank_history
                (id, game_id, profile_id, seat, placement, rp_before, rp_delta, rp_after, tier_after, rp_applied, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
        args: [
          newRowId,
          gameId,
          profileId,
          seat,
          standing.place,
          rpBefore,
          result.rpDelta,
          result.rpAfter,
          result.tierAfter,
          now,
        ],
      });
      rowId = newRowId;
      rpDeltaToApply = result.rpDelta;
    } catch (err) {
      if (!isUniqueConstraintError(err)) throw err;
      // Someone else (a same-game racer, or a prior attempt of our own —
      // possibly one that never finished applying its update, see below)
      // already claimed this row. Adopt ITS stored rp_delta — never
      // recompute from our own (possibly now-stale) fresh read here, so the
      // amount we might apply to `profiles` always matches what the audit
      // trail records.
      const existingRow = await db.execute({
        sql: `SELECT id, rp_delta, rp_applied FROM rank_history WHERE game_id = ? AND profile_id = ?`,
        args: [gameId, profileId],
      });
      if (existingRow.rows.length === 0) {
        // Unreachable: the UNIQUE violation above implies this row exists.
        throw new Error(`settleRankedMatch: internal error — unique violation but no row for game ${gameId} profile ${profileId}`);
      }
      if (Number(existingRow.rows[0].rp_applied) === 1) {
        // Fully done already (both the audit row and its profiles update
        // landed) — nothing further for this seat.
        return;
      }
      rowId = String(existingRow.rows[0].id);
      rpDeltaToApply = Number(existingRow.rows[0].rp_delta);
    }

    // Claim the "apply this row's delta to profiles" work via a CAS on
    // rp_applied (0 -> 1). At most one caller, ever, sees rowsAffected===1
    // for a given row — see this function's doc comment, round-2 fix #2.
    const claim = await db.execute({
      sql: `UPDATE rank_history SET rp_applied = 1 WHERE id = ? AND rp_applied = 0`,
      args: [rowId],
    });
    if (claim.rowsAffected === 0) {
      // Someone else already claimed (and is completing, or has completed)
      // this row's profiles update. Nothing further to do for this seat.
      return;
    }

    // We now hold exclusive, permanent ownership of applying this row's
    // rp_delta to profiles.rank_points. apex_attained_at is decided in the
    // SAME atomic statement from the row's CURRENT (pre-update) rank_points
    // — see this function's doc comment, round-2 fix #1 — never from any
    // value computed before this race window.
    const updateResult = await db.execute({
      sql: `UPDATE profiles
              SET rank_points = rank_points + ?,
                  apex_attained_at = CASE
                    WHEN apex_attained_at IS NULL AND (rank_points + ?) >= ? THEN ?
                    ELSE apex_attained_at
                  END,
                  updated_at = ?
            WHERE id = ?
            RETURNING rank_points, apex_attained_at`,
      args: [rpDeltaToApply, rpDeltaToApply, APEX_THRESHOLD_RP, now, now, profileId],
    });
    const actualRpAfter = Number(updateResult.rows[0].rank_points);
    const actuallyApex = updateResult.rows[0].apex_attained_at !== null;
    const actualRpBefore = actualRpAfter - rpDeltaToApply;
    const correctedTier = rankForRp(actualRpAfter, actuallyApex).tier;

    // We already exclusively hold this row (the CAS above) — no further
    // guard needed. Record the TRUE before/after/tier this row's rp_delta
    // actually composed from and landed in.
    await db.execute({
      sql: `UPDATE rank_history SET rp_before = ?, rp_after = ?, tier_after = ? WHERE id = ?`,
      args: [actualRpBefore, actualRpAfter, correctedTier, rowId],
    });
  }

  const knownBadSeatsRows = await db.execute({
    sql: 'SELECT seat FROM rank_settlement_failures WHERE game_id = ?',
    args: [gameId],
  });
  const knownBadSeats = new Set<Seat>(knownBadSeatsRows.rows.map((r) => Number(r.seat) as Seat));

  const freshSeats = SEATS.filter((s) => !knownBadSeats.has(s));
  const deferredSeats = SEATS.filter((s) => knownBadSeats.has(s));

  // Fresh (never-before-broken) seats: same behavior as round 1 — stop
  // immediately at the first failure, without attempting any other
  // not-yet-tried seat this call. This is what keeps a game's very first
  // settlement attempt (before anything is known to be broken) behaving
  // exactly as before.
  for (const seat of freshSeats) {
    try {
      await settleOneSeat(seat);
    } catch (err) {
      await recordSeatFailure(db, gameId, seat, err);
      throw err;
    }
  }

  // Deferred (previously-broken) seats: attempted LAST, after every healthy
  // seat has already settled — each independently, so multiple
  // simultaneously-broken seats don't block each other either. A seat that
  // recovers (e.g. its profile row was restored) clears its failure record
  // and rejoins the fresh pool on the next call.
  const deferredErrors: unknown[] = [];
  for (const seat of deferredSeats) {
    try {
      await settleOneSeat(seat);
      await clearSeatFailure(db, gameId, seat);
    } catch (err) {
      await recordSeatFailure(db, gameId, seat, err);
      deferredErrors.push(err);
    }
  }
  if (deferredErrors.length > 0) {
    throw deferredErrors[0];
  }

  return getRankedResultForGame(db, gameId);
}

/**
 * Records (or updates) that `seat` failed to settle for `gameId` — see
 * `settleRankedMatch`'s doc comment, per-seat error isolation. Best-effort:
 * a failure to write this bookkeeping row must never mask or replace the
 * real error the caller is about to (re-)throw.
 */
async function recordSeatFailure(db: Client, gameId: string, seat: Seat, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  const now = Date.now();
  try {
    await db.execute({
      sql: `INSERT INTO rank_settlement_failures (game_id, seat, last_error, attempt_count, first_failed_at, last_failed_at)
            VALUES (?, ?, ?, 1, ?, ?)
            ON CONFLICT (game_id, seat) DO UPDATE SET
              last_error = excluded.last_error,
              attempt_count = attempt_count + 1,
              last_failed_at = excluded.last_failed_at`,
      args: [gameId, seat, message, now, now],
    });
  } catch {
    // Best-effort bookkeeping only — see doc comment above.
  }
}

/** Clears a seat's recorded failure once it settles successfully. */
async function clearSeatFailure(db: Client, gameId: string, seat: Seat): Promise<void> {
  await db.execute({
    sql: 'DELETE FROM rank_settlement_failures WHERE game_id = ? AND seat = ?',
    args: [gameId, seat],
  });
}
