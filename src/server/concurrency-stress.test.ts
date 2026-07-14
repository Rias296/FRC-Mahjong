/**
 * Tester-authored stress coverage for the concurrency-critical paths in
 * actions-log.ts / replay.ts, per the round-1 review brief. Pushes well
 * beyond the builder's own "2 concurrent calls" coverage:
 *  - appendStartHand's INSERT..SELECT..WHERE NOT EXISTS dedup guard under
 *    10-20 concurrent callers, repeated across multiple runs.
 *  - advanceToNextHand under the same load.
 *  - submitAction's behavior under a genuine same-seat concurrent double
 *    submission within an open claim window (the race case the docstring on
 *    submitAction does NOT describe handling: appendAction's own inner
 *    retry only recomputes `seq` and blindly retries the SAME action
 *    payload — it never re-validates the action's semantic legality against
 *    fresh state, and submitAction itself validates once against a
 *    pre-write snapshot before appending).
 */
import { createClient, type Client } from '@libsql/client';
import { describe, expect, it } from 'vitest';
import { runMigrations } from './migrations';
import { appendActionAtSeq, appendStartHand } from './actions-log';
import { applyAutoPass, advanceToNextHand, getCurrentHandState, submitAction } from './replay';
import { DEFAULT_RULES, type RulesConfig } from '../engine/rules-config';
import { applyAction, isRuleError, type GameState, type RuleError } from '../engine/game-state';

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

function isSubmitRuleError(
  r: { readonly state: GameState; readonly handNumber: number } | RuleError,
): r is RuleError {
  return 'type' in r && r.type === 'rule-error';
}

const HIGH_RESERVE_RULES: RulesConfig = { ...DEFAULT_RULES, deadWallReserve: 140 };

describe('appendStartHand under heavy concurrency', () => {
  it.each([10, 20])(
    '%d fully concurrent appendStartHand calls for the same (game, hand) produce exactly one row, repeated across 5 runs',
    async (concurrency) => {
      for (let run = 0; run < 5; run++) {
        const db = await freshDb();
        const gameId = `race-${concurrency}-${run}`;
        await seedGameRow(db, gameId);

        const calls = Array.from({ length: concurrency }, (_, i) =>
          appendStartHand(db, gameId, {
            handNumber: 1,
            dealerSeat: 0,
            seed: i, // distinct payloads so we can see which one "won"
            repeatCount: 0,
            prevailingWind: 'east',
          }),
        );
        const results = await Promise.all(calls);

        // Every caller must agree on the SAME seq (the one true row).
        const seqs = new Set(results.map((r) => r.seq));
        expect(seqs.size).toBe(1);

        const dupCheck = await db.execute({
          sql: `SELECT COUNT(*) AS n FROM actions WHERE game_id = ? AND hand_number = 1 AND action_type = 'start-hand'`,
          args: [gameId],
        });
        expect(Number(dupCheck.rows[0].n)).toBe(1);
      }
    },
  );

  it('interleaves concurrent appendStartHand calls with randomized microtask/macrotask jitter (not just same-tick Promise.all)', async () => {
    for (let run = 0; run < 5; run++) {
      const db = await freshDb();
      const gameId = `jitter-${run}`;
      await seedGameRow(db, gameId);

      const jittered = (i: number) =>
        new Promise<{ seq: number }>((resolve, reject) => {
          setTimeout(() => {
            appendStartHand(db, gameId, {
              handNumber: 1,
              dealerSeat: 0,
              seed: i,
              repeatCount: 0,
              prevailingWind: 'east',
            }).then(resolve, reject);
          }, Math.floor(Math.random() * 5));
        });

      const results = await Promise.all(Array.from({ length: 15 }, (_, i) => jittered(i)));
      const seqs = new Set(results.map((r) => r.seq));
      expect(seqs.size).toBe(1);

      const dupCheck = await db.execute({
        sql: `SELECT COUNT(*) AS n FROM actions WHERE game_id = ? AND hand_number = 1 AND action_type = 'start-hand'`,
        args: [gameId],
      });
      expect(Number(dupCheck.rows[0].n)).toBe(1);
    }
  });
});

describe('advanceToNextHand under heavy concurrency', () => {
  it.each([10, 20])(
    '%d fully concurrent advanceToNextHand calls from the same finished hand converge on exactly one next hand, repeated across 5 runs',
    async (concurrency) => {
      for (let run = 0; run < 5; run++) {
        const db = await freshDb();
        const gameId = `advrace-${concurrency}-${run}`;
        await seedGameRow(db, gameId, HIGH_RESERVE_RULES);
        await appendStartHand(db, gameId, {
          handNumber: 1,
          dealerSeat: 0,
          seed: 5,
          repeatCount: 0,
          prevailingWind: 'east',
        });

        const results = await Promise.allSettled(
          Array.from({ length: concurrency }, () => advanceToNextHand(db, gameId)),
        );

        for (const r of results) {
          if (r.status === 'rejected') {
            throw new Error(`advanceToNextHand rejected under ${concurrency}-way concurrency: ${String(r.reason)}`);
          }
        }

        const succeeded = results
          .filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof advanceToNextHand>>> => r.status === 'fulfilled')
          .map((r) => r.value);

        // None should report game-finished/hand-not-over under this setup.
        for (const v of succeeded) {
          if ('error' in v) {
            throw new Error(`unexpected advanceToNextHand error under concurrency: ${v.error}`);
          }
        }

        const dupCheck = await db.execute({
          sql: `SELECT hand_number, COUNT(*) AS n FROM actions WHERE game_id = ? AND action_type = 'start-hand'
                GROUP BY hand_number HAVING COUNT(*) > 1`,
          args: [gameId],
        });
        expect(dupCheck.rows.length).toBe(0);

        // Every caller's returned state must agree (all re-derive via replayHand).
        const states = succeeded.map((v) => ('state' in v ? v.state : null));
        for (const s of states) {
          expect(s).toEqual(states[0]);
        }
      }
    },
  );
});

describe('submitAction under genuine concurrent collisions (CRITICAL)', () => {
  /**
   * Fixture: seed 44703, dealer=0 discards tiao-7-4. After that single
   * discard (with the server's own auto-pass already applied), seat 2 has a
   * real hu option, seat 1 has a real pung option, and seat 3 has zero
   * options (auto-passed). This leaves an open awaiting-claims window with
   * seats 1 and 2 unresponded, which is exactly the state needed to fire
   * concurrent submitAction calls against a live claim window.
   */
  async function openClaimWindowFixture(gameId: string): Promise<Client> {
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
    return db;
  }

  it('two concurrent IDENTICAL submitAction calls for the same seat in the same claim window must not both silently succeed', async () => {
    const db = await openClaimWindowFixture('dupe-race-1');

    const [r1, r2] = await Promise.all([
      submitAction(db, 'dupe-race-1', { type: 'pass', seat: 1 }),
      submitAction(db, 'dupe-race-1', { type: 'pass', seat: 1 }),
    ]);

    const successes = [r1, r2].filter((r) => !isSubmitRuleError(r));
    const errors = [r1, r2].filter((r) => isSubmitRuleError(r));

    // Exactly one of the two identical concurrent submissions for the same
    // seat should land; the other should be rejected (a legitimate
    // RuleError such as 'already-responded'), never both silently accepted.
    expect(successes.length).toBe(1);
    expect(errors.length).toBe(1);

    // And critically: the hand must remain replayable afterward. A
    // corrupted log (an action the engine itself would reject when replayed
    // in seq order) must never be written, even under a race.
    await expect(getCurrentHandState(db, 'dupe-race-1')).resolves.not.toThrow();
  });

  it('does not corrupt the action log such that it becomes unreplayable', async () => {
    const db = await openClaimWindowFixture('dupe-race-2');

    await Promise.all([
      submitAction(db, 'dupe-race-2', { type: 'pass', seat: 1 }),
      submitAction(db, 'dupe-race-2', { type: 'pass', seat: 1 }),
    ]);

    // The action log, once written via submitAction, must always remain
    // loudly-corrupt-free for legitimate concurrent client usage (as
    // opposed to direct DB tampering, which corruption.test.ts covers
    // separately). A duplicate same-seat response must never be durably
    // appended twice.
    const rows = await db.execute({
      sql: `SELECT seq FROM actions WHERE game_id = ? AND actor_seat = 1 AND action_type = 'pass'`,
      args: ['dupe-race-2'],
    });
    expect(rows.rows.length).toBe(1);
  });
});

describe('applyAutoPass under genuine concurrent collisions (CRITICAL)', () => {
  /**
   * Same fixture discard as openClaimWindowFixture above (seed 44703,
   * dealer=0, discard tiao-7-4: seat 2 gets a real hu option, seat 1 a real
   * pung option, seat 3 zero options), but the discard is appended directly
   * via appendActionAtSeq — NOT via submitAction — so submitAction's own
   * internal applyAutoPass call never runs. This leaves the freshly-
   * discarded state with seat 3 still zero-option AND unresponded, which is
   * exactly what's needed to call applyAutoPass directly, twice,
   * concurrently, against the SAME pre-auto-pass state — simulating two
   * different real submitAction calls (for two different genuine actions)
   * each independently deciding seat 3 needs auto-passing in the same
   * window.
   */
  async function openClaimWindowBeforeAutoPassFixture(
    gameId: string,
  ): Promise<{ db: Client; handNumber: number; state: GameState; lastSeq: number }> {
    const db = await freshDb();
    await seedGameRow(db, gameId);
    await appendStartHand(db, gameId, {
      handNumber: 1,
      dealerSeat: 0,
      seed: 44703,
      repeatCount: 0,
      prevailingWind: 'east',
    });

    const before = await getCurrentHandState(db, gameId);
    if (before === null) {
      throw new Error('test fixture assumption broken: no active hand after start-hand');
    }
    const discardAction = { type: 'discard' as const, seat: 0 as const, tileId: 'tiao-7-4' };
    const applied = applyAction(before.state, discardAction);
    if (isRuleError(applied)) {
      throw new Error(`test fixture assumption broken: ${applied.message}`);
    }
    if (applied.phase.type !== 'awaiting-claims') {
      throw new Error('test fixture assumption broken: expected awaiting-claims to remain open');
    }

    const appendResult = await appendActionAtSeq(db, gameId, before.handNumber, discardAction, before.lastSeq + 1);
    if (appendResult === 'seq-conflict') {
      throw new Error('test fixture assumption broken: unexpected seq conflict appending the fixture discard');
    }

    return { db, handNumber: before.handNumber, state: applied, lastSeq: appendResult.seq };
  }

  it('two concurrent applyAutoPass calls against the same just-discarded state auto-pass the zero-option seat exactly once', async () => {
    const { db, handNumber, state, lastSeq } = await openClaimWindowBeforeAutoPassFixture('autopass-race-1');

    const [r1, r2] = await Promise.all([
      applyAutoPass(db, 'autopass-race-1', handNumber, state, lastSeq),
      applyAutoPass(db, 'autopass-race-1', handNumber, state, lastSeq),
    ]);

    // Exactly one auto-pass row for seat 3 (the zero-option seat) must have
    // been durably appended — never two, even though both calls started
    // from the identical pre-auto-pass snapshot.
    const rows = await db.execute({
      sql: `SELECT seq FROM actions WHERE game_id = ? AND actor_seat = 3 AND action_type = 'pass'`,
      args: ['autopass-race-1'],
    });
    expect(rows.rows.length).toBe(1);

    // Both calls must converge on the same resulting phase/window (seat 3
    // auto-passed, seats 1 and 2 still open with their real options).
    expect(r1).toEqual(r2);
    const s1 = r1.state;
    if (s1.phase.type === 'awaiting-claims') {
      expect(s1.phase.responses[3]).toBe('pass');
      expect(s1.phase.responses[1]).toBeUndefined();
      expect(s1.phase.responses[2]).toBeUndefined();
    } else {
      throw new Error(`expected awaiting-claims to remain open after auto-pass, got ${s1.phase.type}`);
    }

    // And critically: the hand must remain replayable afterward — no
    // duplicate/corrupt row that the engine would reject on replay.
    await expect(getCurrentHandState(db, 'autopass-race-1')).resolves.not.toThrow();
  });

  it('does not corrupt the action log under repeated concurrent applyAutoPass races', async () => {
    for (let run = 0; run < 5; run++) {
      const gameId = `autopass-race-2-${run}`;
      const { db, handNumber, state, lastSeq } = await openClaimWindowBeforeAutoPassFixture(gameId);

      const results = await Promise.allSettled([
        applyAutoPass(db, gameId, handNumber, state, lastSeq),
        applyAutoPass(db, gameId, handNumber, state, lastSeq),
        applyAutoPass(db, gameId, handNumber, state, lastSeq),
      ]);

      for (const r of results) {
        if (r.status === 'rejected') {
          throw new Error(`applyAutoPass rejected under concurrency: ${String(r.reason)}`);
        }
      }

      const rows = await db.execute({
        sql: `SELECT seq FROM actions WHERE game_id = ? AND actor_seat = 3 AND action_type = 'pass'`,
        args: [gameId],
      });
      expect(rows.rows.length).toBe(1);

      await expect(getCurrentHandState(db, gameId)).resolves.not.toThrow();
    }
  });
});
