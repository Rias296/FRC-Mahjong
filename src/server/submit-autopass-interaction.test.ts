/**
 * Independent tester verification pass (2nd round), item 3 of the review
 * brief: the interaction between TWO DIFFERENT real submitAction calls
 * landing genuinely concurrently in the same claim window, each of which
 * independently triggers its OWN internal applyAutoPass call for a real
 * zero-option seat. This is the exact end-to-end scenario the submitAction/
 * applyAutoPass fixes were designed for, but it was not directly exercised
 * end-to-end by the round-1 concurrency-stress.test.ts (which tests
 * applyAutoPass concurrency in isolation via direct calls, and submitAction
 * concurrency only for two IDENTICAL same-seat submissions).
 *
 * Fixture: seed 44703, dealer 0, discard tiao-7-4 (same fixture as
 * auto-pass-mixed.test.ts): seat 2 has a real hu option, seat 1 has a real
 * pung option (no hu), seat 3 has zero options. hu beats pung under the
 * engine's own claim-priority rules (resolveClaims), so regardless of
 * arrival order, seat 2's hu must win once all three non-discarder seats
 * have responded.
 */
import { createClient, type Client } from '@libsql/client';
import { describe, expect, it } from 'vitest';
import { runMigrations } from './migrations';
import { appendStartHand, listActionsForHand } from './actions-log';
import { getCurrentHandState, submitAction } from './replay';
import { DEFAULT_RULES } from '../engine/rules-config';
import type { GameState, RuleError } from '../engine/game-state';

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

async function seedGameRow(db: Client, gameId: string): Promise<void> {
  await db.execute({
    sql: `INSERT INTO games (id, room_code, status, rules_config, engine_version, created_at, updated_at)
          VALUES (?, ?, 'in-progress', ?, '0.1.0', 1, 1)`,
    args: [gameId, gameId.slice(0, 6).toUpperCase().padEnd(6, 'X'), JSON.stringify(DEFAULT_RULES)],
  });
}

async function openMixedClaimWindow(gameId: string): Promise<Client> {
  const db = await freshDb();
  await seedGameRow(db, gameId);
  await appendStartHand(db, gameId, {
    handNumber: 1,
    dealerSeat: 0,
    seed: 44703,
    repeatCount: 0,
    prevailingWind: 'east',
  });
  const discardResult = await submitAction(db, gameId, { type: 'discard', seat: 0, tileId: 'tiao-7-4' });
  if (isSubmitRuleError(discardResult)) {
    throw new Error(`test fixture assumption broken: ${discardResult.message}`);
  }
  if (discardResult.state.phase.type !== 'awaiting-claims') {
    throw new Error('test fixture assumption broken: expected awaiting-claims to remain open');
  }
  // submitAction's own internal applyAutoPass already ran here, so seat 3
  // should already be auto-passed at this point. Confirm the fixture shape.
  if (discardResult.state.phase.responses[3] !== 'pass') {
    throw new Error('test fixture assumption broken: expected seat 3 already auto-passed after the discard');
  }
  return db;
}

describe('submitAction + applyAutoPass interaction under genuine concurrency (round-2 independent verification, item 3)', () => {
  it(
    'two DIFFERENT real concurrent submitAction calls (seat1 pung, seat2 hu) in the same window both land, ' +
      'seat3 is auto-passed exactly once, and hu correctly wins over pung per resolveClaims priority',
    async () => {
      for (let run = 0; run < 5; run++) {
        const gameId = `interact-${run}`;
        const db = await openMixedClaimWindow(gameId);

        const [pungResult, huResult] = await Promise.all([
          submitAction(db, gameId, { type: 'claim', seat: 1, claim: { type: 'pung' } }),
          submitAction(db, gameId, { type: 'claim', seat: 2, claim: { type: 'hu' } }),
        ]);

        if (isSubmitRuleError(pungResult)) {
          throw new Error(`run ${run}: seat1 pung unexpectedly rejected: ${pungResult.message}`);
        }
        if (isSubmitRuleError(huResult)) {
          throw new Error(`run ${run}: seat2 hu unexpectedly rejected: ${huResult.message}`);
        }

        // Both concurrent submitAction calls must succeed (each is a
        // legitimate, distinct-seat action against an open claim window;
        // neither should be starved or incorrectly rejected by the other's
        // race, and neither should silently no-op).
        // The window must have resolved once all 3 non-discarder seats
        // (1 pung, 2 hu, 3 auto-passed) have responded: exactly one
        // 'pass' row for seat 3 (never duplicated by racing applyAutoPass
        // calls triggered independently by each submitAction call).
        const rows = await listActionsForHand(db, gameId, 1);
        const seat3PassRows = rows.filter((r) => r.actorSeat === 3 && r.actionType === 'pass');
        expect(seat3PassRows.length).toBe(1);

        const seat1PungRows = rows.filter((r) => r.actorSeat === 1 && r.actionType === 'claim');
        expect(seat1PungRows.length).toBe(1);
        const seat2HuRows = rows.filter((r) => r.actorSeat === 2 && r.actionType === 'claim');
        expect(seat2HuRows.length).toBe(1);

        // The final replayed state must be fully consistent (never throws)
        // and must reflect the engine's OWN claim-priority resolution: hu
        // beats pung, so the hand must resolve to a hu win for seat 2, NOT
        // a pung resolution for seat 1 — regardless of which of the two
        // concurrent submitAction calls happened to be the one whose append
        // pushed the window to 3/3 responses.
        const finalState = await getCurrentHandState(db, gameId);
        if (finalState === null) throw new Error(`run ${run}: expected an active/finished hand`);
        expect(finalState.state.phase.type).toBe('hand-over');
        if (finalState.state.phase.type !== 'hand-over') throw new Error('unreachable');
        if (finalState.state.phase.result.kind !== 'win') {
          throw new Error(`run ${run}: expected a win result, got ${finalState.state.phase.result.kind}`);
        }
        expect(finalState.state.phase.result.winners.map((w) => w.seat)).toEqual([2]);
        expect(finalState.state.phase.result.winners[0].winType).toBe('discard');

        // Each concurrent caller's OWN returned state reflects whatever was
        // true at the exact moment ITS append landed — since submitAction
        // does not re-read after appending, the caller whose action landed
        // FIRST (when only 2 of 3 responses existed) legitimately gets back
        // an still-open 'awaiting-claims' snapshot, while the caller whose
        // action landed SECOND (pushing the response count to 3/3) gets
        // back the fully-resolved 'hand-over' state directly, since
        // resolveClaimWindow fires synchronously inside applyAction once the
        // 3rd response is validated. Neither is a bug; both are checked here
        // for internal consistency (never a corrupt/impossible phase), and
        // at least one of the two must directly reflect the resolution instead
        // of merely being possible to discover as the "same" object later.
        for (const r of [pungResult.state, huResult.state]) {
          if (r.phase.type === 'awaiting-claims') {
            // Legitimately observed before the window closed: must still
            // show seat 3 already auto-passed and never a bogus response.
            expect(r.phase.responses[3]).toBe('pass');
          } else if (r.phase.type === 'hand-over') {
            if (r.phase.result.kind !== 'win') throw new Error(`run ${run}: expected win kind`);
            expect(r.phase.result.winners.map((w) => w.seat)).toEqual([2]);
          } else {
            throw new Error(`run ${run}: unexpected phase ${r.phase.type} in a concurrent submitAction return value`);
          }
        }
        const atLeastOneSawResolution = [pungResult.state, huResult.state].some((s) => s.phase.type === 'hand-over');
        expect(atLeastOneSawResolution).toBe(true);
      }
    },
  );

  it(
    'reversed submission order (hu first argument, pung second) produces an identical outcome — ' +
      'resolution is order-independent, driven by resolveClaims priority not arrival order',
    async () => {
      const gameId = 'interact-reversed';
      const db = await openMixedClaimWindow(gameId);

      const [huResult, pungResult] = await Promise.all([
        submitAction(db, gameId, { type: 'claim', seat: 2, claim: { type: 'hu' } }),
        submitAction(db, gameId, { type: 'claim', seat: 1, claim: { type: 'pung' } }),
      ]);

      if (isSubmitRuleError(huResult)) throw new Error(`seat2 hu unexpectedly rejected: ${huResult.message}`);
      if (isSubmitRuleError(pungResult)) throw new Error(`seat1 pung unexpectedly rejected: ${pungResult.message}`);

      const finalState = await getCurrentHandState(db, gameId);
      if (finalState === null) throw new Error('expected an active/finished hand');
      expect(finalState.state.phase.type).toBe('hand-over');
      if (finalState.state.phase.type !== 'hand-over' || finalState.state.phase.result.kind !== 'win') {
        throw new Error('expected a win result');
      }
      expect(finalState.state.phase.result.winners.map((w) => w.seat)).toEqual([2]);

      const rows = await listActionsForHand(db, gameId, 1);
      const seat3PassRows = rows.filter((r) => r.actorSeat === 3 && r.actionType === 'pass');
      expect(seat3PassRows.length).toBe(1);
    },
  );

  it('a genuinely reconnecting/retrying client re-submitting the SAME claim after a concurrent winner already resolved the window gets a legitimate RuleError, never a silent duplicate resolution', async () => {
    const gameId = 'interact-reconnect';
    const db = await openMixedClaimWindow(gameId);

    const first = await submitAction(db, gameId, { type: 'claim', seat: 1, claim: { type: 'pung' } });
    if (isSubmitRuleError(first)) throw new Error(`unexpected rule error: ${first.message}`);
    const second = await submitAction(db, gameId, { type: 'claim', seat: 2, claim: { type: 'hu' } });
    if (isSubmitRuleError(second)) throw new Error(`unexpected rule error: ${second.message}`);

    // Window is now resolved (hu win for seat 2). A reconnecting seat-1
    // client that missed the resolution and retries its pung submission
    // must get a legitimate RuleError (wrong-phase, since it's hand-over
    // now), never a silent success or a corrupted duplicate append.
    const retry = await submitAction(db, gameId, { type: 'claim', seat: 1, claim: { type: 'pung' } });
    expect(isSubmitRuleError(retry)).toBe(true);

    await expect(getCurrentHandState(db, gameId)).resolves.not.toThrow();
  });
});
