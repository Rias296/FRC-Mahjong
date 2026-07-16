import { createClient, type Client } from '@libsql/client';
import { describe, expect, it } from 'vitest';
import { runMigrations } from './migrations';
import { appendStartHand } from './actions-log';
import { advanceToNextHand, getMatchSnapshot, submitAction } from './replay';
import { createProfile, getRankedResultForGame, resolveProfileToken, settleRankedMatch } from './ranked';
import { DEFAULT_RULES, type RulesConfig } from '../engine/rules-config';
import { computeStandings } from '../engine/scoring';
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

/** A guaranteed-unique 6-char room code per call — gameId-derived prefixes can collide (e.g. 'gShareA'/'gShareB' both slice to 'GSHARE'). */
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

// A startingPoints low enough that a single ordinary payment leg busts the
// payer — same technique as replay.test.ts's BUST_RULES.
const BUST_RULES: RulesConfig = { ...DEFAULT_RULES, points: { ...DEFAULT_RULES.points, startingPoints: 100 } };

// deadWallReserve high enough that startHand ends immediately in an
// exhaustive draw — same technique as replay.test.ts's HIGH_RESERVE_RULES.
const HIGH_RESERVE_RULES: RulesConfig = { ...DEFAULT_RULES, deadWallReserve: 140 };

/** Plays the seed-44703/dealer-0 fixture to a real win: seat 2 beats seat 0's discard. */
async function playSeed44703Win(db: Client, gameId: string): Promise<void> {
  const discard = await submitAction(db, gameId, { type: 'discard', seat: 0, tileId: 'tiao-7-4' });
  if (isSubmitRuleError(discard)) throw new Error(`test fixture broken: ${discard.message}`);
  const pass1 = await submitAction(db, gameId, { type: 'pass', seat: 1 });
  if (isSubmitRuleError(pass1)) throw new Error(`test fixture broken: ${pass1.message}`);
  const win = await submitAction(db, gameId, { type: 'claim', seat: 2, claim: { type: 'hu' } });
  if (isSubmitRuleError(win)) throw new Error(`test fixture broken: ${win.message}`);
}

/**
 * Builds a finished, fully-4-seat-profile-linked game via a real 1-hand bust
 * (seat 2 wins off seat 0's discard under BUST_RULES, driving seat 0
 * negative — deterministic, matching replay.test.ts's own bust fixture).
 * Standings: seat2=1st (winner), seat1=2nd, seat3=3rd (tied at
 * startingPoints, seat index tiebreak), seat0=4th (busted).
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

// --- createProfile / resolveProfileToken ------------------------------------------

describe('createProfile', () => {
  it('starts at 0 RP with a resolvable, unique secret token', async () => {
    const db = await freshDb();
    const a = await createProfile(db, 'Alice');
    const b = await createProfile(db, 'Bob');

    expect(a.profileId).not.toBe(b.profileId);
    expect(a.secretToken).not.toBe(b.secretToken);
    expect(a.secretToken.length).toBeGreaterThan(0);

    const row = await db.execute({ sql: 'SELECT rank_points FROM profiles WHERE id = ?', args: [a.profileId] });
    expect(Number(row.rows[0].rank_points)).toBe(0);

    const resolved = await resolveProfileToken(db, a.secretToken);
    expect(resolved).toEqual({ profileId: a.profileId, displayName: 'Alice' });
  });
});

describe('resolveProfileToken', () => {
  it('returns null for an unknown token rather than throwing', async () => {
    const db = await freshDb();
    await expect(resolveProfileToken(db, 'not-a-real-token')).resolves.toBeNull();
  });
});

// --- settleRankedMatch: non-finished / unlinked games -------------------------------

describe('settleRankedMatch on a non-finished or partially-linked game', () => {
  it('returns pending for a not-yet-finished, fully-linked game, without writing any rank_history rows', async () => {
    const db = await freshDb();
    const profileIds = await fourFreshProfiles(db);
    await seedGameRow(db, 'g1', DEFAULT_RULES, 'in-progress');
    for (const seat of [0, 1, 2, 3] as const) {
      await seedPlayerRow(db, 'g1', seat, profileIds[seat]);
    }

    const result = await settleRankedMatch(db, 'g1');
    expect(result).toEqual({ status: 'pending' });

    const rows = await db.execute({ sql: 'SELECT COUNT(*) AS n FROM rank_history WHERE game_id = ?', args: ['g1'] });
    expect(Number(rows.rows[0].n)).toBe(0);
  });

  it('returns unranked for a not-yet-finished game with an unlinked seat', async () => {
    const db = await freshDb();
    const profileIds = await fourFreshProfiles(db);
    await seedGameRow(db, 'g2', DEFAULT_RULES, 'in-progress');
    await seedPlayerRow(db, 'g2', 0, profileIds[0]);
    await seedPlayerRow(db, 'g2', 1, null);
    await seedPlayerRow(db, 'g2', 2, profileIds[2]);
    await seedPlayerRow(db, 'g2', 3, profileIds[3]);

    const result = await settleRankedMatch(db, 'g2');
    expect(result).toEqual({ status: 'unranked' });

    const rows = await db.execute({ sql: 'SELECT COUNT(*) AS n FROM rank_history WHERE game_id = ?', args: ['g2'] });
    expect(Number(rows.rows[0].n)).toBe(0);
  });

  it('returns unranked for a finished game with an unlinked seat, without writing any rank_history rows', async () => {
    const db = await freshDb();
    const profileIds = await fourFreshProfiles(db);
    await seedGameRow(db, 'g3', DEFAULT_RULES, 'finished');
    await seedPlayerRow(db, 'g3', 0, profileIds[0]);
    await seedPlayerRow(db, 'g3', 1, profileIds[1]);
    await seedPlayerRow(db, 'g3', 2, profileIds[2]);
    await seedPlayerRow(db, 'g3', 3, null);

    const result = await settleRankedMatch(db, 'g3');
    expect(result).toEqual({ status: 'unranked' });

    const rows = await db.execute({ sql: 'SELECT COUNT(*) AS n FROM rank_history WHERE game_id = ?', args: ['g3'] });
    expect(Number(rows.rows[0].n)).toBe(0);
  });
});

// --- settleRankedMatch: real settlement -----------------------------------------------

describe('settleRankedMatch on a finished, fully-linked game', () => {
  it('writes exactly 4 rank_history rows with placement/tier/delta matching an independently-computed settleRp expectation', async () => {
    const db = await freshDb();
    const profileIds = await fourFreshProfiles(db);
    await finishedBustGame(db, 'gSettle', profileIds);

    const result = await settleRankedMatch(db, 'gSettle');
    if (result.status !== 'settled') throw new Error(`expected settled, got ${result.status}`);
    expect(result.seats.length).toBe(4);

    const rows = await db.execute({ sql: 'SELECT * FROM rank_history WHERE game_id = ?', args: ['gSettle'] });
    expect(rows.rows.length).toBe(4);

    // Independently re-derive the expected standings/placements the same way
    // settleRankedMatch does internally (via the real engine APIs, not a
    // re-implementation) to build ground-truth expectations.
    const snapshot = await getMatchSnapshot(db, 'gSettle');
    if (snapshot === null) throw new Error('test fixture broken: no snapshot');
    const standings = computeStandings(snapshot.matchPoints);

    for (const standing of standings) {
      const expected = settleRp({ rpBefore: 0, apexAttainedBefore: false, place: standing.place });
      const row = rows.rows.find((r) => Number(r.seat) === standing.seat);
      if (row === undefined) throw new Error(`no rank_history row for seat ${standing.seat}`);

      expect(Number(row.placement)).toBe(standing.place);
      expect(Number(row.rp_before)).toBe(0);
      expect(Number(row.rp_delta)).toBe(expected.rpDelta);
      expect(Number(row.rp_after)).toBe(expected.rpAfter);
      expect(String(row.tier_after)).toBe(expected.tierAfter);

      const viewSeat = result.seats.find((s) => s.seat === standing.seat);
      if (viewSeat === undefined) throw new Error(`no view seat for ${standing.seat}`);
      expect(viewSeat.placement).toBe(standing.place);
      expect(viewSeat.rpDelta).toBe(expected.rpDelta);
      expect(viewSeat.promotedToApex).toBe(false);

      const profileRow = await db.execute({
        sql: 'SELECT rank_points FROM profiles WHERE id = ?',
        args: [profileIds[standing.seat]],
      });
      expect(Number(profileRow.rows[0].rank_points)).toBe(expected.rpAfter);
    }
  });

  it('called a second time on an already-settled game returns the identical result without writing new rows or double-applying RP', async () => {
    const db = await freshDb();
    const profileIds = await fourFreshProfiles(db);
    await finishedBustGame(db, 'gIdempotent', profileIds);

    const first = await settleRankedMatch(db, 'gIdempotent');
    const second = await settleRankedMatch(db, 'gIdempotent');
    expect(second).toEqual(first);

    const rows = await db.execute({ sql: 'SELECT COUNT(*) AS n FROM rank_history WHERE game_id = ?', args: ['gIdempotent'] });
    expect(Number(rows.rows[0].n)).toBe(4);

    // Cross-check via the read-only view function too.
    const viaGetResult = await getRankedResultForGame(db, 'gIdempotent');
    expect(viaGetResult).toEqual(first);
  });

  it('a bust-ended match and a wind-exhaustion-ended match with equivalent (tied) standings settle identically', async () => {
    const db = await freshDb();

    // Game A: bust-ended, a perfect 4-way tie at 0 points (findBustedSeats
    // flags every seat <= 0 simultaneously — a valid, if degenerate, bust).
    const bustRules: RulesConfig = { ...HIGH_RESERVE_RULES, points: { ...HIGH_RESERVE_RULES.points, startingPoints: 0 } };
    const profileIdsA = await fourFreshProfiles(db);
    await seedGameRow(db, 'gBustTie', bustRules);
    for (const seat of [0, 1, 2, 3] as const) {
      await seedPlayerRow(db, 'gBustTie', seat, profileIdsA[seat]);
    }
    await appendStartHand(db, 'gBustTie', { handNumber: 1, dealerSeat: 0, seed: 1, repeatCount: 0, prevailingWind: 'east' });
    const advanceA = await advanceToNextHand(db, 'gBustTie');
    expect(advanceA).toEqual({ error: 'game-finished' });

    // Game B: wind-exhaustion-ended, a perfect 4-way tie at a large positive
    // value (every hand is a HIGH_RESERVE exhaustive draw, contributing no
    // legs — matchPoints never changes from initialSeatTotals).
    const windRules: RulesConfig = {
      ...HIGH_RESERVE_RULES,
      dealerRepeatsOnDraw: false,
      points: { ...HIGH_RESERVE_RULES.points, startingPoints: 50000 },
    };
    const profileIdsB = await fourFreshProfiles(db);
    await seedGameRow(db, 'gWindTie', windRules);
    for (const seat of [0, 1, 2, 3] as const) {
      await seedPlayerRow(db, 'gWindTie', seat, profileIdsB[seat]);
    }
    for (let h = 1; h <= 15; h++) {
      const seqRow = await db.execute({
        sql: 'SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM actions WHERE game_id = ?',
        args: ['gWindTie'],
      });
      await db.execute({
        sql: `INSERT INTO actions (game_id, hand_number, seq, actor_seat, action_type, payload, created_at)
              VALUES (?, ?, ?, NULL, 'start-hand', ?, ?)`,
        args: [
          'gWindTie',
          h,
          Number(seqRow.rows[0].n),
          JSON.stringify({ handNumber: h, dealerSeat: (h - 1) % 4, seed: 1, repeatCount: 0, prevailingWind: 'east' }),
          Date.now(),
        ],
      });
    }
    await appendStartHand(db, 'gWindTie', { handNumber: 16, dealerSeat: 3, seed: 11, repeatCount: 0, prevailingWind: 'north' });
    const advanceB = await advanceToNextHand(db, 'gWindTie');
    expect(advanceB).toEqual({ error: 'game-finished' });

    const resultA = await settleRankedMatch(db, 'gBustTie');
    const resultB = await settleRankedMatch(db, 'gWindTie');
    if (resultA.status !== 'settled' || resultB.status !== 'settled') {
      throw new Error(`expected both settled, got ${resultA.status} / ${resultB.status}`);
    }

    // Same starting profile RP (0) + same tied standings (seat-index
    // tiebreak, identical regardless of the absolute point scale) => byte-
    // identical settlement outcomes, seat for seat.
    const sortBySeat = <T extends { seat: Seat }>(arr: readonly T[]) => [...arr].sort((a, b) => a.seat - b.seat);
    expect(sortBySeat(resultA.seats)).toEqual(sortBySeat(resultB.seats));
  });
});

// --- concurrency ---------------------------------------------------------------------

describe('settleRankedMatch concurrency', () => {
  it('N simultaneous calls for the SAME game apply RP exactly once', async () => {
    const db = await freshDb();
    const profileIds = await fourFreshProfiles(db);
    await finishedBustGame(db, 'gConcurrentSame', profileIds);

    const results = await Promise.all(Array.from({ length: 10 }, () => settleRankedMatch(db, 'gConcurrentSame')));
    for (const r of results) {
      expect(r).toEqual(results[0]);
    }

    const rows = await db.execute({
      sql: 'SELECT COUNT(*) AS n FROM rank_history WHERE game_id = ?',
      args: ['gConcurrentSame'],
    });
    expect(Number(rows.rows[0].n)).toBe(4);

    const snapshot = await getMatchSnapshot(db, 'gConcurrentSame');
    if (snapshot === null) throw new Error('test fixture broken');
    const standings = computeStandings(snapshot.matchPoints);
    for (const standing of standings) {
      const expected = settleRp({ rpBefore: 0, apexAttainedBefore: false, place: standing.place });
      const profileRow = await db.execute({
        sql: 'SELECT rank_points FROM profiles WHERE id = ?',
        args: [profileIds[standing.seat]],
      });
      // Exactly-once application: if RP had been double-applied under the
      // 10-way race, this would be expected.rpAfter's delta doubled, not
      // expected.rpAfter itself.
      expect(Number(profileRow.rows[0].rank_points)).toBe(expected.rpAfter);
    }
  });

  it('two different games sharing one linked profile, settled concurrently, produce a correct non-lost-update rp chain', async () => {
    const db = await freshDb();
    const shared = await createProfile(db, 'Shared');
    const othersA = await fourFreshProfiles(db);
    const othersB = await fourFreshProfiles(db);

    // Both games link the shared profile at seat 2 (the winning seat in the
    // fixture — guarantees a nonzero, known delta from each game).
    const profileIdsA: [string, string, string, string] = [othersA[0], othersA[1], shared.profileId, othersA[3]];
    const profileIdsB: [string, string, string, string] = [othersB[0], othersB[1], shared.profileId, othersB[3]];

    await finishedBustGame(db, 'gShareA', profileIdsA);
    await finishedBustGame(db, 'gShareB', profileIdsB);

    await Promise.all([settleRankedMatch(db, 'gShareA'), settleRankedMatch(db, 'gShareB')]);

    const rowsA = await db.execute({
      sql: 'SELECT rp_before, rp_delta, rp_after FROM rank_history WHERE game_id = ? AND profile_id = ?',
      args: ['gShareA', shared.profileId],
    });
    const rowsB = await db.execute({
      sql: 'SELECT rp_before, rp_delta, rp_after FROM rank_history WHERE game_id = ? AND profile_id = ?',
      args: ['gShareB', shared.profileId],
    });
    expect(rowsA.rows.length).toBe(1);
    expect(rowsB.rows.length).toBe(1);

    const a = { before: Number(rowsA.rows[0].rp_before), delta: Number(rowsA.rows[0].rp_delta), after: Number(rowsA.rows[0].rp_after) };
    const b = { before: Number(rowsB.rows[0].rp_before), delta: Number(rowsB.rows[0].rp_delta), after: Number(rowsB.rows[0].rp_after) };

    // Each row is internally consistent.
    expect(a.after).toBe(a.before + a.delta);
    expect(b.after).toBe(b.before + b.delta);

    // No lost update: the two rows chain together in SOME order (whichever
    // settled first read rpBefore=0; the other read the first's rpAfter).
    const chains =
      (a.before === 0 && b.before === a.after) || (b.before === 0 && a.before === b.after);
    expect(chains).toBe(true);

    const finalProfile = await db.execute({ sql: 'SELECT rank_points FROM profiles WHERE id = ?', args: [shared.profileId] });
    expect(Number(finalProfile.rows[0].rank_points)).toBe(a.delta + b.delta);
  });
});

// --- Apex promotion stamping -----------------------------------------------------------

describe('apex_attained_at stamping', () => {
  it('is stamped exactly once and never overwritten by a later settlement', async () => {
    const db = await freshDb();
    const profileIds = await fourFreshProfiles(db);
    // Seat 2 (the winner) is the profile under test; force its RP close
    // enough to Apex that a single 1st-place win crosses the threshold.
    await db.execute({
      sql: 'UPDATE profiles SET rank_points = ? WHERE id = ?',
      args: [APEX_THRESHOLD_RP - 50, profileIds[2]],
    });

    await finishedBustGame(db, 'gApexA', profileIds);
    const resultA = await settleRankedMatch(db, 'gApexA');
    if (resultA.status !== 'settled') throw new Error(`expected settled, got ${resultA.status}`);
    const seatA = resultA.seats.find((s) => s.seat === 2);
    if (seatA === undefined) throw new Error('no seat 2 in result');
    expect(seatA.promotedToApex).toBe(true);

    const profileAfterFirst = await db.execute({
      sql: 'SELECT rank_points, apex_attained_at FROM profiles WHERE id = ?',
      args: [profileIds[2]],
    });
    const stampedAt = profileAfterFirst.rows[0].apex_attained_at;
    expect(stampedAt).not.toBeNull();
    expect(Number(profileAfterFirst.rows[0].rank_points)).toBeGreaterThanOrEqual(APEX_THRESHOLD_RP);

    // A second, later match for the same (now-Apex) profile must not
    // overwrite the original stamp, even though RP changes again.
    const profileIdsB = await fourFreshProfiles(db);
    const profileIdsB2: [string, string, string, string] = [profileIdsB[0], profileIdsB[1], profileIds[2], profileIdsB[3]];
    await finishedBustGame(db, 'gApexB', profileIdsB2);
    const resultB = await settleRankedMatch(db, 'gApexB');
    if (resultB.status !== 'settled') throw new Error(`expected settled, got ${resultB.status}`);
    const seatB = resultB.seats.find((s) => s.seat === 2);
    if (seatB === undefined) throw new Error('no seat 2 in result');
    expect(seatB.promotedToApex).toBe(false); // already Apex before this match

    const profileAfterSecond = await db.execute({
      sql: 'SELECT apex_attained_at FROM profiles WHERE id = ?',
      args: [profileIds[2]],
    });
    expect(profileAfterSecond.rows[0].apex_attained_at).toBe(stampedAt);
  });
});
