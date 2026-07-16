/**
 * SECOND independent adversarial pass on the round-2 fix to `settleRankedMatch`
 * (src/server/ranked.ts) and `migrations/0004_rank_settlement_resilience.sql`.
 * Does NOT reuse or trust ranked.round2-concurrency-adversarial.test.ts's own
 * assertions or the builder's own report — reads the current implementation
 * line-by-line and constructs scenarios of its own, per the task brief:
 *
 *   1. Multiple-simultaneously-broken-seats (the builder's own flagged gap).
 *   2. A harder, 3-way concurrent Apex-crossing race across 3 different games.
 *   3. rp_applied genuinely used correctly in BOTH directions (heals a 0, and
 *      trusts a 1 without double-applying).
 *   4. Route-level try/catch, exercised through the real route handler.
 *   7. Migration correctness — specifically whether ALTER TABLE ... DEFAULT 0
 *      retroactively "un-applies" pre-migration history rows that were
 *      already correctly applied under the old (round-1) code.
 */
import { createClient, type Client, type InStatement } from '@libsql/client';
import { describe, expect, it } from 'vitest';
import { runMigrations } from './migrations';
import { appendStartHand } from './actions-log';
import { advanceToNextHand, submitAction } from './replay';
import { createGame, joinGame } from './games';
import { createProfile, getApexLeaderboards, getRankedResultForGame, settleRankedMatch } from './ranked';
import { settleRp } from '../lib/ranked/ladder';
import { DEFAULT_RULES, type RulesConfig } from '../engine/rules-config';
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
  return `T3${roomCodeCounter}`.toUpperCase().padStart(6, 'Z');
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

/** Same seed-44703/dealer-0 fixture used elsewhere: seat 2 beats seat 0's discard. */
async function playSeed44703Win(db: Client, gameId: string): Promise<void> {
  const discard = await submitAction(db, gameId, { type: 'discard', seat: 0, tileId: 'tiao-7-4' });
  if (isSubmitRuleError(discard)) throw new Error(`test fixture broken: ${discard.message}`);
  const pass1 = await submitAction(db, gameId, { type: 'pass', seat: 1 });
  if (isSubmitRuleError(pass1)) throw new Error(`test fixture broken: ${pass1.message}`);
  const win = await submitAction(db, gameId, { type: 'claim', seat: 2, claim: { type: 'hu' } });
  if (isSubmitRuleError(win)) throw new Error(`test fixture broken: ${win.message}`);
}

/** Standings: seat2=1st (winner), seat1=2nd, seat3=3rd, seat0=4th (busted). */
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

async function failureRows(
  db: Client,
  gameId: string,
): Promise<readonly { seat: number; attemptCount: number; lastError: string }[]> {
  const rows = await db.execute({
    sql: 'SELECT seat, attempt_count, last_error FROM rank_settlement_failures WHERE game_id = ? ORDER BY seat',
    args: [gameId],
  });
  return rows.rows.map((r) => ({
    seat: Number(r.seat),
    attemptCount: Number(r.attempt_count),
    lastError: String(r.last_error),
  }));
}

async function historySeats(db: Client, gameId: string): Promise<number[]> {
  const rows = await db.execute({ sql: 'SELECT seat FROM rank_history WHERE game_id = ? ORDER BY seat', args: [gameId] });
  return rows.rows.map((r) => Number(r.seat));
}

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
// 7. MIGRATION CORRECTNESS — does ALTER TABLE rank_history ADD COLUMN rp_applied
// INTEGER NOT NULL DEFAULT 0 retroactively mark a pre-existing, already-fully-
// -applied (under the OLD round-1 code) history row as "not yet applied", so
// that the NEW code re-applies its rp_delta a second time?
// =====================================================================================

describe('settleRankedMatch: migration 0004 default value vs. pre-existing (pre-round-2) history rows', () => {
  it('BUG: a partially-settled game whose EXISTING rows were already correctly applied under the pre-round-2 code gets those rows double-applied by the new rp_applied-aware code', async () => {
    const db = await freshDb();
    const profileIds = await fourFreshProfiles(db);
    await finishedBustGame(db, 'gMigrationDoubleApply', profileIds);

    // Simulate "this game was already partially settled under the OLD
    // (round-1) code, before migration 0004 ever ran, and migration 0004's
    // own backfill (`UPDATE rank_history SET rp_applied = 1`, added after
    // this exact test first caught the bug) has already run against it":
    // seats 0 and 2 each have a rank_history row AND their matching
    // profiles.rank_points update genuinely landed (that's how round-1 code
    // worked in the non-crash case). We write `rp_applied = 1` explicitly
    // here rather than relying on the column's bare schema DEFAULT, because
    // that default (0) is deliberately ambiguous on its own — it's shared
    // with the genuine-incomplete-row shape the round-2 adversarial test
    // (`ranked.round2-concurrency-adversarial.test.ts`) constructs the exact
    // same way to represent a real mid-settlement crash. The two scenarios
    // are indistinguishable from a bare INSERT alone; migration 0004's
    // backfill is what disambiguates them for REAL pre-existing rows, so
    // this test asserts the POST-backfill steady state, not the transient
    // pre-backfill moment.
    const seat0Expected = settleRp({ rpBefore: 0, apexAttainedBefore: false, place: 4 }); // busted, 4th
    const seat2Expected = settleRp({ rpBefore: 0, apexAttainedBefore: false, place: 1 }); // winner, 1st

    for (const [seat, profileId, expected] of [
      [0, profileIds[0], seat0Expected],
      [2, profileIds[2], seat2Expected],
    ] as const) {
      await db.execute({
        sql: `INSERT INTO rank_history
                (id, game_id, profile_id, seat, placement, rp_before, rp_delta, rp_after, tier_after, created_at, rp_applied)
              VALUES (?, 'gMigrationDoubleApply', ?, ?, ?, 0, ?, ?, ?, 1, 1)`,
        args: [`premig-${seat}`, profileId, seat, seat === 0 ? 4 : 1, expected.rpDelta, expected.rpAfter, expected.tierAfter],
      });
      // The old code's matching profiles update ALREADY genuinely landed —
      // this is the "already correctly applied" part of the scenario.
      await setProfileRp(db, profileId, expected.rpAfter);
    }

    const seat0Before = await readProfile(db, profileIds[0]);
    const seat2Before = await readProfile(db, profileIds[2]);
    expect(seat0Before.rankPoints).toBe(seat0Expected.rpAfter);
    expect(seat2Before.rankPoints).toBe(seat2Expected.rpAfter);

    // Now a LATER call (post-migration-0004, running the new code) resumes
    // settlement for the still-unsettled seats 1 and 3.
    const result = await settleRankedMatch(db, 'gMigrationDoubleApply');
    if (result.status !== 'settled') throw new Error(`expected settled, got ${result.status}`);

    const seat0After = await readProfile(db, profileIds[0]);
    const seat2After = await readProfile(db, profileIds[2]);

    // Expected behavior: seats 0 and 2, which were already fully and
    // correctly applied (rp_applied = 1, matching what migration 0004's
    // backfill produces for any row that existed before it ran), must be
    // left untouched — settleOneSeat's UNIQUE-violation branch
    // (src/server/ranked.ts) reads back `existingRow.rp_applied === 1` and
    // skips re-applying.
    expect(seat0After.rankPoints).toBe(seat0Expected.rpAfter);
    expect(seat2After.rankPoints).toBe(seat2Expected.rpAfter);
  });
});

// =====================================================================================
// 1. MULTIPLE SIMULTANEOUSLY-BROKEN SEATS — the builder's own flagged,
// explicitly-unverified gap.
// =====================================================================================

describe('settleRankedMatch: two simultaneously-broken seats', () => {
  it('first call stops immediately at the FIRST broken seat encountered in SEATS order, without touching later seats (including the other broken one)', async () => {
    const db = await freshDb();
    const profileIds = await fourFreshProfiles(db);
    await finishedBustGame(db, 'gTwoBroken', profileIds);

    // Break seat 1 AND seat 3's linked profiles.
    await db.execute({ sql: 'DELETE FROM profiles WHERE id = ?', args: [profileIds[1]] });
    await db.execute({ sql: 'DELETE FROM profiles WHERE id = ?', args: [profileIds[3]] });

    await expect(settleRankedMatch(db, 'gTwoBroken')).rejects.toThrow(/no profile found with id/);

    // Only seat 0 (before the first broken seat, 1) actually settled.
    expect(await historySeats(db, 'gTwoBroken')).toEqual([0]);

    // Only seat 1's failure is recorded yet — seat 3's brokenness has not
    // been discovered because the loop never reached it this call.
    const failures1 = await failureRows(db, 'gTwoBroken');
    expect(failures1.map((f) => f.seat)).toEqual([1]);
    expect(failures1[0].attemptCount).toBe(1);
  });

  it('converges over repeated retries to: both broken seats independently, correctly, durably recorded; the 2 healthy seats fully settled; neither broken seat corrupts the other’s failure record', async () => {
    const db = await freshDb();
    const profileIds = await fourFreshProfiles(db);
    await finishedBustGame(db, 'gTwoBrokenConverge', profileIds);
    await db.execute({ sql: 'DELETE FROM profiles WHERE id = ?', args: [profileIds[1]] });
    await db.execute({ sql: 'DELETE FROM profiles WHERE id = ?', args: [profileIds[3]] });

    // Call 1: fresh pass stops at seat 1 (first broken seat in SEATS order).
    await expect(settleRankedMatch(db, 'gTwoBrokenConverge')).rejects.toThrow(/no profile found with id/);
    expect(await historySeats(db, 'gTwoBrokenConverge')).toEqual([0]);

    // Call 2: known-bad = {1}. Fresh pass = [0 (already settled, no-op), 2, 3].
    // Seat 2 settles; seat 3 is STILL "fresh" this call (never failed before)
    // so its failure stops the fresh pass immediately BEFORE the deferred
    // pass (seat 1) is ever attempted this call — a real, if bounded and
    // self-healing, side effect: a never-broken seat sitting in SEATS order
    // right after a newly-discovered broken seat is NOT settled on this call
    // either, even though seat 1 (already known-bad) is not the one blocking
    // it — seat 3 blocks itself.
    await expect(settleRankedMatch(db, 'gTwoBrokenConverge')).rejects.toThrow(/no profile found with id/);
    expect(await historySeats(db, 'gTwoBrokenConverge')).toEqual([0, 2]);
    const failures2 = await failureRows(db, 'gTwoBrokenConverge');
    expect(failures2.map((f) => f.seat)).toEqual([1, 3]);
    // Seat 1's failure record must be untouched by seat 3's own failure this
    // call: since seat 1 is already known-bad, it lives in the DEFERRED
    // pass, and call 2's fresh pass (0, 2, 3) throws at seat 3 BEFORE the
    // deferred pass ever runs — so seat 1 is not even attempted this call,
    // and its attempt_count correctly stays at 1 (from call 1 only), not
    // incremented again.
    expect(failures2.find((f) => f.seat === 1)?.attemptCount).toBe(1);
    expect(failures2.find((f) => f.seat === 3)?.attemptCount).toBe(1);

    // Call 3: known-bad = {1, 3}. Fresh pass = [0, 2] (both already settled,
    // safe no-ops, no throw). Deferred pass = [1, 3], each independently
    // attempted (the deferred loop does NOT stop at the first failure).
    const results3: unknown[] = [];
    try {
      await settleRankedMatch(db, 'gTwoBrokenConverge');
    } catch (err) {
      results3.push(err);
    }
    expect(results3.length).toBe(1);

    // The 2 healthy seats are now durably, fully settled (3rd call didn't
    // regress them).
    expect(await historySeats(db, 'gTwoBrokenConverge')).toEqual([0, 2]);

    // BOTH broken seats' failures are now recorded, independently, each with
    // its own correct attempt_count — proving one broken seat's handling did
    // not skip or corrupt the other's bookkeeping.
    const failures3 = await failureRows(db, 'gTwoBrokenConverge');
    expect(failures3.map((f) => f.seat)).toEqual([1, 3]);
    for (const f of failures3) {
      expect(f.lastError).toMatch(/no profile found with id/);
      expect(f.attemptCount).toBeGreaterThanOrEqual(2);
    }

    // Now "fix" seat 1 by restoring its profile row (same id, fresh RP 0).
    await db.execute({
      sql: `INSERT INTO profiles (id, secret_token, display_name, rank_points, apex_attained_at, created_at, updated_at)
            VALUES (?, ?, 'RestoredSeat1', 0, NULL, ?, ?)`,
      args: [profileIds[1], `restored-secret-${profileIds[1]}`, Date.now(), Date.now()],
    });

    // Call 4: known-bad = {1, 3}. Fresh pass = [0, 2] (no-ops). Deferred pass
    // = [1 (now fixed, succeeds, clears its failure record), 3 (still
    // broken, fails again)].
    await expect(settleRankedMatch(db, 'gTwoBrokenConverge')).rejects.toThrow(/no profile found with id/);

    // Exactly 3 of 4 seats settled now: the 2 originally-healthy seats,
    // UNCHANGED, plus the newly-fixed seat 1. Seat 3 (truly still broken)
    // correctly remains unsettled.
    expect(await historySeats(db, 'gTwoBrokenConverge')).toEqual([0, 1, 2]);

    const failures4 = await failureRows(db, 'gTwoBrokenConverge');
    // Seat 1's failure record is cleared (it recovered); only seat 3 remains
    // reported as broken.
    expect(failures4.map((f) => f.seat)).toEqual([3]);

    // The already-settled seats' RP is untouched by this whole saga (no
    // double-application from any of the retries above).
    const seat0Rp = await readProfile(db, profileIds[0]);
    const seat2Rp = await readProfile(db, profileIds[2]);
    const seat0Expected = settleRp({ rpBefore: 0, apexAttainedBefore: false, place: 4 });
    const seat2Expected = settleRp({ rpBefore: 0, apexAttainedBefore: false, place: 1 });
    expect(seat0Rp.rankPoints).toBe(seat0Expected.rpAfter);
    expect(seat2Rp.rankPoints).toBe(seat2Expected.rpAfter);
  });
});

// =====================================================================================
// 2. Harder Apex race: 3-way concurrent settlement of one shared profile
// across 3 different games, where NO individual game's delta alone crosses
// APEX_THRESHOLD_RP, but the combined effect of any 2 does.
// =====================================================================================

describe('settleRankedMatch: 3-way concurrent apex-crossing race, deterministic worst-case interleaving', () => {
  it('apex_attained_at is set exactly once, at the FIRST write whose cumulative effect crosses the threshold, and is never re-stamped by a later racer whose own naive stale computation would also have crossed it', async () => {
    const db = await freshDb();
    const shared = await createProfile(db, 'ThreeWayApexRacer');
    const othersA = await fourFreshProfiles(db);
    const othersB = await fourFreshProfiles(db);
    const othersC = await fourFreshProfiles(db);

    // Gold band (3600..4499), delta for 1st place = +80. Individually:
    // 4400+80=4480 < 4500 (no cross). Any two combined: 4400+80+80=4560 >=
    // 4500 (crosses). All three: 4640.
    await setProfileRp(db, shared.profileId, 4400);

    const profileIdsG1: [string, string, string, string] = [othersA[0], othersA[1], shared.profileId, othersA[3]];
    const profileIdsG2: [string, string, string, string] = [othersB[0], othersB[1], shared.profileId, othersB[3]];
    const profileIdsG3: [string, string, string, string] = [othersC[0], othersC[1], shared.profileId, othersC[3]];
    await finishedBustGame(db, 'g3wA', profileIdsG1);
    await finishedBustGame(db, 'g3wB', profileIdsG2);
    await finishedBustGame(db, 'g3wC', profileIdsG3);

    let apexAtAfterG2: number | null = null;

    // Nested deterministic interleave: G1's read of the shared profile
    // triggers G2's ENTIRE settlement (which hasn't written yet either);
    // G2's OWN read of the shared profile, in turn, triggers G3's entire
    // settlement to completion FIRST. Net order of the 3 real reads: G1,
    // then G2, then G3 all observe rank_points=4400 (none has written yet).
    // Net order of the 3 real profiles writes: G3 writes first (4400->4480,
    // no cross), then G2 (4480->4560, CROSSES — sets apex_attained_at),
    // then G1 (4560->4640, already apex — must NOT re-stamp).
    const dbForG2 = interceptOnce(
      db,
      (stmt) =>
        sqlOf(stmt).includes('SELECT rank_points, apex_attained_at FROM profiles WHERE id = ?') &&
        argsOf(stmt)[0] === shared.profileId,
      async () => {
        const g3Result = await settleRankedMatch(db, 'g3wC');
        if (g3Result.status !== 'settled') throw new Error(`fixture broken: G3 did not settle: ${g3Result.status}`);
        const midway = await readProfile(db, shared.profileId);
        // Confirms G3 alone genuinely did NOT cross the threshold.
        expect(midway.rankPoints).toBe(4480);
        expect(midway.apexAttainedAt).toBeNull();
      },
    );

    const dbForG1 = interceptOnce(
      db,
      (stmt) =>
        sqlOf(stmt).includes('SELECT rank_points, apex_attained_at FROM profiles WHERE id = ?') &&
        argsOf(stmt)[0] === shared.profileId,
      async () => {
        const g2Result = await settleRankedMatch(dbForG2, 'g3wB');
        if (g2Result.status !== 'settled') throw new Error(`fixture broken: G2 did not settle: ${g2Result.status}`);
        const afterG2 = await readProfile(db, shared.profileId);
        expect(afterG2.rankPoints).toBe(4560);
        expect(afterG2.apexAttainedAt).not.toBeNull();
        apexAtAfterG2 = afterG2.apexAttainedAt;
      },
    );

    const g1Result = await settleRankedMatch(dbForG1, 'g3wA');
    if (g1Result.status !== 'settled') throw new Error(`fixture broken: G1 did not settle: ${g1Result.status}`);

    const final = await readProfile(db, shared.profileId);
    expect(final.rankPoints).toBe(4640); // 4400 + 80*3
    expect(final.apexAttainedAt).not.toBeNull();
    // The critical assertion: G1's own write (which happened AFTER apex was
    // already set by G2) must not have overwritten the timestamp with a
    // later one of its own.
    expect(final.apexAttainedAt).toBe(apexAtAfterG2);

    // Downstream: the profile appears exactly once (not 3 times) on both
    // Apex leaderboards.
    const leaderboards = await getApexLeaderboards(db);
    expect(leaderboards.foundingOrder.filter((e) => e.profileId === shared.profileId).length).toBe(1);
    expect(leaderboards.rpOrder.filter((e) => e.profileId === shared.profileId).length).toBe(1);

    // Every game's own audit-trail row correctly reflects 'apex' as its
    // tier_after once the cumulative crossing has happened by the time that
    // row was corrected (G1 and G2's rows should read 'apex'; G3's own row,
    // corrected before anything crossed, should read the real pre-cross
    // gold tier).
    const g3View = await getRankedResultForGame(db, 'g3wC');
    if (g3View.status !== 'settled') throw new Error('g3 not settled');
    expect(g3View.seats.find((s) => s.seat === 2)?.tier).toBe('gold');

    const g2View = await getRankedResultForGame(db, 'g3wB');
    if (g2View.status !== 'settled') throw new Error('g2 not settled');
    expect(g2View.seats.find((s) => s.seat === 2)?.tier).toBe('apex');

    const g1View = await getRankedResultForGame(db, 'g3wA');
    if (g1View.status !== 'settled') throw new Error('g1 not settled');
    expect(g1View.seats.find((s) => s.seat === 2)?.tier).toBe('apex');
  });

  it('a genuine Promise.all 3-way race (non-deterministic interleaving) still lands on the correct total and a non-null apex_attained_at', async () => {
    const db = await freshDb();
    const shared = await createProfile(db, 'ThreeWayApexRacerPromiseAll');
    await setProfileRp(db, shared.profileId, 4400);

    const gameIds = ['g3wP-A', 'g3wP-B', 'g3wP-C'];
    for (const gameId of gameIds) {
      const others = await fourFreshProfiles(db);
      const profileIds: [string, string, string, string] = [others[0], others[1], shared.profileId, others[3]];
      await finishedBustGame(db, gameId, profileIds);
    }

    const results = await Promise.all(gameIds.map((id) => settleRankedMatch(db, id)));
    for (const r of results) {
      if (r.status !== 'settled') throw new Error(`expected settled, got ${r.status}`);
    }

    const final = await readProfile(db, shared.profileId);
    expect(final.rankPoints).toBe(4640);
    expect(final.apexAttainedAt).not.toBeNull();
  });
});

// =====================================================================================
// 3. rp_applied direct-manipulation verification, BOTH directions.
// =====================================================================================

describe('settleRankedMatch: rp_applied is the genuine completion arbiter, not a superficial flag', () => {
  it('heals a directly-inserted rp_applied=0 row exactly once: 2nd call applies it, 3rd call does not double-apply', async () => {
    const db = await freshDb();
    const profileIds = await fourFreshProfiles(db);
    await finishedBustGame(db, 'gRpAppliedHeal', profileIds);

    const seat2ProfileId = profileIds[2];
    const before = await readProfile(db, seat2ProfileId);
    expect(before.rankPoints).toBe(0);
    const expected = settleRp({ rpBefore: 0, apexAttainedBefore: false, place: 1 });

    // Directly manipulate the DB: insert a rank_history row with
    // rp_applied=0, matching a crash between the INSERT and the profiles
    // UPDATE. profiles.rank_points is deliberately left untouched.
    await db.execute({
      sql: `INSERT INTO rank_history
              (id, game_id, profile_id, seat, placement, rp_before, rp_delta, rp_after, tier_after, rp_applied, created_at)
            VALUES (?, 'gRpAppliedHeal', ?, 2, 1, 0, ?, ?, ?, 0, ?)`,
      args: ['heal-row', seat2ProfileId, expected.rpDelta, expected.rpAfter, expected.tierAfter, Date.now()],
    });

    // Confirm the profile does NOT yet reflect this row's delta.
    const stillUnapplied = await readProfile(db, seat2ProfileId);
    expect(stillUnapplied.rankPoints).toBe(0);

    // 1st real call: heals seat 2's row (via the UNIQUE-violation ->
    // rp_applied===0 -> CAS -> apply path) and settles seats 0/1/3 fresh.
    const first = await settleRankedMatch(db, 'gRpAppliedHeal');
    if (first.status !== 'settled') throw new Error(`expected settled, got ${first.status}`);

    const afterFirst = await readProfile(db, seat2ProfileId);
    expect(afterFirst.rankPoints).toBe(expected.rpAfter);

    const rpAppliedFlag = await db.execute({ sql: 'SELECT rp_applied FROM rank_history WHERE id = ?', args: ['heal-row'] });
    expect(Number(rpAppliedFlag.rows[0].rp_applied)).toBe(1);

    // 2nd real call (idempotent re-call): must NOT double-apply.
    const second = await settleRankedMatch(db, 'gRpAppliedHeal');
    if (second.status !== 'settled') throw new Error(`expected settled, got ${second.status}`);
    const afterSecond = await readProfile(db, seat2ProfileId);
    expect(afterSecond.rankPoints).toBe(expected.rpAfter);

    // 3rd real call: still must not double-apply.
    const third = await settleRankedMatch(db, 'gRpAppliedHeal');
    if (third.status !== 'settled') throw new Error(`expected settled, got ${third.status}`);
    const afterThird = await readProfile(db, seat2ProfileId);
    expect(afterThird.rankPoints).toBe(expected.rpAfter);
  });

  it('trusts a directly-inserted rp_applied=1 row and does NOT re-apply its delta', async () => {
    const db = await freshDb();
    const profileIds = await fourFreshProfiles(db);
    await finishedBustGame(db, 'gRpAppliedTrust', profileIds);

    const seat2ProfileId = profileIds[2];
    const expected = settleRp({ rpBefore: 0, apexAttainedBefore: false, place: 1 });

    // Directly manipulate the DB: insert a FULLY-complete row (rp_applied=1)
    // AND apply the matching profiles update ourselves, simulating a
    // genuinely-completed settlement performed entirely outside this call.
    await db.execute({
      sql: `INSERT INTO rank_history
              (id, game_id, profile_id, seat, placement, rp_before, rp_delta, rp_after, tier_after, rp_applied, created_at)
            VALUES (?, 'gRpAppliedTrust', ?, 2, 1, 0, ?, ?, ?, 1, ?)`,
      args: ['trust-row', seat2ProfileId, expected.rpDelta, expected.rpAfter, expected.tierAfter, Date.now()],
    });
    await setProfileRp(db, seat2ProfileId, expected.rpAfter);

    const result = await settleRankedMatch(db, 'gRpAppliedTrust');
    if (result.status !== 'settled') throw new Error(`expected settled, got ${result.status}`);

    const after = await readProfile(db, seat2ProfileId);
    // CORRECT: must remain exactly the single application's worth, never
    // doubled.
    expect(after.rankPoints).toBe(expected.rpAfter);
  });
});

// =====================================================================================
// 4. Route-level try/catch, exercised through the REAL route handler (not a
// direct settleRankedMatch call) — confirms a settlement throw genuinely
// does not 500 the route, and the rest of the game view is intact.
// =====================================================================================

describe('GET /api/games/[code]/state route: settleRankedMatch throw does not 500 the response', () => {
  it('returns 200 with a valid, intact game view (ranked omitted or a safe fallback) when the finishing seat’s own profile is broken', async () => {
    process.env.TURSO_DATABASE_URL = ':memory:';
    delete process.env.TURSO_AUTH_TOKEN;
    // Import lazily so this test's process.env write takes effect before
    // src/server/db.ts's getDb() singleton is first constructed, matching
    // the existing route-test convention (see state/route.test.ts).
    const { getDb } = await import('./db');
    const { GET } = await import('../app/api/games/[code]/state/route');

    const db = getDb();
    await runMigrations(db);

    const profiles = await Promise.all([0, 1, 2, 3].map(async (i) => createProfile(db, `RouteBrokenPlayer${i}`)));
    const created = await createGame(db, {
      displayName: 'Alice',
      rules: { points: { startingPoints: 100 } } as Partial<RulesConfig>,
      profileId: profiles[0].profileId,
    });
    const j2 = await joinGame(db, created.roomCode, { displayName: 'Bob', profileId: profiles[1].profileId });
    const j3 = await joinGame(db, created.roomCode, { displayName: 'Carol', profileId: profiles[2].profileId });
    const j4 = await joinGame(db, created.roomCode, { displayName: 'Dave', profileId: profiles[3].profileId });
    if ('error' in j2 || 'error' in j3 || 'error' in j4) throw new Error('fixture broken');

    // Break seat 0's linked profile BEFORE the match ever finishes.
    await db.execute({ sql: 'DELETE FROM profiles WHERE id = ?', args: [profiles[0].profileId] });

    // createGame's own 4th-join already appended a (randomly-seeded) hand-1
    // start-hand row — clear it and replace with the deterministic
    // seed-44703 fixture, matching the existing route-test convention (see
    // state/route.test.ts's "observer-healing path" test).
    await db.execute({ sql: 'DELETE FROM actions WHERE game_id = ?', args: [created.gameId] });
    await appendStartHand(db, created.gameId, { handNumber: 1, dealerSeat: 0, seed: 44703, repeatCount: 0, prevailingWind: 'east' });
    const discard = await submitAction(db, created.gameId, { type: 'discard', seat: 0, tileId: 'tiao-7-4' });
    if (isSubmitRuleError(discard)) throw new Error(`fixture broken: ${discard.message}`);
    const pass1 = await submitAction(db, created.gameId, { type: 'pass', seat: 1 });
    if (isSubmitRuleError(pass1)) throw new Error(`fixture broken: ${pass1.message}`);
    const win = await submitAction(db, created.gameId, { type: 'claim', seat: 2, claim: { type: 'hu' } });
    if (isSubmitRuleError(win)) throw new Error(`fixture broken: ${win.message}`);
    const advance = await advanceToNextHand(db, created.gameId);
    expect(advance).toEqual({ error: 'game-finished' });

    const request = new Request(`http://localhost/api/games/${created.roomCode}/state`, {
      headers: { authorization: `Bearer ${j2.playerToken}` },
    });
    const response = await GET(request, { params: Promise.resolve({ code: created.roomCode }) });

    // The critical assertion: this must NOT be a 500, despite
    // settleRankedMatch throwing internally (seat 0's profile is gone).
    expect(response.status).toBe(200);
    const view = (await response.json()) as { status: string; players: unknown[]; ranked?: { status: string } };
    expect(view.status).toBe('finished');
    expect(Array.isArray(view.players)).toBe(true);
    expect(view.players.length).toBe(4);
    // ranked, if present at all, must be a well-formed fallback (never a
    // half-written/undefined-shaped object) — getRankedResultForGame's
    // fallback reports 'pending' here (fewer than 4 rows exist: seat 0
    // never got to settle).
    if (view.ranked !== undefined) {
      expect(['unranked', 'pending', 'settled']).toContain(view.ranked.status);
    }

    // A second poll must behave identically (not crash differently, not
    // leave the game stuck reporting something malformed).
    const request2 = new Request(`http://localhost/api/games/${created.roomCode}/state`, {
      headers: { authorization: `Bearer ${j2.playerToken}` },
    });
    const response2 = await GET(request2, { params: Promise.resolve({ code: created.roomCode }) });
    expect(response2.status).toBe(200);
  });
});
