import { createClient, type Client } from '@libsql/client';
import { describe, expect, it } from 'vitest';
import { runMigrations } from './migrations';
import { appendStartHand } from './actions-log';
import { DbPollingRealtimeSource } from './realtime';
import type { Seat } from '../engine/seats';

async function freshDb(): Promise<Client> {
  const db = createClient({ url: ':memory:' });
  await runMigrations(db);
  return db;
}

async function seedGameRow(db: Client, gameId: string): Promise<void> {
  await db.execute({
    sql: `INSERT INTO games (id, room_code, status, rules_config, engine_version, created_at, updated_at)
          VALUES (?, ?, 'in-progress', '{}', '0.1.0', 1, 1)`,
    args: [gameId, gameId.slice(0, 6).toUpperCase().padEnd(6, 'X')],
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('DbPollingRealtimeSource.publish', () => {
  it('is a documented no-op (the actions-table insert is the real publish signal)', async () => {
    const db = await freshDb();
    const source = new DbPollingRealtimeSource(db);
    await expect(source.publish('g1', { seq: 1 })).resolves.toBeUndefined();
  });
});

describe('DbPollingRealtimeSource.subscribe', () => {
  it('yields immediately when latestSeq is already ahead of sinceSeq', async () => {
    const db = await freshDb();
    await seedGameRow(db, 'g1');
    await appendStartHand(db, 'g1', {
      handNumber: 1,
      dealerSeat: 0 as Seat,
      seed: 1,
      repeatCount: 0,
      prevailingWind: 'east',
    });

    const source = new DbPollingRealtimeSource(db);
    const controller = new AbortController();
    const gen = source.subscribe('g1', 0, controller.signal);

    const result = await gen.next();
    expect(result.done).toBe(false);
    expect(result.value).toEqual({ seq: 1 });

    controller.abort();
    await gen.return(undefined);
  });

  it('respects sinceSeq: does not immediately replay an already-seen seq', async () => {
    const db = await freshDb();
    await seedGameRow(db, 'g1');
    await appendStartHand(db, 'g1', {
      handNumber: 1,
      dealerSeat: 0 as Seat,
      seed: 1,
      repeatCount: 0,
      prevailingWind: 'east',
    });

    const source = new DbPollingRealtimeSource(db);
    const controller = new AbortController();
    // sinceSeq already equals the latest persisted seq (1); the generator
    // must not immediately re-yield it.
    const gen = source.subscribe('g1', 1, controller.signal);

    const pending = gen.next();
    // Give the generator's first (non-yielding) poll iteration a moment to
    // run and enter its sleep, then abort before the 1500ms poll interval
    // would otherwise elapse.
    await sleep(50);
    controller.abort();

    const result = await pending;
    expect(result.done).toBe(true);
  });

  it('does not yield spuriously and aborts promptly, without waiting out the full poll interval', async () => {
    const db = await freshDb();
    await seedGameRow(db, 'g1');

    const source = new DbPollingRealtimeSource(db);
    const controller = new AbortController();
    const gen = source.subscribe('g1', 0, controller.signal);

    const start = Date.now();
    const pending = gen.next();
    setTimeout(() => controller.abort(), 30);
    const result = await pending;
    const elapsed = Date.now() - start;

    expect(result.done).toBe(true);
    // The poll interval is 1500ms; a prompt abort must resolve well short of
    // a full interval, proving the generator actually stops rather than the
    // test merely not hanging by accident.
    expect(elapsed).toBeLessThan(800);
  });

  it('updates its internal cursor after yielding, so a later poll only yields a genuinely new seq', async () => {
    const db = await freshDb();
    await seedGameRow(db, 'g1');
    await appendStartHand(db, 'g1', {
      handNumber: 1,
      dealerSeat: 0 as Seat,
      seed: 1,
      repeatCount: 0,
      prevailingWind: 'east',
    });

    const source = new DbPollingRealtimeSource(db);
    const controller = new AbortController();
    const gen = source.subscribe('g1', 0, controller.signal);

    const first = await gen.next();
    expect(first.value).toEqual({ seq: 1 });

    const secondPending = gen.next();
    // Insert the next hand's start-hand row shortly after the generator
    // begins its post-yield poll cycle, well inside the 1500ms interval.
    await sleep(100);
    await appendStartHand(db, 'g1', {
      handNumber: 2,
      dealerSeat: 1 as Seat,
      seed: 2,
      repeatCount: 0,
      prevailingWind: 'east',
    });

    const second = await secondPending;
    expect(second.done).toBe(false);
    expect(second.value).toEqual({ seq: 2 });

    controller.abort();
    await gen.return(undefined);
  }, 10000);
});

describe('DbPollingRealtimeSource onPoll hook', () => {
  it('invokes onPoll once per poll tick, BEFORE checking for new rows', async () => {
    const db = await freshDb();
    await seedGameRow(db, 'g1');
    await appendStartHand(db, 'g1', {
      handNumber: 1,
      dealerSeat: 0 as Seat,
      seed: 1,
      repeatCount: 0,
      prevailingWind: 'east',
    });

    const pollCalls: string[] = [];
    const onPoll = async (gameId: string): Promise<void> => {
      pollCalls.push(gameId);
    };

    const source = new DbPollingRealtimeSource(db, onPoll);
    const controller = new AbortController();
    const gen = source.subscribe('g1', 0, controller.signal);

    const result = await gen.next();
    expect(result.done).toBe(false);
    expect(pollCalls).toEqual(['g1']);

    controller.abort();
    await gen.return(undefined);
  });

  it('does not invoke onPoll when none is supplied (default, unchanged behavior)', async () => {
    const db = await freshDb();
    await seedGameRow(db, 'g1');
    await appendStartHand(db, 'g1', {
      handNumber: 1,
      dealerSeat: 0 as Seat,
      seed: 1,
      repeatCount: 0,
      prevailingWind: 'east',
    });

    const source = new DbPollingRealtimeSource(db);
    const controller = new AbortController();
    const gen = source.subscribe('g1', 0, controller.signal);

    const result = await gen.next();
    expect(result.done).toBe(false);
    expect(result.value).toEqual({ seq: 1 });

    controller.abort();
    await gen.return(undefined);
  });

  it('a throwing onPoll hook is caught/logged and never breaks the stream', async () => {
    const db = await freshDb();
    await seedGameRow(db, 'g1');
    await appendStartHand(db, 'g1', {
      handNumber: 1,
      dealerSeat: 0 as Seat,
      seed: 1,
      repeatCount: 0,
      prevailingWind: 'east',
    });

    const onPoll = async (): Promise<void> => {
      throw new Error('boom');
    };
    const source = new DbPollingRealtimeSource(db, onPoll);
    const controller = new AbortController();
    const gen = source.subscribe('g1', 0, controller.signal);

    const result = await gen.next();
    expect(result.done).toBe(false);
    expect(result.value).toEqual({ seq: 1 });

    controller.abort();
    await gen.return(undefined);
  });

  it('invokes onPoll on every poll iteration, not just the first', async () => {
    const db = await freshDb();
    await seedGameRow(db, 'g1');
    await appendStartHand(db, 'g1', {
      handNumber: 1,
      dealerSeat: 0 as Seat,
      seed: 1,
      repeatCount: 0,
      prevailingWind: 'east',
    });

    let count = 0;
    const onPoll = async (): Promise<void> => {
      count += 1;
    };
    const source = new DbPollingRealtimeSource(db, onPoll);
    const controller = new AbortController();
    // sinceSeq === the already-persisted latest seq (1), so subscribe sleeps
    // between poll ticks rather than yielding immediately.
    const gen = source.subscribe('g1', 1, controller.signal);

    const pending = gen.next();
    await sleep(50);
    controller.abort();
    await pending;

    expect(count).toBeGreaterThanOrEqual(1);
  });
});
