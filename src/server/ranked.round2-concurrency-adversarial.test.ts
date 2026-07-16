/**
 * Independent tester adversarial pass — ranked-ladder round 2's
 * `settleRankedMatch` (src/server/ranked.ts). Does NOT reuse or trust
 * ranked.test.ts's own concurrency assertions — reads the actual per-seat
 * implementation line by line and constructs scenarios its own tests don't
 * cover, per the task brief:
 *
 *   1. Does the follow-up correction pass actually close every race window?
 *   2. Multi-way (3+) concurrent settlements sharing one profile: does the
 *      rank_history audit trail chain correctly?
 *   3. Crash/partial-failure mid-sequence: a rank_history row exists but the
 *      matching profiles UPDATE never ran — is a later call crash-resumable?
 *   4. One seat's processing throws mid-loop: does the game get permanently,
 *      undetectably stuck partially-settled?
 *   5. Commutative-addition-is-safe, re-verified directly with N=5 racers.
 *   6. Idempotency's ACTUAL code path (not just the outcome).
 *   9. games.ts's profile-link-collision retry: does it swallow unrelated
 *      errors, or only genuine profile_id collisions?
 *
 * Uses a deterministic single-threaded interleaving technique (a Proxy
 * around the real @libsql/client Client that runs a second, fully-nested
 * settlement between one specific SELECT and its caller seeing the result)
 * rather than best-effort `Promise.all` races, so the exact interleaving
 * under test is reproducible every run — genuine `Promise.all` races over a
 * single-threaded SQLite connection are ALSO a real, valid concurrency mode
 * (already covered by ranked.test.ts), but can't reliably hit one specific
 * narrow window on demand the way this technique can.
 */
import { LibsqlError, createClient, type Client, type InStatement } from '@libsql/client';
import { describe, expect, it, vi } from 'vitest';
import { runMigrations } from './migrations';
import { appendStartHand } from './actions-log';
import { advanceToNextHand, submitAction } from './replay';
import { createGame, joinGame, listPlayers } from './games';
import {
  createProfile,
  getApexLeaderboards,
  getRankedResultForGame,
  settleRankedMatch,
} from './ranked';
import { DEFAULT_RULES, type RulesConfig } from '../engine/rules-config';
import { settleRp } from '../lib/ranked/ladder';
import { APEX_THRESHOLD_RP } from '../lib/ranked/config';
import type { GameState, RuleError } from '../engine/game-state';
import type { Seat } from '../engine/seats';

function isSubmitRuleError(
  r: { readonly state: GameState; readonly handNumber: number } | RuleError,
): r is RuleError {
  return 'type' in r && r.type === 'rule-error';
}

async function freshDb(): Promise<Client> {
  const db = createClient({ url: ':memory:' });
  await runMigrations(db);
  return db;
}

let roomCodeCounter = 0;
function nextRoomCode(): string {
  roomCodeCounter += 1;
  return `R${roomCodeCounter}`.toUpperCase().padStart(6, 'Z');
}

async function seedGameRow(
  db: Client,
  gameId: string,
  rules: RulesConfig,
  status: 'waiting-for-players' | 'in-progress' | 'finished' = 'in-progress',
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO games (id, room_code, status, rules_config, engine_version, created_at, updated_at)
          VALUES (?, ?, ?, ?, '0.1.0', 1, 1)`,
    args: [gameId, nextRoomCode(), status, JSON.stringify(rules)],
  });
}

async function seedPlayerRow(db: Client, gameId: string, seat: Seat, profileId: string | null): Promise<void> {
  await db.execute({
    sql: `INSERT INTO players (id, game_id, seat, display_name, join_token, created_at, profile_id)
          VALUES (?, ?, ?, ?, ?, 1, ?)`,
    args: [`${gameId}-p${seat}`, gameId, seat, `Seat ${seat}`, `${gameId}-tok${seat}`, profileId],
  });
}

const BUST_RULES: RulesConfig = { ...DEFAULT_RULES, points: { ...DEFAULT_RULES.points, startingPoints: 100 } };

/** Same seed-44703/dealer-0 fixture used by ranked.test.ts: seat 2 beats seat 0's discard. */
async function playSeed44703Win(db: Client, gameId: string): Promise<void> {
  const discard = await submitAction(db, gameId, { type: 'discard', seat: 0, tileId: 'tiao-7-4' });
  if (isSubmitRuleError(discard)) throw new Error(`test fixture broken: ${discard.message}`);
  const pass1 = await submitAction(db, gameId, { type: 'pass', seat: 1 });
  if (isSubmitRuleError(pass1)) throw new Error(`test fixture broken: ${pass1.message}`);
  const win = await submitAction(db, gameId, { type: 'claim', seat: 2, claim: { type: 'hu' } });
  if (isSubmitRuleError(win)) throw new Error(`test fixture broken: ${win.message}`);
}

/**
 * Standings: seat2=1st (winner), seat1=2nd, seat3=3rd, seat0=4th (busted).
 */
async function finishedBustGame(
  db: Client,
  gameId: string,
  profileIds: readonly [string, string, string, string],
): Promise<void> {
  await seedGameRow(db, gameId, BUST_RULES);
  for (const seat of [0, 1, 2, 3] as const) {
    await seedPlayerRow(db, gameId, seat, profileIds[seat]);
  }
  await appendStartHand(db, gameId, { handNumber: 1, dealerSeat: 0, seed: 44703, repeatCount: 0, prevailingWind: 'east' });
  await playSeed44703Win(db, gameId);
  const advance = await advanceToNextHand(db, gameId);
  if (!('error' in advance) || advance.error !== 'game-finished') {
    throw new Error('test fixture broken: expected the match to bust-finish');
  }
}

async function fourFreshProfiles(db: Client): Promise<readonly [string, string, string, string]> {
  const ids = await Promise.all([0, 1, 2, 3].map(async (i) => (await createProfile(db, `Player${i}`)).profileId));
  return ids as [string, string, string, string];
}

async function setProfileRp(db: Client, profileId: string, rankPoints: number): Promise<void> {
  await db.execute({ sql: 'UPDATE profiles SET rank_points = ? WHERE id = ?', args: [rankPoints, profileId] });
}

async function readProfile(db: Client, profileId: string): Promise<{ rankPoints: number; apexAttainedAt: number | null }> {
  const row = await db.execute({ sql: 'SELECT rank_points, apex_attained_at FROM profiles WHERE id = ?', args: [profileId] });
  return {
    rankPoints: Number(row.rows[0].rank_points),
    apexAttainedAt: row.rows[0].apex_attained_at === null ? null : Number(row.rows[0].apex_attained_at),
  };
}

/**
 * Wraps a real Client so that the FIRST `execute` call whose SQL/args match
 * `matcher` still runs for real (the caller sees the true, un-interfered-with
 * result) but is immediately followed — before the caller's `await` resumes —
 * by `onMatch()`. This deterministically simulates "some other concurrent
 * settlement fully commits in the gap between my read and my next write",
 * without relying on best-effort Promise scheduling.
 */
function interceptOnce(
  realDb: Client,
  matcher: (stmt: InStatement) => boolean,
  onMatch: () => Promise<void>,
): Client {
  let triggered = false;
  return new Proxy(realDb, {
    get(target, prop, receiver) {
      if (prop === 'execute') {
        return async (stmt: InStatement) => {
          const result = await target.execute(stmt);
          if (!triggered && matcher(stmt)) {
            triggered = true;
            await onMatch();
          }
          return result;
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as Client;
}

function sqlOf(stmt: InStatement): string {
  return typeof stmt === 'string' ? stmt : stmt.sql;
}
function argsOf(stmt: InStatement): readonly unknown[] {
  if (typeof stmt === 'string') return [];
  return Array.isArray(stmt.args) ? stmt.args : [];
}

// =====================================================================================
// 1 + 5. Apex-crossing race: the follow-up correction pass fixes rank_history's
// numeric snapshot fields, but NEVER profiles.apex_attained_at — because that
// flag is set from `result.promotedToApex`, computed purely from each
// settlement's own STALE pre-race rpBefore read, not from actualRpAfter.
// =====================================================================================

describe('settleRankedMatch: apex-crossing race between two concurrent different-game settlements', () => {
  it('FAILING (bug repro): profiles.apex_attained_at must be stamped once rank_points crosses APEX_THRESHOLD_RP, even when the crossing only happens via the COMBINED effect of two racers whose individual stale reads each undershoot it', async () => {
    const db = await freshDb();
    const shared = await createProfile(db, 'SharedApexRacer');
    const othersA = await fourFreshProfiles(db);
    const othersB = await fourFreshProfiles(db);

    // Seat 2 is the winner in the finishedBustGame fixture (placement 1,
    // gold-band delta +80 at this RP). Starting at 4400: neither game's own
    // naive (stale) rpBefore=4400 -> rawRpAfter=4480 computation crosses
    // APEX_THRESHOLD_RP (4500) on its own — but 4400 + 80 + 80 = 4560 does.
    await setProfileRp(db, shared.profileId, 4400);
    const rpBeforeBothGames = (await readProfile(db, shared.profileId)).rankPoints;
    expect(rpBeforeBothGames).toBe(4400);

    const profileIdsG1: [string, string, string, string] = [othersA[0], othersA[1], shared.profileId, othersA[3]];
    const profileIdsG2: [string, string, string, string] = [othersB[0], othersB[1], shared.profileId, othersB[3]];
    await finishedBustGame(db, 'gApexRaceG1', profileIdsG1);
    await finishedBustGame(db, 'gApexRaceG2', profileIdsG2);

    // Deterministically interleave: G1's per-seat loop, on its SELECT of the
    // shared profile's rank_points/apex_attained_at, first lets that SELECT
    // return for real (rpBefore=4400 captured by G1), then runs G2's ENTIRE
    // settlement to completion (which itself reads the same untouched 4400,
    // computes its own +80, and commits) before G1 continues.
    const dbForG1 = interceptOnce(
      db,
      (stmt) =>
        sqlOf(stmt).includes('SELECT rank_points, apex_attained_at FROM profiles WHERE id = ?') &&
        argsOf(stmt)[0] === shared.profileId,
      async () => {
        const g2Result = await settleRankedMatch(db, 'gApexRaceG2');
        if (g2Result.status !== 'settled') throw new Error(`test fixture broken: G2 did not settle: ${g2Result.status}`);
      },
    );

    const g1Result = await settleRankedMatch(dbForG1, 'gApexRaceG1');
    if (g1Result.status !== 'settled') throw new Error(`test fixture broken: G1 did not settle: ${g1Result.status}`);

    const final = await readProfile(db, shared.profileId);

    // The arithmetic total IS correct — this part of the "commutative
    // addition" claim holds.
    expect(final.rankPoints).toBe(4560);
    expect(final.rankPoints).toBeGreaterThanOrEqual(APEX_THRESHOLD_RP);

    // CORRECT expected behavior: rank_points (4560) is >= APEX_THRESHOLD_RP,
    // so apex_attained_at must be stamped. THIS ASSERTION CURRENTLY FAILS:
    // apex_attained_at is left NULL forever, because BOTH racers
    // independently computed `promotedToApex = false` from their own
    // individually-insufficient stale reads (4400 -> 4480 each), and the
    // follow-up correction pass (settleRankedMatch, src/server/ranked.ts
    // around line 438-465) only corrects rank_history's rp_before/rp_after/
    // tier_after — it never re-derives or corrects profiles.apex_attained_at
    // against the TRUE post-update rank_points.
    expect(final.apexAttainedAt).not.toBeNull();

    // Downstream, user-visible consequence #1 of the bug above: this profile
    // is silently omitted from the Apex hall-of-fame leaderboards despite
    // genuinely qualifying. (This assertion currently fails together with
    // the one above, for the same root cause.)
    const leaderboards = await getApexLeaderboards(db);
    expect(leaderboards.foundingOrder.some((e) => e.profileId === shared.profileId)).toBe(true);
    expect(leaderboards.rpOrder.some((e) => e.profileId === shared.profileId)).toBe(true);

    // Downstream, user-visible consequence #2 (worse): the next settlement
    // for this same profile reads apex_attained_at=NULL, so its LOCAL
    // apexAttainedBefore is (incorrectly) false. `rankForRp` itself still
    // classifies the pre-match band as 'apex' (rp >= threshold, or'd in
    // independently of the flag), so the correct apex placement-delta row IS
    // used — but `settleRp`'s floor is keyed off the (wrong) local flag:
    // `floor = apexAttainedBefore ? APEX_THRESHOLD_RP : 0`. A wrongly-false
    // flag means a bad placement is floored at 0, not 4500 — a real
    // DEMOTION out of Apex, violating settleRp's own documented "an already-
    // Apex player never drops below the Apex floor" invariant.
    const othersC = await fourFreshProfiles(db);
    // Seat 0 is the BUSTED (4th place) seat in this fixture — apex-band 4th
    // place delta is -180 per config.ts's RP_DELTA_TABLE.
    const profileIdsG3: [string, string, string, string] = [shared.profileId, othersC[1], othersC[2], othersC[3]];
    await finishedBustGame(db, 'gApexRaceG3-demotion', profileIdsG3);
    const g3Result = await settleRankedMatch(db, 'gApexRaceG3-demotion');
    if (g3Result.status !== 'settled') throw new Error(`test fixture broken: G3 did not settle: ${g3Result.status}`);

    const afterDemotion = await readProfile(db, shared.profileId);
    // CORRECT expected behavior per settleRp's own documented sticky-Apex
    // floor: 4560 - 180 = 4380 raw, but floored at APEX_THRESHOLD_RP (4500)
    // since this player is genuinely already Apex. THIS ASSERTION CURRENTLY
    // FAILS: the actual result is 4380 (a real demotion out of Apex), because
    // `apexAttainedBefore` was read as false (see above).
    expect(afterDemotion.rankPoints).toBe(APEX_THRESHOLD_RP);
    expect(afterDemotion.rankPoints).toBeGreaterThanOrEqual(APEX_THRESHOLD_RP);

    const g3Seat = g3Result.seats.find((s) => s.seat === 0);
    if (g3Seat === undefined) throw new Error('no seat 0 in G3 result');
    // The audit trail itself should always report 'apex' for a player who
    // was — and, per the sticky-Apex spec, always should remain — Apex. THIS
    // ASSERTION CURRENTLY FAILS too.
    expect(g3Seat.tier).toBe('apex');
  });
});

// =====================================================================================
// 2. Multi-way (5-racer) chaining: with NO tier-crossing/apex-threshold
// involved, does the rp_before/rp_after chain (sorted by actual settlement
// order) hold exactly, and does the final total equal initial + sum(deltas)?
// =====================================================================================

describe('settleRankedMatch: 5-way concurrent different-game settlement of one shared profile', () => {
  it('produces an internally-consistent, gaplessly-chained rank_history audit trail and the exact expected final RP total', async () => {
    const db = await freshDb();
    const shared = await createProfile(db, 'FiveWayRacer');
    await setProfileRp(db, shared.profileId, 1000); // mid-silver, nowhere near any tier boundary

    const gameIds = ['g5w-A', 'g5w-B', 'g5w-C', 'g5w-D', 'g5w-E'];
    for (const gameId of gameIds) {
      const others = await fourFreshProfiles(db);
      const profileIds: [string, string, string, string] = [others[0], others[1], shared.profileId, others[3]];
      await finishedBustGame(db, gameId, profileIds);
    }

    const results = await Promise.all(gameIds.map((id) => settleRankedMatch(db, id)));
    for (const r of results) {
      if (r.status !== 'settled') throw new Error(`expected settled, got ${r.status}`);
    }

    const rows = await db.execute({
      sql: `SELECT game_id, rp_before, rp_delta, rp_after FROM rank_history WHERE profile_id = ? ORDER BY rp_before ASC`,
      args: [shared.profileId],
    });
    expect(rows.rows.length).toBe(5);

    const chain = rows.rows.map((r) => ({
      before: Number(r.rp_before),
      delta: Number(r.rp_delta),
      after: Number(r.rp_after),
    }));

    // Every row internally consistent.
    for (const link of chain) {
      expect(link.after).toBe(link.before + link.delta);
    }

    // Sorted by rp_before, the chain must be gapless: link[i].after === link[i+1].before.
    let expectedNext = 1000;
    for (const link of chain) {
      expect(link.before).toBe(expectedNext);
      expectedNext = link.after;
    }

    const finalProfile = await readProfile(db, shared.profileId);
    const totalDelta = chain.reduce((sum, link) => sum + link.delta, 0);
    expect(finalProfile.rankPoints).toBe(1000 + totalDelta);
  });
});

// =====================================================================================
// 3. Crash-resumability: a rank_history row exists for one seat but the
// matching profiles UPDATE never ran (simulating a process death between
// steps 1 and 2 of the per-seat sequence). Does re-running settleRankedMatch
// detect and complete this, or does the UNIQUE-violation "someone already
// claimed this seat" path silently treat it as fully done?
// =====================================================================================

describe('settleRankedMatch: crash-resumability after a partial (INSERT-only, no UPDATE) seat', () => {
  it('FAILING (bug repro): a rank_history row inserted without the matching profiles UPDATE must still be completed by a later resuming call, not treated as already-settled', async () => {
    const db = await freshDb();
    const profileIds = await fourFreshProfiles(db);
    await finishedBustGame(db, 'gCrashResume', profileIds);

    // Independently compute, via the SAME pure settleRp the real code uses,
    // exactly what settleRankedMatch would have written for seat 2 (the
    // winner) starting from its actual pre-settlement RP (0).
    const seat2ProfileId = profileIds[2];
    const before = await readProfile(db, seat2ProfileId);
    expect(before.rankPoints).toBe(0);
    const expected = settleRp({ rpBefore: 0, apexAttainedBefore: false, place: 1 });

    // Simulate "the process died right after the INSERT (step 1/3) committed
    // but before the profiles UPDATE (step 2/3) ran" by performing ONLY the
    // INSERT ourselves, with the exact values settleRankedMatch would have
    // used, and deliberately leaving profiles.rank_points untouched.
    await db.execute({
      sql: `INSERT INTO rank_history
              (id, game_id, profile_id, seat, placement, rp_before, rp_delta, rp_after, tier_after, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: ['crash-sim-row', 'gCrashResume', seat2ProfileId, 2, 1, 0, expected.rpDelta, expected.rpAfter, expected.tierAfter, Date.now()],
    });

    // Now run the REAL function, simulating "a later call resumes the
    // crashed settlement".
    const resumed = await settleRankedMatch(db, 'gCrashResume');
    if (resumed.status !== 'settled') throw new Error(`expected settled, got ${resumed.status}`);

    const after = await readProfile(db, seat2ProfileId);

    // CORRECT expected (crash-resumable) behavior: this seat's RP change
    // must eventually be applied. THIS ASSERTION CURRENTLY FAILS: it stays
    // 0. settleRankedMatch's per-seat loop, for seat 2, attempts its own
    // INSERT with its own freshly-computed values; that INSERT hits the
    // pre-existing UNIQUE(game_id, profile_id) row we just simulated, takes
    // the `isUniqueConstraintError` -> `continue` branch (src/server/
    // ranked.ts ~line 422-430: "Someone else ... already claimed this
    // seat's settlement — nothing further to do for it"), and NEVER applies
    // the profiles UPDATE for this seat — treating "a history row exists"
    // as unconditionally equivalent to "the RP was actually applied", which
    // is false in this simulated-crash state.
    expect(after.rankPoints).toBe(expected.rpAfter);

    // The other 3 seats (which had no pre-existing partial row) DID settle
    // correctly — confirming this is specifically a per-seat "already has a
    // history row" gap, not a wholesale failure. (Seat 0, the busted 4th
    // place, floors at 0 by settleRp's own design — bronze band never
    // demotes below the global 0 floor — so it's checked via its
    // rank_history row's rp_delta instead of a raw "moved off 0" check.)
    const seatPlacements: Record<number, 1 | 2 | 3 | 4> = { 0: 4, 1: 2, 3: 3 };
    for (const seat of [0, 1, 3] as const) {
      const expectedSeat = settleRp({ rpBefore: 0, apexAttainedBefore: false, place: seatPlacements[seat] });
      const row = await db.execute({
        sql: 'SELECT rank_points FROM profiles WHERE id = ?',
        args: [profileIds[seat]],
      });
      expect(Number(row.rows[0].rank_points)).toBe(expectedSeat.rpAfter);
    }

    // The audit trail (rank_history) always looked correct — the missing
    // profiles.rank_points update is invisible from getRankedResultForGame's
    // output alone, which is exactly why this class of bug is dangerous.
    const view = await getRankedResultForGame(db, 'gCrashResume');
    if (view.status !== 'settled') throw new Error(`expected settled, got ${view.status}`);
    const seat2View = view.seats.find((s) => s.seat === 2);
    expect(seat2View?.rpDelta).toBe(expected.rpDelta);
    // CORRECT expected behavior: the real RP total must match what the
    // audit trail claims. THIS ASSERTION CURRENTLY FAILS.
    expect(after.rankPoints).toBe(before.rankPoints + expected.rpDelta);
  });
});

// =====================================================================================
// 3b. All 4 rows exist (COUNT(*) === 4) but one has rp_applied = 0 — the
// reviewer-found blocker in settleRankedMatch's and getRankedResultForGame's
// "already settled?" cheap-path checks, which originally trusted row
// EXISTENCE (COUNT(*) === 4 / historyRows.rows.length === 4) instead of
// requiring rp_applied = 1 on every row. Distinct from the "3.
// crash-resumability" test above: that test leaves only 1 of 4 rows present
// at all (COUNT(*) === 1), which never reaches the cheap-path branch in the
// first place — this scenario specifically targets the cheap path itself.
// =====================================================================================

describe('settleRankedMatch / getRankedResultForGame: cheap-path checks require rp_applied = 1 on every row, not merely 4 rows existing', () => {
  it('a game with all 4 rank_history rows present but one rp_applied = 0 is resumed and completed, not falsely reported as settled', async () => {
    const db = await freshDb();
    const profileIds = await fourFreshProfiles(db);
    await finishedBustGame(db, 'gAllRowsOneUnapplied', profileIds);

    // Standings per finishedBustGame's doc comment: seat2=1st, seat1=2nd, seat3=3rd, seat0=4th.
    const placements: Record<number, 1 | 2 | 3 | 4> = { 0: 4, 1: 2, 2: 1, 3: 3 };
    const expected = Object.fromEntries(
      ([0, 1, 2, 3] as const).map((seat) => [seat, settleRp({ rpBefore: 0, apexAttainedBefore: false, place: placements[seat] })]),
    ) as Record<number, ReturnType<typeof settleRp>>;

    // Manually construct the exact state a crash could leave: all 4 seats'
    // rank_history rows exist (so COUNT(*) === 4), and 3 of them have their
    // matching profiles.rank_points update genuinely applied — but seat 3's
    // row was inserted with rp_applied left at 0 and its profiles update
    // never ran, simulating a crash between those two steps.
    for (const seat of [0, 1, 2, 3] as const) {
      const applied = seat !== 3;
      await db.execute({
        sql: `INSERT INTO rank_history
                (id, game_id, profile_id, seat, placement, rp_before, rp_delta, rp_after, tier_after, rp_applied, created_at)
              VALUES (?, 'gAllRowsOneUnapplied', ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
        args: [
          `row-${seat}`,
          profileIds[seat],
          seat,
          placements[seat],
          expected[seat].rpDelta,
          expected[seat].rpAfter,
          expected[seat].tierAfter,
          applied ? 1 : 0,
          Date.now(),
        ],
      });
      if (applied) await setProfileRp(db, profileIds[seat], expected[seat].rpAfter);
    }

    // Before the fix: getRankedResultForGame's historyRows.rows.length === 4
    // check alone would report 'settled' here, even though seat 3's RP was
    // never actually applied.
    const viewBeforeResume = await getRankedResultForGame(db, 'gAllRowsOneUnapplied');
    // Either shape is acceptable pre-resume (this call never triggers
    // settlement itself) as long as it does NOT claim seat 3 is done with a
    // real applied delta while the profile disagrees — the load-bearing
    // assertion is the post-resume one below. Documented here for clarity,
    // not asserted strictly, since getRankedResultForGame is read-only.
    void viewBeforeResume;

    // The real regression: settleRankedMatch's cheap path used to be
    // `COUNT(*) === 4` (ignoring rp_applied entirely), so it would return
    // getRankedResultForGame's result immediately WITHOUT ever calling
    // settleOneSeat for seat 3 — permanently losing that seat's RP while
    // reporting 'settled' with a correct-looking rpDelta forever after,
    // since nothing ever revisits it.
    const resumed = await settleRankedMatch(db, 'gAllRowsOneUnapplied');
    if (resumed.status !== 'settled') throw new Error(`expected settled, got ${resumed.status}`);

    const seat3After = await readProfile(db, profileIds[3]);
    expect(seat3After.rankPoints).toBe(expected[3].rpAfter);

    // The other 3 seats, which were already correctly applied, must be left
    // untouched (no double-application).
    for (const seat of [0, 1, 2] as const) {
      const after = await readProfile(db, profileIds[seat]);
      expect(after.rankPoints).toBe(expected[seat].rpAfter);
    }

    // A second call must now take the (now-genuinely-correct) cheap path
    // and be a true no-op.
    const secondCall = await settleRankedMatch(db, 'gAllRowsOneUnapplied');
    if (secondCall.status !== 'settled') throw new Error(`expected settled, got ${secondCall.status}`);
    const seat3Twice = await readProfile(db, profileIds[3]);
    expect(seat3Twice.rankPoints).toBe(expected[3].rpAfter);
  });
});

// =====================================================================================
// 4. One seat's processing throws mid-loop (real DB error, not a UNIQUE
// violation) — does the game get permanently, undetectably stuck
// partially-settled, and does settleRankedMatch keep throwing forever on
// every retry (poisoning every route that calls it unconditionally)?
// =====================================================================================

describe('settleRankedMatch: an unexpected per-seat error leaves a permanently partial, mis-reported settlement', () => {
  it('FAILING (bug repro): one permanently-broken seat must not permanently block the OTHER 3 healthy seats from ever settling', async () => {
    const db = await freshDb();
    const profileIds = await fourFreshProfiles(db);
    await finishedBustGame(db, 'gPartialFail', profileIds);

    // Force seat 1's profile lookup to fail by deleting its profiles row
    // (its players.profile_id link remains — `allFourSeatsLinked` only
    // checks non-null, never that the referenced profile row still exists).
    // SEATS iterates 0,1,2,3: seat 0 settles fine, then seat 1's SELECT
    // returns zero rows and settleRankedMatch throws before seats 2/3 are
    // ever attempted this call.
    await db.execute({ sql: 'DELETE FROM profiles WHERE id = ?', args: [profileIds[1]] });

    await expect(settleRankedMatch(db, 'gPartialFail')).rejects.toThrow(/no profile found with id/);

    const rows = await db.execute({ sql: 'SELECT seat FROM rank_history WHERE game_id = ? ORDER BY seat', args: ['gPartialFail'] });
    const settledSeats = rows.rows.map((r) => Number(r.seat));
    // Seat 0 settled before the loop reached the broken seat 1; seats 2/3
    // never got a chance to run this call.
    expect(settledSeats).toEqual([0]);

    // getRankedResultForGame's status logic (src/server/ranked.ts ~line
    // 250: `if (historyRows.rows.length === 4)`) has no notion of "broken",
    // only "4 rows = settled" vs "fewer = fall through to linkage check".
    // Since every seat is still (nominally) linked, it reports 'pending' —
    // the normal "will settle eventually, just hasn't yet" signal — with NO
    // way for any caller to distinguish this from an ordinary in-flight
    // settlement that just needs one more retry.
    const view = await getRankedResultForGame(db, 'gPartialFail');
    expect(view).toEqual({ status: 'pending' });

    // And a retry — the thing 'pending' is supposed to invite — can NEVER
    // succeed: the broken seat's profile is gone for good, so every future
    // call throws again, forever. Every route (state/actions/next-hand)
    // calls settleRankedMatch unconditionally and unwrapped whenever
    // status === 'finished' (see src/app/api/games/[code]/state/route.ts
    // ~line 120, actions/route.ts ~line 166) — an uncaught throw there means
    // EVERY future poll of this finished game's /state (and any further
    // /actions) 500s, forever, for every viewer, not just once.
    await expect(settleRankedMatch(db, 'gPartialFail')).rejects.toThrow(/no profile found with id/);
    await expect(settleRankedMatch(db, 'gPartialFail')).rejects.toThrow(/no profile found with id/);

    // CORRECT expected behavior: seat 1's permanently-broken profile should
    // not block seats 2/3 (perfectly healthy) from ever settling — a single
    // seat's failure ought to be isolated, not poison the whole per-game
    // settlement forever. THIS ASSERTION CURRENTLY FAILS: seat order
    // (0,1,2,3) means the loop throws at seat 1 on every single retry,
    // before it ever reaches seats 2/3, so they NEVER settle no matter how
    // many times settleRankedMatch is retried.
    const rowsAfterRetries = await db.execute({ sql: 'SELECT seat FROM rank_history WHERE game_id = ?', args: ['gPartialFail'] });
    expect(rowsAfterRetries.rows.map((r) => Number(r.seat)).sort()).toEqual([0, 2, 3]);
  });
});

// =====================================================================================
// 6. Idempotency's actual code path: does calling settleRankedMatch a second
// time on an already-fully-settled game genuinely take the cheap early-
// return path (no snapshot replay), not just happen to produce the same
// numbers via the full per-seat loop a second time?
// =====================================================================================

describe('settleRankedMatch: idempotent re-call genuinely short-circuits before any snapshot replay', () => {
  it('does not call getMatchSnapshot on a second call once all 4 rows already exist', async () => {
    vi.resetModules();
    let getMatchSnapshotCalls = 0;
    vi.doMock('./replay', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./replay')>();
      return {
        ...actual,
        getMatchSnapshot: (...args: Parameters<typeof actual.getMatchSnapshot>) => {
          getMatchSnapshotCalls += 1;
          return actual.getMatchSnapshot(...args);
        },
      };
    });

    const { settleRankedMatch: mockedSettle } = await import('./ranked');
    const { runMigrations: mockedRunMigrations } = await import('./migrations');
    const { appendStartHand: mockedAppendStartHand } = await import('./actions-log');
    const { advanceToNextHand: mockedAdvance, submitAction: mockedSubmit } = await import('./replay');
    const { createProfile: mockedCreateProfile } = await import('./ranked');

    const db = createClient({ url: ':memory:' });
    await mockedRunMigrations(db);

    const profileIds = await Promise.all([0, 1, 2, 3].map(async (i) => (await mockedCreateProfile(db, `P${i}`)).profileId));
    await db.execute({
      sql: `INSERT INTO games (id, room_code, status, rules_config, engine_version, created_at, updated_at)
            VALUES ('gIdemMock', 'IDEMMK', 'in-progress', ?, '0.1.0', 1, 1)`,
      args: [JSON.stringify(BUST_RULES)],
    });
    for (const seat of [0, 1, 2, 3] as const) {
      await db.execute({
        sql: `INSERT INTO players (id, game_id, seat, display_name, join_token, created_at, profile_id)
              VALUES (?, 'gIdemMock', ?, ?, ?, 1, ?)`,
        args: [`gIdemMock-p${seat}`, seat, `Seat ${seat}`, `gIdemMock-tok${seat}`, profileIds[seat]],
      });
    }
    await mockedAppendStartHand(db, 'gIdemMock', { handNumber: 1, dealerSeat: 0, seed: 44703, repeatCount: 0, prevailingWind: 'east' });
    const discard = await mockedSubmit(db, 'gIdemMock', { type: 'discard', seat: 0, tileId: 'tiao-7-4' });
    if (isSubmitRuleError(discard)) throw new Error('fixture broken');
    const pass1 = await mockedSubmit(db, 'gIdemMock', { type: 'pass', seat: 1 });
    if (isSubmitRuleError(pass1)) throw new Error('fixture broken');
    const win = await mockedSubmit(db, 'gIdemMock', { type: 'claim', seat: 2, claim: { type: 'hu' } });
    if (isSubmitRuleError(win)) throw new Error('fixture broken');
    const advance = await mockedAdvance(db, 'gIdemMock');
    if (!('error' in advance) || advance.error !== 'game-finished') throw new Error('fixture broken');

    const first = await mockedSettle(db, 'gIdemMock');
    if (first.status !== 'settled') throw new Error(`expected settled, got ${first.status}`);
    const callsAfterFirst = getMatchSnapshotCalls;
    expect(callsAfterFirst).toBeGreaterThan(0);

    const second = await mockedSettle(db, 'gIdemMock');
    expect(second).toEqual(first);
    // The cheap COUNT(*)===4 path must return WITHOUT any further
    // getMatchSnapshot call.
    expect(getMatchSnapshotCalls).toBe(callsAfterFirst);

    vi.doUnmock('./replay');
    vi.resetModules();
  });
});

// =====================================================================================
// 9. games.ts's profile-link-collision retry: does isProfileLinkConstraintError
// correctly scope to the players(game_id, profile_id) partial-unique-index
// violation only, or does it (or the surrounding catch) swallow ANY error
// thrown during the players INSERT?
// =====================================================================================

describe('joinGame: profile-link-collision retry does not swallow unrelated errors', () => {
  it('propagates a genuine non-constraint error from the players INSERT rather than silently retrying unlinked', async () => {
    const realDb = await freshDb();
    const created = await createGame(realDb, { displayName: 'Alice' });

    let insertAttempts = 0;
    const wrapped = new Proxy(realDb, {
      get(target, prop, receiver) {
        if (prop === 'execute') {
          return async (stmt: InStatement) => {
            const sql = sqlOf(stmt);
            if (sql.includes('INSERT INTO players')) {
              insertAttempts += 1;
              // A realistic, genuinely unrelated DB failure (e.g. a dropped
              // connection) — NOT a UNIQUE constraint violation of any kind.
              throw new LibsqlError('simulated connection reset', 'SQLITE_IOERR');
            }
            return target.execute(stmt);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as Client;

    await expect(joinGame(wrapped, created.roomCode, { displayName: 'Bob', profileId: 'irrelevant-profile-id' })).rejects.toThrow(
      /simulated connection reset/,
    );
    // Only the ONE real attempt — no silent "catch, assume profile
    // collision, retry unlinked" swallow-and-continue for an unrelated error.
    expect(insertAttempts).toBe(1);

    // No player row was actually inserted for the failed attempt.
    const players = await listPlayers(realDb, created.gameId);
    expect(players.length).toBe(1); // only the seat-0 creator
  });

  it('genuinely retries unlinked ONLY for a real players(game_id, profile_id) collision, not for a coincidental seat collision with a profileId present', async () => {
    const db = await freshDb();
    const profile = await createProfile(db, 'Carol');
    const created = await createGame(db, { displayName: 'Alice' });

    // First linked join: seat 1, profile P.
    const firstJoin = await joinGame(db, created.roomCode, { displayName: 'Bob', profileId: profile.profileId });
    if ('error' in firstJoin) throw new Error('fixture broken');
    expect(firstJoin.seat).toBe(1);

    // Second join attempt with the SAME profileId (already linked to seat 1
    // in this game) must retry unlinked at whatever the next free seat is —
    // never fail the join, never re-collide on the seat itself.
    const secondJoin = await joinGame(db, created.roomCode, { displayName: 'Carol2', profileId: profile.profileId });
    if ('error' in secondJoin) throw new Error('fixture broken');
    expect(secondJoin.seat).toBe(2);

    const players = await listPlayers(db, created.gameId);
    const seat2 = players.find((p) => p.seat === 2);
    expect(seat2?.profileId).toBeNull(); // unlinked fallback, not failed
    const seat1 = players.find((p) => p.seat === 1);
    expect(seat1?.profileId).toBe(profile.profileId); // original link untouched
  });
});
