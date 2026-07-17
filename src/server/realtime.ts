/**
 * Realtime change notification for a game's action log. The actions table
 * (see actions-log.ts) IS the durable source of truth; this module only
 * signals "something changed, go re-fetch" — it never carries state itself.
 */

import type { Client } from '@libsql/client';
import { getLatestSeq } from './actions-log';

const POLL_INTERVAL_MS = 1500;

export interface RealtimeSource {
  publish(gameId: string, event: { seq: number }): Promise<void>;
  subscribe(gameId: string, sinceSeq: number, signal: AbortSignal): AsyncGenerator<{ seq: number }>;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * DB-polling implementation of RealtimeSource. `publish` is a no-op: the
 * actions-table INSERT (via appendActionAtSeq/appendStartHand in
 * actions-log.ts) IS the publish signal — there is no separate fan-out to
 * perform, since every subscriber independently polls the same table.
 *
 * `onPoll`, when supplied, is invoked once per poll tick, BEFORE checking
 * for new rows — this makes each connected client's own SSE poll interval
 * double as the turn-timer enforcement clock (see
 * `src/server/turn-timer.ts`'s `applyTurnTimeouts`), matching this
 * project's existing serverless architecture (no background process/cron —
 * see docs/DECISIONS.md's "Realtime is DB-polling SSE... Turso/libSQL has no
 * change-notification primitive and Vercel serverless has no cross-
 * invocation memory" entry). A hook failure is caught and logged here (never
 * propagated), so it can never break the notification stream itself, on top
 * of `applyTurnTimeouts`'s own guarantee that it never throws for an
 * ordinary rule-validation failure.
 */
export class DbPollingRealtimeSource implements RealtimeSource {
  constructor(
    private readonly db: Client,
    private readonly onPoll?: (gameId: string) => Promise<void>,
  ) {}

  async publish(gameId: string, event: { seq: number }): Promise<void> {
    // No-op by design; see class doc comment. Referencing the params (as a
    // no-op) keeps this an explicit, intentional no-op rather than tripping
    // an unused-parameter lint warning that could be mistaken for a bug.
    void gameId;
    void event;
  }

  async *subscribe(gameId: string, sinceSeq: number, signal: AbortSignal): AsyncGenerator<{ seq: number }> {
    let cursor = sinceSeq;

    while (!signal.aborted) {
      if (this.onPoll !== undefined) {
        try {
          await this.onPoll(gameId);
        } catch (err) {
          console.error(`[realtime] onPoll hook failed for game ${gameId}:`, err);
        }
        if (signal.aborted) {
          return;
        }
      }

      const latestSeq = await getLatestSeq(this.db, gameId);
      if (signal.aborted) {
        return;
      }
      if (latestSeq > cursor) {
        cursor = latestSeq;
        yield { seq: latestSeq };
        continue;
      }
      await sleep(POLL_INTERVAL_MS, signal);
    }
  }
}
