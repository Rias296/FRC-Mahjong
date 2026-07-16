import { createClient, type Client } from '@libsql/client';
import { describe, expect, it } from 'vitest';
import { runMigrations } from './migrations';
import { appendStartHand } from './actions-log';
import { advanceToNextHand, getCurrentHandState, getMatchSnapshot, submitAction } from './replay';
import type { GameState, RuleError } from '../engine/game-state';
import { DEFAULT_RULES, type RulesConfig } from '../engine/rules-config';
import { initialSeatTotals, sumPaymentLegs } from '../engine/scoring';
import type { Seat } from '../engine/seats';

/**
 * Tester-added adversarial coverage for getMatchSnapshot: does it correctly
 * ACCUMULATE across multiple completed won hands (not just one), keep each
 * hand's fold isolated (no leaking engine state across hand_number groups),
 * and — for a mid-hand read — reflect ONLY previously completed hands, never
 * a partial/in-progress one?
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

/**
 * Runs the well-established seed-44703/dealer-0 fixture (see
 * auto-pass-mixed.test.ts / replay.test.ts): discarding 'tiao-7-4' leaves
 * seat 2 with a real hu option after seat 1 passes its pung option. Returns
 * the resulting win state.
 */
async function playWinningHand(
  db: Client,
  gameId: string,
  handNumber: number,
): Promise<Extract<GameState['phase'], { type: 'hand-over' }>> {
  await appendStartHand(db, gameId, {
    handNumber,
    dealerSeat: 0,
    seed: 44703,
    repeatCount: 0,
    prevailingWind: 'east',
  });
  const discard = await submitAction(db, gameId, { type: 'discard', seat: 0 as Seat, tileId: 'tiao-7-4' });
  if (isSubmitRuleError(discard)) throw new Error(`unexpected rule error: ${discard.message}`);
  const pass1 = await submitAction(db, gameId, { type: 'pass', seat: 1 as Seat });
  if (isSubmitRuleError(pass1)) throw new Error(`unexpected rule error: ${pass1.message}`);
  const win = await submitAction(db, gameId, { type: 'claim', seat: 2 as Seat, claim: { type: 'hu' } });
  if (isSubmitRuleError(win)) throw new Error(`unexpected rule error: ${win.message}`);
  if (win.state.phase.type !== 'hand-over') {
    throw new Error('test fixture assumption broken: expected hand-over');
  }
  return win.state.phase as Extract<GameState['phase'], { type: 'hand-over' }>;
}

describe('getMatchSnapshot — adversarial multi-hand accumulation', () => {
  it('accumulates matchPoints across TWO completed won hands (not just one)', async () => {
    const db = await freshDb();
    const gameId = 'gMatchTwoWins';
    await seedGameRow(db, gameId);

    const hand1Phase = await playWinningHand(db, gameId, 1);
    if (hand1Phase.result.kind !== 'win') throw new Error('expected a win result for hand 1');
    const hand1Legs = hand1Phase.result.legs;

    // Directly stack hand 2's start-hand row on top (bypassing
    // advanceToNextHand's derived next-dealer/wind logic, which isn't what
    // this test is probing) reusing the SAME seed/dealer fixture, so hand 2
    // replays to an identical win. This isolates getMatchSnapshot's own
    // grouping/accumulation logic from advanceToNextHand's dealer-rotation
    // logic (already covered elsewhere).
    const hand2Phase = await playWinningHand(db, gameId, 2);
    if (hand2Phase.result.kind !== 'win') throw new Error('expected a win result for hand 2');
    const hand2Legs = hand2Phase.result.legs;

    const startingTotals = initialSeatTotals(DEFAULT_RULES);
    const expected = sumPaymentLegs(hand2Legs, sumPaymentLegs(hand1Legs, startingTotals));

    const snapshot = await getMatchSnapshot(db, gameId);
    if (snapshot === null) throw new Error('expected a non-null snapshot');
    expect(snapshot.matchPoints).toEqual(expected);
    // Since both hands used identical legs, the NET CHANGE from starting
    // totals must be exactly double a single hand's own net change (a real
    // accumulation across two hands, not an accidental overwrite that would
    // just equal one hand's delta applied once).
    const oneHandDelta = sumPaymentLegs(hand1Legs, startingTotals).map((n, i) => n - startingTotals[i]);
    const actualDelta = snapshot.matchPoints.map((n, i) => n - startingTotals[i]);
    expect(actualDelta).toEqual(oneHandDelta.map((n) => n * 2));
    expect(snapshot.handNumber).toBe(2);
  });

  it("does not leak hand 1's engine state into hand 2's fold (fresh wall/hand per hand_number group)", async () => {
    const db = await freshDb();
    const gameId = 'gMatchNoLeak';
    await seedGameRow(db, gameId);

    await playWinningHand(db, gameId, 1);
    await appendStartHand(db, gameId, {
      handNumber: 2,
      dealerSeat: 0,
      seed: 44703,
      repeatCount: 0,
      prevailingWind: 'east',
    });

    const snapshot = await getMatchSnapshot(db, gameId);
    if (snapshot === null) throw new Error('expected a non-null snapshot');
    expect(snapshot.handNumber).toBe(2);
    // Hand 2 has had exactly ONE action (its own start-hand row) applied —
    // if hand 1's rows had leaked into this fold, seat 0 would already show
    // hand 1's discard/meld history instead of a freshly dealt 17-tile hand.
    expect(snapshot.state.players[0].discards.length).toBe(0);
    expect(snapshot.state.players[0].hand.melds.length).toBe(0);
    expect(snapshot.state.phase.type).toBe('awaiting-discard');
  });

  it('a mid-hand-2 read reflects ONLY hand 1s completed total, not a partial/zeroed hand 2', async () => {
    const db = await freshDb();
    const gameId = 'gMatchMidHand';
    await seedGameRow(db, gameId);

    const hand1Phase = await playWinningHand(db, gameId, 1);
    if (hand1Phase.result.kind !== 'win') throw new Error('expected a win result for hand 1');
    const expectedFromHand1 = sumPaymentLegs(hand1Phase.result.legs, initialSeatTotals(DEFAULT_RULES));

    // Start hand 2 but leave it mid-hand (just the start-hand row, no
    // discard/claim yet) — a real in-progress, not-yet-hand-over hand.
    await appendStartHand(db, gameId, {
      handNumber: 2,
      dealerSeat: 0,
      seed: 44703,
      repeatCount: 0,
      prevailingWind: 'east',
    });

    const snapshot = await getMatchSnapshot(db, gameId);
    const current = await getCurrentHandState(db, gameId);
    if (snapshot === null || current === null) throw new Error('expected both to be non-null');

    // matchPoints must reflect ONLY hand 1 (the one completed hand) — hand 2
    // is mid-hand (awaiting-discard, no result yet) and must contribute zero.
    expect(snapshot.matchPoints).toEqual(expectedFromHand1);
    expect(snapshot.handNumber).toBe(2);
    expect(snapshot.state).toEqual(current.state);
    expect(snapshot.lastSeq).toBe(current.lastSeq);

    // Advance hand 2 partway (a real discard) and confirm matchPoints is
    // STILL exactly hand 1's total — an in-progress hand must never
    // contribute partial credit no matter how far along it is.
    const discard = await submitAction(db, gameId, { type: 'discard', seat: 0 as Seat, tileId: 'tiao-7-4' });
    if (isSubmitRuleError(discard)) throw new Error(`unexpected rule error: ${discard.message}`);
    const snapshotAfterDiscard = await getMatchSnapshot(db, gameId);
    if (snapshotAfterDiscard === null) throw new Error('expected a non-null snapshot');
    expect(snapshotAfterDiscard.matchPoints).toEqual(expectedFromHand1);
  });

  it('accumulates correctly across a real advanceToNextHand-driven multi-hand match (win, then exhaustive draw, then win)', async () => {
    const db = await freshDb();
    const gameId = 'gMatchRealFlow';
    // High reserve so a hand with no real winning opportunity instantly
    // exhausts (same technique as replay.test.ts's HIGH_RESERVE_RULES).
    const rules: RulesConfig = { ...DEFAULT_RULES, deadWallReserve: 140 };
    await seedGameRow(db, gameId, rules);

    await appendStartHand(db, gameId, { handNumber: 1, dealerSeat: 0, seed: 5, repeatCount: 0, prevailingWind: 'east' });
    const draw1 = await advanceToNextHand(db, gameId);
    if ('error' in draw1) throw new Error(`unexpected error: ${draw1.error}`);

    const snapshotAfterDraw = await getMatchSnapshot(db, gameId);
    if (snapshotAfterDraw === null) throw new Error('expected a non-null snapshot');
    expect(snapshotAfterDraw.matchPoints).toEqual(initialSeatTotals(rules));
    expect(snapshotAfterDraw.handNumber).toBe(2);
  });
});
