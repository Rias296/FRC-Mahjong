/**
 * Independent tester verification pass (2nd round), item 1: pushes the
 * round-1 concurrency-stress.test.ts's "2 concurrent identical submitAction
 * calls" coverage much harder, per the review brief's explicit ask — 20+
 * fully concurrent submitAction calls submitting the SAME conflicting
 * action from the same seat against the same claim window, repeated 5+
 * times, confirming exactly 1 succeeds and the rest get a legitimate
 * RuleError (never a crash from MAX_SUBMIT_OUTER_RETRIES/
 * MAX_AUTO_PASS_ATTEMPTS being exhausted under heavier contention, never
 * silent duplication).
 */
import { createClient, type Client } from '@libsql/client';
import { describe, expect, it } from 'vitest';
import { runMigrations } from './migrations';
import { appendStartHand } from './actions-log';
import { getCurrentHandState, submitAction } from './replay';
import { DEFAULT_RULES, type RulesConfig } from '../engine/rules-config';
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

async function seedGameRow(db: Client, gameId: string, rules: RulesConfig = DEFAULT_RULES): Promise<void> {
  await db.execute({
    sql: `INSERT INTO games (id, room_code, status, rules_config, engine_version, created_at, updated_at)
          VALUES (?, ?, 'in-progress', ?, '0.1.0', 1, 1)`,
    args: [gameId, gameId.slice(0, 6).toUpperCase().padEnd(6, 'X'), JSON.stringify(rules)],
  });
}

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

describe('submitAction under HEAVY (20-way) genuinely concurrent identical collisions, repeated 5+ times', () => {
  it.each([10, 20, 25])(
    '%d fully concurrent IDENTICAL submitAction pass calls for the same seat: exactly 1 succeeds, the rest get a legitimate RuleError, never a crash, repeated across 5 runs',
    async (concurrency) => {
      for (let run = 0; run < 5; run++) {
        const gameId = `heavy-${concurrency}-${run}`;
        const db = await openClaimWindowFixture(gameId);

        const results = await Promise.allSettled(
          Array.from({ length: concurrency }, () => submitAction(db, gameId, { type: 'pass', seat: 1 })),
        );

        // No promise may reject (a thrown "exhausted N outer retries" error,
        // or any other crash, is itself a failure of the bounded-retry
        // design under this concurrency level).
        for (const r of results) {
          if (r.status === 'rejected') {
            throw new Error(
              `run ${run}, concurrency ${concurrency}: submitAction call rejected/crashed instead of returning a RuleError: ${String(r.reason)}`,
            );
          }
        }

        const fulfilled = results.map((r) => (r as PromiseFulfilledResult<Awaited<ReturnType<typeof submitAction>>>).value);
        const successes = fulfilled.filter((v) => !isSubmitRuleError(v));
        const errors = fulfilled.filter((v) => isSubmitRuleError(v));

        expect(successes.length).toBe(1);
        expect(errors.length).toBe(concurrency - 1);
        // Every error must be a legitimate rejection (already-responded),
        // not some other unrelated/garbage error code.
        for (const e of errors) {
          if (!isSubmitRuleError(e)) throw new Error('unreachable');
          expect(e.code).toBe('already-responded');
        }

        // Exactly one seat-1 pass row must have been durably appended.
        const rows = await db.execute({
          sql: `SELECT seq FROM actions WHERE game_id = ? AND actor_seat = 1 AND action_type = 'pass'`,
          args: [gameId],
        });
        expect(rows.rows.length).toBe(1);

        // The hand must remain fully replayable.
        await expect(getCurrentHandState(db, gameId)).resolves.not.toThrow();
      }
    },
    60_000,
  );

  it('20-way concurrent IDENTICAL claim (not just pass) collisions for the same seat also converge to exactly 1 success', async () => {
    for (let run = 0; run < 5; run++) {
      const gameId = `heavy-claim-${run}`;
      const db = await openClaimWindowFixture(gameId);

      const results = await Promise.allSettled(
        Array.from({ length: 20 }, () =>
          submitAction(db, gameId, { type: 'claim', seat: 2, claim: { type: 'hu' } }),
        ),
      );

      for (const r of results) {
        if (r.status === 'rejected') {
          throw new Error(`run ${run}: submitAction hu-claim call rejected/crashed: ${String(r.reason)}`);
        }
      }

      const fulfilled = results.map((r) => (r as PromiseFulfilledResult<Awaited<ReturnType<typeof submitAction>>>).value);
      const successes = fulfilled.filter((v) => !isSubmitRuleError(v));
      expect(successes.length).toBe(1);

      // This claim alone triggers hu resolution once responses hit 3/3
      // (seat 3 auto-passed + seat 2 hu + ... — actually only 2 responses
      // here since seat 1 never responds in this test, so the window stays
      // open at 2/3). Regardless, exactly one hu-claim row must exist.
      const rows = await db.execute({
        sql: `SELECT seq FROM actions WHERE game_id = ? AND actor_seat = 2 AND action_type = 'claim'`,
        args: [gameId],
      });
      expect(rows.rows.length).toBe(1);

      await expect(getCurrentHandState(db, gameId)).resolves.not.toThrow();
    }
  });
});
