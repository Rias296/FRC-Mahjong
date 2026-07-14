import { createClient, type Client } from '@libsql/client';
import { describe, expect, it } from 'vitest';
import { runMigrations } from './migrations';
import { createGame, joinGame } from './games';
import { appendAction, appendStartHand, getLatestSeq, listActionsForHand, type StartHandPayload } from './actions-log';
import { advanceToNextHand, applyAutoPass, getCurrentHandState, replayHand, submitAction } from './replay';
import { applyAction, isRuleError, startHand, type GameState, type RuleError } from '../engine/game-state';
import { DEFAULT_RULES, type RulesConfig } from '../engine/rules-config';
import { canChow, canKongFromDiscard, canPung } from '../engine/actions';
import { canWin } from '../engine/hand';
import { SEATS, type Seat } from '../engine/seats';

/**
 * submitAction's success case is `{ state, handNumber }`, not a bare
 * GameState, so the engine's own `isRuleError` (typed against
 * `GameState | RuleError`) doesn't directly apply to its return type. This
 * narrows the same way, for that shape.
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
 * Directly inserts a start-hand row without going through appendStartHand's
 * seq-retry machinery, purely to seed a synthetic multi-hand dealer-seat
 * history for the wind-progression tests below. These synthetic hands are
 * never individually replayed (only their raw dealerSeat is read back via
 * SQL by replay.ts's countWindTransitions), so their seed/repeatCount values
 * are placeholders.
 */
async function seedDummyStartHand(db: Client, gameId: string, handNumber: number, dealerSeat: Seat): Promise<void> {
  const seqRow = await db.execute({
    sql: 'SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM actions WHERE game_id = ?',
    args: [gameId],
  });
  const seq = Number(seqRow.rows[0].n);
  const payload: StartHandPayload = {
    handNumber,
    dealerSeat,
    seed: 1,
    repeatCount: 0,
    prevailingWind: 'east',
  };
  await db.execute({
    sql: `INSERT INTO actions (game_id, hand_number, seq, actor_seat, action_type, payload, created_at)
          VALUES (?, ?, ?, NULL, 'start-hand', ?, ?)`,
    args: [gameId, handNumber, seq, JSON.stringify(payload), Date.now()],
  });
}

// A deadWallReserve high enough that startHand ends immediately in an
// exhaustive draw (same technique as game-state.test.ts's degenerate-config
// coverage), giving us a cheap, deterministic 'hand-over' state to drive
// advanceToNextHand without needing to construct a real winning hand.
const HIGH_RESERVE_RULES: RulesConfig = { ...DEFAULT_RULES, deadWallReserve: 140 };

describe('replayHand', () => {
  it('reproduces startHand exactly from a stored start-hand payload', async () => {
    const db = await freshDb();
    await seedGameRow(db, 'g1');
    await appendStartHand(db, 'g1', { handNumber: 1, dealerSeat: 0, seed: 42, repeatCount: 0, prevailingWind: 'east' });

    const replayed = await replayHand(db, 'g1', 1, DEFAULT_RULES);
    const direct = startHand(0, 42, DEFAULT_RULES, 0);
    expect(replayed).toEqual(direct);
  });

  it('folds a discard action through the engine identically to direct applyAction', async () => {
    const db = await freshDb();
    await seedGameRow(db, 'g2');
    await appendStartHand(db, 'g2', { handNumber: 1, dealerSeat: 0, seed: 42, repeatCount: 0, prevailingWind: 'east' });

    const direct = startHand(0, 42, DEFAULT_RULES, 0);
    if (direct.phase.type !== 'awaiting-discard' || direct.phase.drawnTile === null) {
      throw new Error('test fixture assumption broken: expected awaiting-discard with a drawn tile');
    }
    const discardAction = { type: 'discard' as const, seat: 0 as Seat, tileId: direct.phase.drawnTile.id };
    await appendAction(db, 'g2', 1, discardAction);

    const replayed = await replayHand(db, 'g2', 1, DEFAULT_RULES);
    const directAfterDiscard = applyAction(direct, discardAction);
    if (isRuleError(directAfterDiscard)) {
      throw new Error(`test fixture assumption broken: ${directAfterDiscard.message}`);
    }
    expect(replayed).toEqual(directAfterDiscard);
  });

  it('throws a clear internal error when the log is corrupt (missing start-hand row)', async () => {
    const db = await freshDb();
    await seedGameRow(db, 'g3');
    await expect(replayHand(db, 'g3', 1, DEFAULT_RULES)).rejects.toThrow(/corrupt log/);
  });

  it('throws a clear internal error when a logged action is rejected by the engine (corrupt replay)', async () => {
    const db = await freshDb();
    await seedGameRow(db, 'g3b');
    await appendStartHand(db, 'g3b', { handNumber: 1, dealerSeat: 0, seed: 42, repeatCount: 0, prevailingWind: 'east' });
    // seat 1 discarding is illegal while it's seat 0's turn.
    await appendAction(db, 'g3b', 1, { type: 'discard', seat: 1, tileId: 'bogus' });

    await expect(replayHand(db, 'g3b', 1, DEFAULT_RULES)).rejects.toThrow(/corrupt replay/);
  });
});

describe('getCurrentHandState', () => {
  it('returns null for a game with zero actions', async () => {
    const db = await freshDb();
    await seedGameRow(db, 'gEmpty');
    expect(await getCurrentHandState(db, 'gEmpty')).toBeNull();
  });
});

describe('submitAction', () => {
  it('creates a game via games.ts, submits a discard, and persists across a fresh getCurrentHandState call', async () => {
    const db = await freshDb();
    const created = await createGame(db, { displayName: 'Alice' });
    await joinGame(db, created.roomCode, { displayName: 'Bob' });
    await joinGame(db, created.roomCode, { displayName: 'Carol' });
    const j4 = await joinGame(db, created.roomCode, { displayName: 'Dave' });
    if ('error' in j4) throw new Error('unexpected join error');

    const initial = await getCurrentHandState(db, created.gameId);
    if (initial === null) throw new Error('expected an active hand after the 4th join');
    expect(initial.state.phase.type).toBe('awaiting-discard');
    if (initial.state.phase.type !== 'awaiting-discard' || initial.state.phase.drawnTile === null) {
      throw new Error('test fixture assumption broken: expected an opening drawn tile for the dealer');
    }

    const discardAction = { type: 'discard' as const, seat: 0 as Seat, tileId: initial.state.phase.drawnTile.id };
    const submitted = await submitAction(db, created.gameId, discardAction);
    if (isSubmitRuleError(submitted)) {
      throw new Error(`unexpected rule error: ${submitted.message}`);
    }

    const reloaded = await getCurrentHandState(db, created.gameId);
    expect(reloaded?.state).toEqual(submitted.state);
    expect(reloaded?.handNumber).toBe(submitted.handNumber);
    // Regression: submitAction's returned lastSeq must be the exact seq of
    // the last row folded into the state it returns (never a seq from a
    // separate, later read that could race ahead of what the caller
    // actually received) — cross-checked against the game's true latest
    // seq immediately afterward.
    expect(submitted.lastSeq).toBe(reloaded?.lastSeq);
    expect(submitted.lastSeq).toBe(await getLatestSeq(db, created.gameId));
  });

  it('rejects an illegal action (wrong seat) without writing to the log', async () => {
    const db = await freshDb();
    const created = await createGame(db, { displayName: 'Alice' });
    await joinGame(db, created.roomCode, { displayName: 'Bob' });
    await joinGame(db, created.roomCode, { displayName: 'Carol' });
    await joinGame(db, created.roomCode, { displayName: 'Dave' });

    const before = await getCurrentHandState(db, created.gameId);
    if (before === null) throw new Error('expected an active hand');

    const result = await submitAction(db, created.gameId, { type: 'discard', seat: 1, tileId: 'bogus-tile' });
    expect(isSubmitRuleError(result)).toBe(true);

    const after = await getCurrentHandState(db, created.gameId);
    expect(after?.state).toEqual(before.state);
  });

  it('returns a rule-error for a game with no active hand', async () => {
    const db = await freshDb();
    await seedGameRow(db, 'gNoHand');
    const result = await submitAction(db, 'gNoHand', { type: 'draw', seat: 0 });
    expect(isSubmitRuleError(result)).toBe(true);
  });
});

describe('applyAutoPass', () => {
  it('is a no-op when the phase is not awaiting-claims', async () => {
    const db = await freshDb();
    await seedGameRow(db, 'gNoop');
    await appendStartHand(db, 'gNoop', { handNumber: 1, dealerSeat: 0, seed: 42, repeatCount: 0, prevailingWind: 'east' });
    const state = await replayHand(db, 'gNoop', 1, DEFAULT_RULES);
    expect(state.phase.type).toBe('awaiting-discard');

    const result = await applyAutoPass(db, 'gNoop', 1, state, 1);
    expect(result).toEqual({ state, lastSeq: 1 });

    const rows = await listActionsForHand(db, 'gNoop', 1);
    expect(rows.length).toBe(1); // only the start-hand row; nothing appended
  });

  it('leaves only genuinely-option-holding seats unresponded after a submitted discard', async () => {
    const db = await freshDb();
    const created = await createGame(db, { displayName: 'Alice' });
    await joinGame(db, created.roomCode, { displayName: 'Bob' });
    await joinGame(db, created.roomCode, { displayName: 'Carol' });
    await joinGame(db, created.roomCode, { displayName: 'Dave' });

    const initial = await getCurrentHandState(db, created.gameId);
    if (initial === null) throw new Error('expected an active hand');
    if (initial.state.phase.type !== 'awaiting-discard' || initial.state.phase.drawnTile === null) {
      throw new Error('test fixture assumption broken');
    }
    const discardAction = { type: 'discard' as const, seat: 0 as Seat, tileId: initial.state.phase.drawnTile.id };
    const submitted = await submitAction(db, created.gameId, discardAction);
    if (isSubmitRuleError(submitted)) throw new Error(`unexpected rule error: ${submitted.message}`);

    // submitAction already ran applyAutoPass internally; verify the
    // invariant it guarantees: every unresponded seat in an awaiting-claims
    // phase (if any remains) genuinely has at least one legal option.
    if (submitted.state.phase.type === 'awaiting-claims') {
      const phase = submitted.state.phase;
      for (const seat of SEATS) {
        if (seat === phase.discarderSeat) continue;
        if (phase.responses[seat] !== undefined) continue;
        const hand = submitted.state.players[seat].hand;
        const hasOption =
          canWin(hand.concealedTiles, hand.melds.length, phase.discardedTile) ||
          canPung(hand, phase.discardedTile) ||
          canKongFromDiscard(hand, phase.discardedTile) ||
          canChow(hand, phase.discardedTile, seat, phase.discarderSeat).length > 0;
        expect(hasOption).toBe(true);
      }
    }
  });
});

describe('advanceToNextHand', () => {
  it('returns hand-not-over when the current hand has not ended', async () => {
    const db = await freshDb();
    await seedGameRow(db, 'gActive');
    await appendStartHand(db, 'gActive', { handNumber: 1, dealerSeat: 0, seed: 42, repeatCount: 0, prevailingWind: 'east' });

    const result = await advanceToNextHand(db, 'gActive');
    expect(result).toEqual({ error: 'hand-not-over' });
  });

  it('repeats the dealer and increments repeatCount when the dealer stays on (dealerRepeatsOnDraw: true)', async () => {
    const db = await freshDb();
    await seedGameRow(db, 'gRepeat', HIGH_RESERVE_RULES);
    await appendStartHand(db, 'gRepeat', { handNumber: 1, dealerSeat: 0, seed: 5, repeatCount: 0, prevailingWind: 'east' });

    const current = await getCurrentHandState(db, 'gRepeat');
    if (current === null) throw new Error('expected an active (already hand-over) hand');
    expect(current.state.phase.type).toBe('hand-over');

    const result = await advanceToNextHand(db, 'gRepeat');
    if ('error' in result) throw new Error(`unexpected error: ${result.error}`);
    expect(result.handNumber).toBe(2);
    expect(result.state.dealerSeat).toBe(0);
    expect(result.state.repeatCount).toBe(1);
    // Regression: lastSeq must reflect the exact same read that produced
    // result.state (hand 2's own start-hand row), never a separate,
    // potentially racy getLatestSeq call.
    expect(result.lastSeq).toBe(await getLatestSeq(db, 'gRepeat'));

    const rows = await listActionsForHand(db, 'gRepeat', 2);
    const payload = rows[0].payload as StartHandPayload;
    expect(payload.dealerSeat).toBe(0);
    expect(payload.repeatCount).toBe(1);
    expect(payload.prevailingWind).toBe('east'); // no rotation, wind unchanged
  });

  it('rotates the dealer and resets repeatCount when dealerRepeatsOnDraw is false', async () => {
    const db = await freshDb();
    const rules: RulesConfig = { ...HIGH_RESERVE_RULES, dealerRepeatsOnDraw: false };
    await seedGameRow(db, 'gRotate', rules);
    await appendStartHand(db, 'gRotate', { handNumber: 1, dealerSeat: 0, seed: 5, repeatCount: 0, prevailingWind: 'east' });

    const result = await advanceToNextHand(db, 'gRotate');
    if ('error' in result) throw new Error(`unexpected error: ${result.error}`);
    expect(result.handNumber).toBe(2);
    expect(result.state.dealerSeat).toBe(1);
    expect(result.state.repeatCount).toBe(0);
  });

  it('never produces duplicate start-hand rows for the same hand under two genuinely concurrent advanceToNextHand calls', async () => {
    // Note on reachability: advanceToNextHand's `existingNextHandRows`
    // no-op check can only be hit via real interleaving of two in-flight
    // calls (each snapshots its own `state`/`handNumber` from its own
    // `getCurrentHandState()` call, then later re-checks for a next-hand row
    // that a *concurrent* caller may have created in the meantime). It is
    // NOT reachable by pre-seeding hand N+1's row before a single sequential
    // call: getCurrentHandState always resolves the *current* hand via
    // `MAX(hand_number)`, so a pre-existing hand N+1 row simply becomes the
    // new "current" hand for that call (verified directly: doing so here
    // cascades to creating hand 3, since hand 2 is also instantly
    // hand-over under HIGH_RESERVE_RULES). So this test drives the race for
    // real via Promise.all rather than simulating it with pre-inserted rows,
    // and asserts the safety invariant that must hold regardless of which
    // caller's append actually lands first: exactly one start-hand row per
    // hand_number, never a duplicate.
    const db = await freshDb();
    await seedGameRow(db, 'gRace', HIGH_RESERVE_RULES);
    await appendStartHand(db, 'gRace', { handNumber: 1, dealerSeat: 0, seed: 5, repeatCount: 0, prevailingWind: 'east' });

    const results = await Promise.allSettled([
      advanceToNextHand(db, 'gRace'),
      advanceToNextHand(db, 'gRace'),
    ]);
    for (const r of results) {
      if (r.status === 'rejected') {
        throw new Error(`advanceToNextHand rejected under concurrent racing: ${String(r.reason)}`);
      }
    }

    const dupCheck = await db.execute({
      sql: `SELECT hand_number FROM actions WHERE game_id = ? AND action_type = 'start-hand'
            GROUP BY hand_number HAVING COUNT(*) > 1`,
      args: ['gRace'],
    });
    expect(dupCheck.rows.length).toBe(0);
  });

  it('advances the prevailing wind once the dealer completes a full rotation back to seat 0', async () => {
    const db = await freshDb();
    const rules: RulesConfig = { ...HIGH_RESERVE_RULES, dealerRepeatsOnDraw: false };
    await seedGameRow(db, 'gWind', rules);
    // Hands 1-3: synthetic dealer history 0, 1, 2 (never individually replayed).
    await seedDummyStartHand(db, 'gWind', 1, 0);
    await seedDummyStartHand(db, 'gWind', 2, 1);
    await seedDummyStartHand(db, 'gWind', 3, 2);
    // Hand 4 is the real current hand: dealer 3, instantly exhausts.
    await appendStartHand(db, 'gWind', { handNumber: 4, dealerSeat: 3, seed: 9, repeatCount: 0, prevailingWind: 'east' });

    const result = await advanceToNextHand(db, 'gWind');
    if ('error' in result) throw new Error(`unexpected error: ${result.error}`);
    expect(result.handNumber).toBe(5);
    expect(result.state.dealerSeat).toBe(0); // rotated all the way back to seat 0

    const rows = await listActionsForHand(db, 'gWind', 5);
    const payload = rows[0].payload as StartHandPayload;
    expect(payload.prevailingWind).toBe('south');
  });

  it('flips the game to finished once the wind table is exhausted past north', async () => {
    const db = await freshDb();
    const rules: RulesConfig = { ...HIGH_RESERVE_RULES, dealerRepeatsOnDraw: false };
    await seedGameRow(db, 'gFinish', rules);

    // Synthetic dealer history for hands 1-27: dealerSeat = (h-1) % 4, giving
    // exactly 6 "returns to seat 0" transitions by hand 25 (at hands 5, 9,
    // 13, 17, 21, 25), with none added by hands 26-27.
    for (let h = 1; h <= 27; h++) {
      await seedDummyStartHand(db, 'gFinish', h, ((h - 1) % 4) as Seat);
    }
    // Hand 28 is the real current hand: dealer 3 (consistent with the (h-1)%4
    // pattern), instantly exhausts. Advancing from here rotates the dealer
    // back to seat 0 for the 7th time, exhausting the wind progression.
    await appendStartHand(db, 'gFinish', { handNumber: 28, dealerSeat: 3, seed: 11, repeatCount: 0, prevailingWind: 'north' });

    const result = await advanceToNextHand(db, 'gFinish');
    expect(result).toEqual({ error: 'game-finished' });

    const gameRow = await db.execute({ sql: 'SELECT status FROM games WHERE id = ?', args: ['gFinish'] });
    expect(String(gameRow.rows[0].status)).toBe('finished');

    const rows29 = await listActionsForHand(db, 'gFinish', 29);
    expect(rows29.length).toBe(0); // no hand 29 was started
  });
});
