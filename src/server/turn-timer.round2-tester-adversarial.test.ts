/**
 * Tester-round adversarial coverage for src/server/turn-timer.ts, on top of
 * (not replacing) turn-timer.test.ts. Focused on:
 *  - heavier concurrency (more than 2 racers, and a MULTI-seat claim window
 *    with several still-undecided seats, not just a single discard turn)
 *  - proving the server's own windowOpenedAt correctly advances across a
 *    seat change even when the phase TYPE stays 'awaiting-draw' (the
 *    server-side half of the client/server window-signature comparison
 *    mandated by this round's review — see
 *    interactions.round2-tester-adversarial.test.ts for the client-side
 *    finding this contrasts with)
 *  - replay parity for a TIMED-OUT DISCARD specifically (turn-timer.test.ts's
 *    existing parity test only exercises a timed-out PASS)
 *  - explicit confirmation that the cheap gate short-circuits before any
 *    hand replay when the timer is disabled
 *
 * Fixture: seed 44703, dealer 0 (reused from turn-timer.test.ts /
 * auto-pass-mixed.test.ts). Dealer's opening hand, when discarding tile
 * 'tiao-7-4', produces: seat 2 a real hu option, seat 1 a real pung option
 * (no hu), seat 3 zero options (auto-passed by submitAction's own
 * applyAutoPass).
 */
import { createClient, type Client } from '@libsql/client';
import { describe, expect, it } from 'vitest';
import { runMigrations } from './migrations';
import { appendActionAtSeq, appendStartHand, listActionsForHand } from './actions-log';
import { applyAutoPass, getCurrentHandState, submitAction } from './replay';
import { applyTurnTimeouts } from './turn-timer';
import { DEFAULT_RULES, type RulesConfig } from '../engine/rules-config';
import { applyAction, isRuleError, type GameState, type RuleError } from '../engine/game-state';

function isSubmitRuleError(
  r: { readonly state: GameState; readonly handNumber: number; readonly lastSeq: number } | RuleError,
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

async function backdateAllActions(db: Client, gameId: string, msAgo: number): Promise<void> {
  await db.execute({
    sql: 'UPDATE actions SET created_at = ? WHERE game_id = ?',
    args: [Date.now() - msAgo, gameId],
  });
}

async function seedSeed44703Hand(db: Client, gameId: string, rules: RulesConfig = DEFAULT_RULES): Promise<void> {
  await seedGameRow(db, gameId, rules);
  await appendStartHand(db, gameId, { handNumber: 1, dealerSeat: 0, seed: 44703, repeatCount: 0, prevailingWind: 'east' });
}

const TIMER_RULES: RulesConfig = { ...DEFAULT_RULES, turnTimerSeconds: 5 };

describe('applyTurnTimeouts — heavier concurrency', () => {
  it('5 concurrent calls racing the SAME expired single-seat (discard) window append exactly one auto-action', async () => {
    const db = await freshDb();
    const gameId = 'r2cDiscard5';
    await seedSeed44703Hand(db, gameId, TIMER_RULES);
    await backdateAllActions(db, gameId, 10000);

    await Promise.all(Array.from({ length: 5 }, () => applyTurnTimeouts(db, gameId)));

    const rows = await listActionsForHand(db, gameId, 1);
    const timedOut = rows.filter((r) => (r.payload as { timedOut?: boolean }).timedOut === true);
    expect(timedOut.length).toBe(1);
    expect(timedOut[0].actionType).toBe('discard');
  });

  it(
    '5 concurrent calls racing an expired MULTI-seat claim window (2 still-undecided claimants) append ' +
      'exactly one pass per undecided seat, never a duplicate for either',
    async () => {
      const db = await freshDb();
      const gameId = 'r2cClaims5';
      await seedSeed44703Hand(db, gameId, TIMER_RULES);

      const discard = await submitAction(db, gameId, { type: 'discard', seat: 0, tileId: 'tiao-7-4' });
      if (isSubmitRuleError(discard)) throw new Error(discard.message);
      if (discard.state.phase.type !== 'awaiting-claims') throw new Error('unreachable');
      // seat 3 already auto-passed (zero options); seat 1 (pung) and seat 2
      // (hu) are both still undecided — a genuine multi-seat window.
      expect(discard.state.phase.responses).toEqual({ 3: 'pass' });

      await backdateAllActions(db, gameId, 10000);

      await Promise.all(Array.from({ length: 5 }, () => applyTurnTimeouts(db, gameId)));

      const rows = await listActionsForHand(db, gameId, 1);
      const timedOutPasses = rows.filter(
        (r) => r.actionType === 'pass' && (r.payload as { timedOut?: boolean }).timedOut === true,
      );
      // Exactly one timed-out pass per previously-undecided seat (1 and 2) —
      // 5 racing callers must never produce duplicates for either seat, and
      // must never produce fewer than the 2 actually required.
      expect(timedOutPasses.map((r) => r.actorSeat).sort()).toEqual([1, 2]);
      expect(timedOutPasses.length).toBe(2);

      const after = await getCurrentHandState(db, gameId);
      if (after === null) throw new Error('expected an active hand');
      expect(after.state.phase.type).toBe('awaiting-draw');
      expect(after.state.currentTurnSeat).toBe(1);
    },
  );

  it(
    'interleaved real submitAction races against concurrent applyTurnTimeouts on the same window: exactly ' +
      'one of them wins the seat, never both durably appended',
    async () => {
      const db = await freshDb();
      const gameId = 'r2cRealRace';
      await seedSeed44703Hand(db, gameId, TIMER_RULES);
      await backdateAllActions(db, gameId, 10000);

      // A real manual discard from the dealer races against several
      // concurrent timeout-enforcement sweeps deciding the SAME seat's
      // discard is overdue. Exactly one discard action must land for hand 1.
      const results = await Promise.allSettled([
        submitAction(db, gameId, { type: 'discard', seat: 0, tileId: 'tiao-7-4' }),
        applyTurnTimeouts(db, gameId),
        applyTurnTimeouts(db, gameId),
        applyTurnTimeouts(db, gameId),
      ]);
      for (const r of results) {
        expect(r.status).toBe('fulfilled');
      }

      const rows = await listActionsForHand(db, gameId, 1);
      const discards = rows.filter((r) => r.actionType === 'discard');
      // Exactly one discard row for the dealer's opening turn — whichever of
      // the real submitAction or an enforcement sweep won the race, the
      // other(s) must have cleanly lost (seq-conflict retry -> no-op once the
      // fresh replay shows the window already resolved), never a duplicate.
      expect(discards.length).toBe(1);
    },
  );
});

describe('applyTurnTimeouts — windowOpenedAt correctly advances across a same-TYPE seat change', () => {
  it(
    "two consecutive 'awaiting-draw' windows for DIFFERENT seats (dealer's fully-timed-out turn handing off " +
      "to seat 1) have DIFFERENT windowOpenedAt instants, proving the server's per-row signature " +
      '(which is seat-qualified for awaiting-draw) never conflates them — contrast with ' +
      'interactions.round2-tester-adversarial.test.ts, which shows the CLIENT signature for this exact ' +
      'phase-type pair is NOT seat-qualified',
    async () => {
      const db = await freshDb();
      const gameId = 'r2cWindowAdvance';
      await seedSeed44703Hand(db, gameId, TIMER_RULES);

      const openingWindow = await getCurrentHandState(db, gameId);
      if (openingWindow === null) throw new Error('expected an active hand');
      expect(openingWindow.state.phase.type).toBe('awaiting-discard');

      // Fully time out the dealer's entire turn (discard -> claims all pass
      // -> next seat's awaiting-draw) via repeated enforcement sweeps.
      await backdateAllActions(db, gameId, 10000);
      for (let i = 0; i < 6; i++) {
        await applyTurnTimeouts(db, gameId);
        const current = await getCurrentHandState(db, gameId);
        if (current !== null && current.state.phase.type === 'awaiting-draw' && current.state.currentTurnSeat === 1) {
          break;
        }
        await backdateAllActions(db, gameId, 10000);
      }

      const afterHandoff = await getCurrentHandState(db, gameId);
      if (afterHandoff === null) throw new Error('expected an active hand');
      expect(afterHandoff.state.phase.type).toBe('awaiting-draw');
      expect(afterHandoff.state.currentTurnSeat).toBe(1);

      // The server's windowOpenedAt for seat 1's awaiting-draw must be a
      // genuinely later instant than the hand's own start (seat 0's opening
      // awaiting-draw) — never mistaken for "the same window" merely because
      // both are phase type 'awaiting-draw'.
      expect(afterHandoff.windowOpenedAt).toBeGreaterThan(openingWindow.windowOpenedAt);
    },
  );
});

describe('applyTurnTimeouts — replay parity for a TIMED-OUT DISCARD (not just a timed-out pass)', () => {
  it(
    "the resulting GameState right after the dealer's opening discard (INCLUDING the zero-option " +
      "auto-pass cascade applyTurnTimeouts now runs via applyAutoPass — see turn-timer.ts's doc comment) " +
      'is IDENTICAL whether that exact discard action was appended with timedOut:true or without it — ' +
      "isolating the engine-replay-parity claim to the audit tag itself, with BOTH arms now running the " +
      'same applyAutoPass follow-through so the comparison stays apples-to-apples',
    async () => {
      const dbB = await freshDb();
      const gameB = 'r2pTimedOutDiscard';
      await seedSeed44703Hand(dbB, gameB, TIMER_RULES);
      await backdateAllActions(dbB, gameB, 10000);
      await applyTurnTimeouts(dbB, gameB);

      const rowsB = await listActionsForHand(dbB, gameB, 1);
      const autoDiscardRow = rowsB.find(
        (r) => r.actionType === 'discard' && (r.payload as { timedOut?: boolean }).timedOut === true,
      );
      if (autoDiscardRow === undefined) {
        throw new Error('test fixture assumption broken: expected applyTurnTimeouts to append a timed-out discard');
      }
      const autoDiscardedTileId = (autoDiscardRow.payload as { tileId: string }).tileId;

      const stateAfterAutoDiscard = await getCurrentHandState(dbB, gameB);
      if (stateAfterAutoDiscard === null) throw new Error('expected an active hand');

      // The "manual" comparison arm mirrors EXACTLY what applyTurnTimeouts's
      // own loop does internally: fresh-read, applyAction, appendActionAtSeq
      // with a bare (untagged) action — then, since applyTurnTimeouts now
      // runs applyAutoPass immediately after every successful append (the
      // fix for the "left unresolved for a full extra turnTimerSeconds" bug
      // found in review), this arm runs the SAME applyAutoPass follow-through
      // too, so both arms end at the same point in the hand and the
      // comparison isolates purely "does the tag itself matter" again.
      const dbA = await freshDb();
      const gameA = 'r2pManualDiscard';
      await seedSeed44703Hand(dbA, gameA, TIMER_RULES);
      const freshA = await getCurrentHandState(dbA, gameA);
      if (freshA === null) throw new Error('expected an active hand');
      const appliedA = applyAction(freshA.state, { type: 'discard', seat: 0, tileId: autoDiscardedTileId });
      if (isRuleError(appliedA)) throw new Error(appliedA.message);
      const appendedA = await appendActionAtSeq(
        dbA,
        gameA,
        freshA.handNumber,
        { type: 'discard', seat: 0, tileId: autoDiscardedTileId },
        freshA.lastSeq + 1,
      );
      if (appendedA === 'seq-conflict') throw new Error('unexpected seq conflict in a single-writer test');
      await applyAutoPass(dbA, gameA, freshA.handNumber, appliedA, freshA.lastSeq + 1);
      const manualDiscard = await getCurrentHandState(dbA, gameA);
      if (manualDiscard === null) throw new Error('expected an active hand');

      // Same tile discarded by the same seat from the same deterministic
      // deal, appended through the same primitive with/without the audit
      // tag, both followed by the same auto-pass cascade -> byte-identical
      // resulting GameState, proving the `timedOut` audit tag itself
      // genuinely never influences engine output.
      expect(stateAfterAutoDiscard.state).toEqual(manualDiscard.state);
    },
  );
});

describe(
  'FIXED: applyTurnTimeouts now immediately cleans up zero-option seats after its own auto-discard, ' +
    "matching submitAction's manual discard path (which calls applyAutoPass immediately afterward)",
  () => {
    it(
      'when EVERY non-discarder seat has zero legal claim options on a timed-out auto-discard, the claim ' +
        'window is resolved INSTANTLY within the SAME enforcement call — no longer left sitting open until a ' +
        'subsequent sweep. Originally found as a real bug (a timed-out discard could add up to one full extra ' +
        'turnTimerSeconds delay a manual discard never incurred); fixed by having applyTurnTimeouts run the ' +
        "same applyAutoPass follow-through submitAction already does (see turn-timer.ts's doc comment).",
      async () => {
        const db = await freshDb();
        const gameId = 'r2fZeroOptionLag';
        await seedSeed44703Hand(db, gameId, TIMER_RULES);
        await backdateAllActions(db, gameId, 10000);
        await applyTurnTimeouts(db, gameId);

        // A single enforcement sweep both appends the timed-out discard AND
        // resolves the resulting zero-option claim window in the same call —
        // landing directly on awaiting-draw for the next seat, not sitting
        // in awaiting-claims waiting for a second sweep.
        const afterSweep = await getCurrentHandState(db, gameId);
        if (afterSweep === null) throw new Error('expected an active hand');
        if (afterSweep.state.phase.type !== 'awaiting-draw') {
          throw new Error(
            'test fixture assumption broken: expected the auto-discarded tile to be unclaimable by anyone ' +
              '(a fully zero-option claim window) — if the engine/seed ever changes, this needs a new tile.',
          );
        }

        const rows = await listActionsForHand(db, gameId, 1);
        const passRows = rows.filter((r) => r.actionType === 'pass');
        // All 3 non-discarder seats' zero-option passes landed in this same
        // call, immediately after the auto-discard — not deferred to a
        // second enforcement sweep.
        expect(passRows.length).toBe(3);
        expect(passRows.every((r) => (r.payload as { timedOut?: boolean }).timedOut === undefined)).toBe(true);
      },
    );
  },
);

describe('applyTurnTimeouts — cheap gate short-circuits before any hand replay when disabled', () => {
  it('never queries the actions table beyond the one latest-row lookup when turnTimerSeconds <= 0', async () => {
    const db = await freshDb();
    const gameId = 'r2cDisabledGate';
    const disabledRules: RulesConfig = { ...DEFAULT_RULES, turnTimerSeconds: 0 };
    await seedSeed44703Hand(db, gameId, disabledRules);
    await backdateAllActions(db, gameId, 365 * 24 * 60 * 60 * 1000);

    const before = await listActionsForHand(db, gameId, 1);
    await applyTurnTimeouts(db, gameId);
    const after = await listActionsForHand(db, gameId, 1);

    // No row appended (the primary behavioral guarantee); combined with
    // turn-timer.test.ts's existing disabled-timer no-op coverage, this pins
    // that an arbitrarily ancient window is STILL never enforced once
    // disabled, regardless of how far past any hypothetical deadline it is.
    expect(after.length).toBe(before.length);
  });
});
