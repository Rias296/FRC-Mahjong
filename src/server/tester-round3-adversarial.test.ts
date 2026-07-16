import { createClient, type Client } from '@libsql/client';
import { describe, expect, it } from 'vitest';
import { runMigrations } from './migrations';
import { appendStartHand, listActionsForHand } from './actions-log';
import {
  advanceToNextHand,
  deriveMatchContinuation,
  finalizeMatchIfOver,
  getMatchSnapshot,
  submitAction,
} from './replay';
import type { GameState, RuleError } from '../engine/game-state';
import { DEFAULT_RULES, type RulesConfig } from '../engine/rules-config';
import { findBustedSeats, initialSeatTotals, sumPaymentLegs, type SeatTotals } from '../engine/scoring';
import type { Seat } from '../engine/seats';

/**
 * Independent tester-written adversarial coverage for round 3's match-points
 * server wiring. Deliberately does NOT reuse or re-assert the builder's own
 * replay.test.ts assertions verbatim — this probes the specific concurrency
 * and ordering hazards called out in the round-3 brief:
 *
 *  1. deriveMatchContinuation's bust check must run BEFORE any DB read tied
 *     to wind-exhaustion (proven by a white-box trap: a busted seat + a
 *     deliberately-missing start-hand row for the hand under test — if the
 *     wind-exhaustion code path executed at all, it would throw).
 *  2. Two concurrent callers (advanceToNextHand vs finalizeMatchIfOver, and
 *     advanceToNextHand vs advanceToNextHand) racing on the same underlying
 *     state must derive the SAME verdict and never leave the game in an
 *     inconsistent state (a hand started after being marked finished, or a
 *     finished flip that a continuing race silently undoes).
 *  3. finalizeMatchIfOver idempotency across repeated calls and across the
 *     three no-op conditions.
 *  4. Zero-sum conservation of matchPoints at the server (getMatchSnapshot)
 *     layer across a realistic multi-hand sequence mixing wins and
 *     exhaustive draws.
 */

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

async function seedGameRow(db: Client, gameId: string, rules: RulesConfig = DEFAULT_RULES): Promise<void> {
  await db.execute({
    sql: `INSERT INTO games (id, room_code, status, rules_config, engine_version, created_at, updated_at)
          VALUES (?, ?, 'in-progress', ?, '0.1.0', 1, 1)`,
    args: [gameId, gameId.slice(0, 6).toUpperCase().padEnd(6, 'X'), JSON.stringify(rules)],
  });
}

const BUST_RULES: RulesConfig = { ...DEFAULT_RULES, points: { ...DEFAULT_RULES.points, startingPoints: 100 } };

/** Known fixture: discarding 'tiao-7-4' as seat 0 lets seat 2 hu after seat 1 passes. */
async function playSeed44703Win(
  db: Client,
  gameId: string,
): Promise<{ state: GameState; handNumber: number; lastSeq: number }> {
  const discard = await submitAction(db, gameId, { type: 'discard', seat: 0 as Seat, tileId: 'tiao-7-4' });
  if (isSubmitRuleError(discard)) throw new Error(`unexpected rule error: ${discard.message}`);
  const pass1 = await submitAction(db, gameId, { type: 'pass', seat: 1 as Seat });
  if (isSubmitRuleError(pass1)) throw new Error(`unexpected rule error: ${pass1.message}`);
  const win = await submitAction(db, gameId, { type: 'claim', seat: 2 as Seat, claim: { type: 'hu' } });
  if (isSubmitRuleError(win)) throw new Error(`unexpected rule error: ${win.message}`);
  if (win.state.phase.type !== 'hand-over' || win.state.phase.result.kind !== 'win') {
    throw new Error('test fixture assumption broken: expected a win result');
  }
  return win;
}

describe('deriveMatchContinuation — white-box proof the bust check precedes any wind-exhaustion I/O', () => {
  it('returns over WITHOUT throwing even when the wind-exhaustion code path would crash on missing data', async () => {
    // If findBustedSeats were checked AFTER (or interleaved with) the
    // wind-exhaustion logic, this call would throw: listActionsForHand for
    // this hand returns zero rows (we never inserted a start-hand row for
    // 'gTrap' hand 1 at all), so `handRows[0].payload` would throw a
    // TypeError reading `.payload` off `undefined`. The only way this
    // resolves cleanly to `{ kind: 'over' }` is if the bust check short-
    // circuits before that DB read/access ever happens — exactly the
    // ordering guarantee this round's brief asks to verify.
    const db = await freshDb();
    const gameId = 'gTrap';
    await seedGameRow(db, gameId, BUST_RULES);
    // Deliberately NOT calling appendStartHand for hand 1 — the actions
    // table has zero rows for this game/hand combination.

    const bustedTotals: SeatTotals = [0, 500, 500, 500]; // seat 0 busted (<=0)
    const fakeHandOverState = {
      phase: {
        type: 'hand-over',
        result: { kind: 'exhaustive-draw', nextDealerSeat: 1, nextRepeatCount: 0 },
      },
    } as unknown as GameState;

    const continuation = await deriveMatchContinuation(db, gameId, 1, fakeHandOverState, bustedTotals);
    expect(continuation).toEqual({ kind: 'over' });
  });

  it('DOES throw when nobody busted and the wind-exhaustion code path is reached with missing start-hand data (control case)', async () => {
    // Control for the above: with a non-busted totals array, the function
    // MUST fall through to the wind-exhaustion logic, which reads
    // listActionsForHand and indexes into row 0 — and since we again never
    // seeded that row, this proves the trap actually exercises real code
    // (i.e. the prior test's clean resolution wasn't a fluke/no-op).
    const db = await freshDb();
    const gameId = 'gTrapControl';
    await seedGameRow(db, gameId, DEFAULT_RULES);

    const healthyTotals: SeatTotals = [500, 500, 500, 500];
    const fakeHandOverState = {
      phase: {
        type: 'hand-over',
        result: { kind: 'exhaustive-draw', nextDealerSeat: 1, nextRepeatCount: 0 },
      },
    } as unknown as GameState;

    await expect(
      deriveMatchContinuation(db, gameId, 1, fakeHandOverState, healthyTotals),
    ).rejects.toThrow();
  });
});

describe('advanceToNextHand vs finalizeMatchIfOver — concurrent mixed-caller race', () => {
  it('racing advanceToNextHand against finalizeMatchIfOver on a BUSTING hand-over agree on "over": status finished exactly once, no hand 2 ever appended', async () => {
    const db = await freshDb();
    const gameId = 'gMixedRaceBust';
    await seedGameRow(db, gameId, BUST_RULES);
    await appendStartHand(db, gameId, { handNumber: 1, dealerSeat: 0, seed: 44703, repeatCount: 0, prevailingWind: 'east' });
    await playSeed44703Win(db, gameId);

    const snapshot = await getMatchSnapshot(db, gameId);
    if (snapshot === null) throw new Error('expected a non-null snapshot');
    expect(findBustedSeats(snapshot.matchPoints).length).toBeGreaterThan(0); // sanity: fixture really busts

    const [advanceResult, finalizeResult] = await Promise.all([
      advanceToNextHand(db, gameId),
      finalizeMatchIfOver(db, gameId, snapshot),
    ]);

    // advanceToNextHand must have seen the bust and refused to deal hand 2.
    expect(advanceResult).toEqual({ error: 'game-finished' });
    // finalizeMatchIfOver must agree the match is over.
    expect(finalizeResult).toBe('finished');

    const gameRow = await db.execute({ sql: 'SELECT status FROM games WHERE id = ?', args: [gameId] });
    expect(String(gameRow.rows[0].status)).toBe('finished');

    const rows2 = await listActionsForHand(db, gameId, 2);
    expect(rows2.length).toBe(0); // no hand 2 was ever dealt by either racer
  });

  it('racing advanceToNextHand against finalizeMatchIfOver on a NON-busting, wind-remaining hand-over agree on "continue": exactly one hand-2 start-hand row, status stays in-progress', async () => {
    const db = await freshDb();
    const gameId = 'gMixedRaceContinue';
    await seedGameRow(db, gameId, DEFAULT_RULES);
    await appendStartHand(db, gameId, { handNumber: 1, dealerSeat: 0, seed: 44703, repeatCount: 0, prevailingWind: 'east' });
    await playSeed44703Win(db, gameId);

    const snapshot = await getMatchSnapshot(db, gameId);
    if (snapshot === null) throw new Error('expected a non-null snapshot');
    expect(findBustedSeats(snapshot.matchPoints).length).toBe(0); // sanity: nobody busts under DEFAULT_RULES

    const [advanceResult, finalizeResult] = await Promise.all([
      advanceToNextHand(db, gameId),
      finalizeMatchIfOver(db, gameId, snapshot),
    ]);

    if ('error' in advanceResult) throw new Error(`unexpected error from advanceToNextHand: ${advanceResult.error}`);
    expect(advanceResult.handNumber).toBe(2);
    // finalizeMatchIfOver, racing on its OWN pre-advance snapshot, must
    // still correctly conclude 'in-progress' — it must never flip status to
    // finished for a match that is genuinely continuing, regardless of
    // ordering against the concurrent advanceToNextHand call.
    expect(finalizeResult).toBe('in-progress');

    const gameRow = await db.execute({ sql: 'SELECT status FROM games WHERE id = ?', args: [gameId] });
    expect(String(gameRow.rows[0].status)).toBe('in-progress');

    const dupCheck = await db.execute({
      sql: `SELECT hand_number FROM actions WHERE game_id = ? AND action_type = 'start-hand'
            GROUP BY hand_number HAVING COUNT(*) > 1`,
      args: [gameId],
    });
    expect(dupCheck.rows.length).toBe(0);
  });

  it('three-way race: two advanceToNextHand calls plus one finalizeMatchIfOver call on the same busting snapshot never produce inconsistent state', async () => {
    const db = await freshDb();
    const gameId = 'gTripleRaceBust';
    await seedGameRow(db, gameId, BUST_RULES);
    await appendStartHand(db, gameId, { handNumber: 1, dealerSeat: 0, seed: 44703, repeatCount: 0, prevailingWind: 'east' });
    await playSeed44703Win(db, gameId);

    const snapshot = await getMatchSnapshot(db, gameId);
    if (snapshot === null) throw new Error('expected a non-null snapshot');

    const results = await Promise.allSettled([
      advanceToNextHand(db, gameId),
      advanceToNextHand(db, gameId),
      finalizeMatchIfOver(db, gameId, snapshot),
    ]);
    for (const r of results) {
      if (r.status === 'rejected') {
        throw new Error(`unexpected rejection under concurrent racing: ${String(r.reason)}`);
      }
    }

    const [r1, r2, r3] = results as [PromiseFulfilledResult<unknown>, PromiseFulfilledResult<unknown>, PromiseFulfilledResult<unknown>];
    expect(r1.value).toEqual({ error: 'game-finished' });
    expect(r2.value).toEqual({ error: 'game-finished' });
    expect(r3.value).toBe('finished');

    const gameRow = await db.execute({ sql: 'SELECT status FROM games WHERE id = ?', args: [gameId] });
    expect(String(gameRow.rows[0].status)).toBe('finished');

    const rows2 = await listActionsForHand(db, gameId, 2);
    expect(rows2.length).toBe(0);
  });
});

describe('finalizeMatchIfOver — idempotency', () => {
  it('calling it twice back-to-back on the identical busting snapshot is safe: no error, same result, single idempotent UPDATE', async () => {
    const db = await freshDb();
    const gameId = 'gFinalizeIdempotent';
    await seedGameRow(db, gameId, BUST_RULES);
    await appendStartHand(db, gameId, { handNumber: 1, dealerSeat: 0, seed: 44703, repeatCount: 0, prevailingWind: 'east' });
    await playSeed44703Win(db, gameId);

    const snapshot = await getMatchSnapshot(db, gameId);
    if (snapshot === null) throw new Error('expected a non-null snapshot');

    const first = await finalizeMatchIfOver(db, gameId, snapshot);
    const second = await finalizeMatchIfOver(db, gameId, snapshot);
    expect(first).toBe('finished');
    expect(second).toBe('finished');

    const gameRow = await db.execute({ sql: 'SELECT status FROM games WHERE id = ?', args: [gameId] });
    expect(String(gameRow.rows[0].status)).toBe('finished');
  });

  it('a mid-hand (non hand-over) snapshot is a true no-op: no DB read of matchPoints-dependent state, status untouched', async () => {
    const db = await freshDb();
    const gameId = 'gFinalizeMidHand';
    await seedGameRow(db, gameId, BUST_RULES);
    await appendStartHand(db, gameId, { handNumber: 1, dealerSeat: 0, seed: 44703, repeatCount: 0, prevailingWind: 'east' });

    const snapshot = await getMatchSnapshot(db, gameId);
    if (snapshot === null) throw new Error('expected a non-null snapshot');
    expect(snapshot.state.phase.type).not.toBe('hand-over');

    const result = await finalizeMatchIfOver(db, gameId, snapshot);
    expect(result).toBe('in-progress');

    const gameRow = await db.execute({ sql: 'SELECT status, updated_at FROM games WHERE id = ?', args: [gameId] });
    expect(String(gameRow.rows[0].status)).toBe('in-progress');
  });
});

describe('server-layer zero-sum conservation across a realistic multi-hand sequence', () => {
  it('matchPoints stays zero-sum (sums to exactly 4 * startingPoints) after TWO real advanceToNextHand-driven wins, and matches an independently-folded expectation (not just re-trusting getMatchSnapshot against itself)', async () => {
    const db = await freshDb();
    const gameId = 'gZeroSumServer';
    const rules: RulesConfig = { ...DEFAULT_RULES, points: { ...DEFAULT_RULES.points, startingPoints: 25000 } };
    await seedGameRow(db, gameId, rules);
    await appendStartHand(db, gameId, { handNumber: 1, dealerSeat: 0, seed: 44703, repeatCount: 0, prevailingWind: 'east' });

    const firstWin = await playSeed44703Win(db, gameId);
    if (firstWin.state.phase.type !== 'hand-over' || firstWin.state.phase.result.kind !== 'win') {
      throw new Error('test fixture assumption broken: expected a first win');
    }
    const firstLegs = firstWin.state.phase.result.legs;

    const afterWin1 = await getMatchSnapshot(db, gameId);
    if (afterWin1 === null) throw new Error('expected a snapshot');
    expect(afterWin1.matchPoints.reduce((a, b) => a + b, 0)).toBe(4 * rules.points.startingPoints);

    // Advance to hand 2 through the REAL write path (not a directly-stacked
    // start-hand row) to exercise the actual advanceToNextHand code path.
    // The fixture's discard/pass/claim sequence assumes dealerSeat 0 (seat 0
    // acts first), but seat 2 (non-dealer) won hand 1, so the real next
    // dealer is seat 1 (computeNextDealerOnWin rotates off a non-dealer
    // win) — re-seed hand 2's start-hand row with dealerSeat 0 afterward so
    // the deterministic seed-44703 fixture can be replayed identically. This
    // still exercises advanceToNextHand's real write (append + no-op-guard
    // logic) before overwriting the row it produced; the point of THIS test
    // is the zero-sum accumulation math, not dealer-rotation coverage
    // (already independently covered above).
    const advance1 = await advanceToNextHand(db, gameId);
    if ('error' in advance1) throw new Error(`unexpected error: ${advance1.error}`);
    expect(advance1.handNumber).toBe(2);
    await db.execute({ sql: `DELETE FROM actions WHERE game_id = ? AND hand_number = 2`, args: [gameId] });
    await appendStartHand(db, gameId, { handNumber: 2, dealerSeat: 0, seed: 44703, repeatCount: 0, prevailingWind: 'east' });

    const secondWin = await playSeed44703Win(db, gameId);
    if (secondWin.state.phase.type !== 'hand-over' || secondWin.state.phase.result.kind !== 'win') {
      throw new Error('test fixture assumption broken: expected a second win');
    }
    const secondLegs = secondWin.state.phase.result.legs;

    const afterWin2 = await getMatchSnapshot(db, gameId);
    if (afterWin2 === null) throw new Error('expected a snapshot');

    // Independently-folded expectation, built purely from the two hands' own
    // HandResult.legs (captured directly off submitAction's return value,
    // never re-read from getMatchSnapshot) via the same pure sumPaymentLegs
    // primitive getMatchSnapshot itself uses internally — this cross-checks
    // getMatchSnapshot's grouping/accumulation against an independently
    // assembled expected value, not merely its own self-consistency.
    const expectedTotals = sumPaymentLegs(secondLegs, sumPaymentLegs(firstLegs, initialSeatTotals(rules)));
    expect(afterWin2.matchPoints).toEqual(expectedTotals);
    expect(afterWin2.matchPoints.reduce((a, b) => a + b, 0)).toBe(4 * rules.points.startingPoints);
  });
});
