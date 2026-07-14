/**
 * Tester-authored coverage for round-1 review brief item 4: manually insert
 * malformed/out-of-order rows directly into the actions table (bypassing
 * actions-log.ts entirely, simulating direct DB tampering or an upstream
 * bug that wrote bad data) and confirm replayHand/getCurrentHandState fail
 * LOUDLY (throw) rather than silently returning a wrong GameState. Extends
 * the builder's own two corrupt-log tests (missing start-hand row; a
 * logged action rejected by the engine) with additional malformed-input
 * shapes.
 */
import { createClient, type Client } from '@libsql/client';
import { describe, expect, it } from 'vitest';
import { runMigrations } from './migrations';
import { appendStartHand } from './actions-log';
import { getCurrentHandState, replayHand } from './replay';
import { DEFAULT_RULES } from '../engine/rules-config';

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

describe('corruption / defense-in-depth: replayHand and getCurrentHandState must never silently swallow bad data', () => {
  it('throws when a discard row is inserted before any start-hand row exists at all (zero rows in the hand)', async () => {
    const db = await freshDb();
    await seedGameRow(db, 'c1');
    await db.execute({
      sql: `INSERT INTO actions (game_id, hand_number, seq, actor_seat, action_type, payload, created_at)
            VALUES ('c1', 1, 1, 0, 'discard', '{"type":"discard","seat":0,"tileId":"wan1-1"}', 1)`,
    });

    await expect(replayHand(db, 'c1', 1, DEFAULT_RULES)).rejects.toThrow(/corrupt log/);
    await expect(getCurrentHandState(db, 'c1')).rejects.toThrow(/corrupt log/);
  });

  it('throws on invalid JSON in a payload column (bypassing appendAction/appendStartHand entirely)', async () => {
    const db = await freshDb();
    await seedGameRow(db, 'c2');
    await appendStartHand(db, 'c2', { handNumber: 1, dealerSeat: 0, seed: 1, repeatCount: 0, prevailingWind: 'east' });
    await db.execute({
      sql: `INSERT INTO actions (game_id, hand_number, seq, actor_seat, action_type, payload, created_at)
            VALUES ('c2', 1, 2, 0, 'discard', 'not-valid-json{{{', 1)`,
    });

    // JSON.parse throwing a SyntaxError inside listActionsForHand/replayHand
    // must propagate loudly, not be caught and papered over.
    await expect(replayHand(db, 'c2', 1, DEFAULT_RULES)).rejects.toThrow();
    await expect(getCurrentHandState(db, 'c2')).rejects.toThrow();
  });

  it('rejects a second start-hand row for the same hand at the DB layer itself when force-inserted directly (bypassing appendStartHand\'s dedup guard)', async () => {
    // This directly probes item 8's judgment call: even if the app-level
    // guard were somehow bypassed (e.g. a future direct-SQL code path, or a
    // bug), can a corrupting duplicate start-hand row ever actually land?
    // As of migrations/0002_start_hand_unique.sql's additive partial unique
    // index on actions(game_id, hand_number) WHERE action_type = 'start-hand',
    // the answer is stronger than "replay fails loudly after the fact": the
    // DB itself refuses the INSERT outright, so the corrupting row is never
    // written at all, and the hand remains perfectly replayable afterward.
    const db = await freshDb();
    await seedGameRow(db, 'c3');
    await appendStartHand(db, 'c3', { handNumber: 1, dealerSeat: 0, seed: 1, repeatCount: 0, prevailingWind: 'east' });

    await expect(
      db.execute({
        sql: `INSERT INTO actions (game_id, hand_number, seq, actor_seat, action_type, payload, created_at)
              VALUES ('c3', 1, 2, NULL, 'start-hand', ?, 1)`,
        args: [JSON.stringify({ handNumber: 1, dealerSeat: 2, seed: 999, repeatCount: 0, prevailingWind: 'east' })],
      }),
    ).rejects.toThrow(/UNIQUE constraint/);

    // The bypass attempt never took effect; the hand remains fully intact
    // and replayable.
    await expect(replayHand(db, 'c3', 1, DEFAULT_RULES)).resolves.not.toThrow();
    await expect(getCurrentHandState(db, 'c3')).resolves.not.toThrow();
  });

  it('throws when action_type metadata disagrees with the actual payload type (still validated against real engine state, not the label)', async () => {
    const db = await freshDb();
    await seedGameRow(db, 'c4');
    await appendStartHand(db, 'c4', { handNumber: 1, dealerSeat: 0, seed: 1, repeatCount: 0, prevailingWind: 'east' });
    // action_type column says 'draw', but the payload is actually a discard
    // for a seat that is not currentTurnSeat's declared drawn state — must
    // still be evaluated (and rejected) against real engine semantics via
    // the payload, not silently accepted because the label looks generic.
    await db.execute({
      sql: `INSERT INTO actions (game_id, hand_number, seq, actor_seat, action_type, payload, created_at)
            VALUES ('c4', 1, 2, 1, 'draw', '{"type":"discard","seat":1,"tileId":"bogus-tile-id"}', 1)`,
    });

    await expect(replayHand(db, 'c4', 1, DEFAULT_RULES)).rejects.toThrow(/corrupt replay/);
  });

  it('throws for an out-of-order claim row (a claim response before any discard has opened a claim window)', async () => {
    const db = await freshDb();
    await seedGameRow(db, 'c5');
    await appendStartHand(db, 'c5', { handNumber: 1, dealerSeat: 0, seed: 1, repeatCount: 0, prevailingWind: 'east' });
    await db.execute({
      sql: `INSERT INTO actions (game_id, hand_number, seq, actor_seat, action_type, payload, created_at)
            VALUES ('c5', 1, 2, 1, 'pass', '{"type":"pass","seat":1}', 1)`,
    });

    await expect(replayHand(db, 'c5', 1, DEFAULT_RULES)).rejects.toThrow(/corrupt replay/);
  });

  it('the schema itself refuses (FOREIGN KEY constraint) an actions row referencing a game_id with no games row — an additional, stronger defense-in-depth layer than replay.ts alone', async () => {
    const db = await freshDb();
    // Deliberately skip seedGameRow: actions reference a game_id with no
    // corresponding games row. This is rejected at the DB layer itself,
    // before replay.ts even gets a chance to run — the schema's
    // `REFERENCES games(id)` FK is actively enforced (not merely
    // documentation) under this libsql configuration.
    await expect(
      db.execute({
        sql: `INSERT INTO actions (game_id, hand_number, seq, actor_seat, action_type, payload, created_at)
              VALUES ('ghost', 1, 1, NULL, 'start-hand', ?, 1)`,
        args: [JSON.stringify({ handNumber: 1, dealerSeat: 0, seed: 1, repeatCount: 0, prevailingWind: 'east' })],
      }),
    ).rejects.toThrow(/FOREIGN KEY/);
  });

  it('the schema also refuses to delete a games row that still has actions referencing it (FK RESTRICT/NO ACTION, not CASCADE)', async () => {
    const db = await freshDb();
    await seedGameRow(db, 'c6');
    await appendStartHand(db, 'c6', { handNumber: 1, dealerSeat: 0, seed: 1, repeatCount: 0, prevailingWind: 'east' });

    // An orphaned-actions scenario (games row deleted, actions rows left
    // behind) cannot actually be constructed against this schema at all:
    // the FK is enforced on delete too (no ON DELETE CASCADE declared).
    await expect(db.execute({ sql: 'DELETE FROM games WHERE id = ?', args: ['c6'] })).rejects.toThrow(/FOREIGN KEY/);

    // getCurrentHandState still works normally afterward (the delete never
    // actually took effect).
    const state = await getCurrentHandState(db, 'c6');
    expect(state).not.toBeNull();
  });
});
