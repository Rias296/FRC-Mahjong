import { createClient, type Client } from '@libsql/client';
import { describe, expect, it } from 'vitest';
import { runMigrations } from './migrations';
import { createGame, joinGame } from './games';
import { appendAction, appendStartHand, getLatestSeq, listActionsForHand, type StartHandPayload } from './actions-log';
import {
  advanceToNextHand,
  applyAutoPass,
  deriveMatchContinuation,
  finalizeMatchIfOver,
  getCurrentHandState,
  getMatchSnapshot,
  replayHand,
  submitAction,
} from './replay';
import { applyAction, isRuleError, startHand, type GameState, type RuleError } from '../engine/game-state';
import { DEFAULT_RULES, type RulesConfig } from '../engine/rules-config';
import { initialSeatTotals, sumPaymentLegs } from '../engine/scoring';
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

// A startingPoints low enough that a single ordinary payment leg (basePoints
// 3000 + at least 1 tai * perTai 1000 = at least 4000) drives the payer's
// total below zero, giving a cheap, deterministic bust without needing an
// enormous hand-tai value or many hands.
const BUST_RULES: RulesConfig = { ...DEFAULT_RULES, points: { ...DEFAULT_RULES.points, startingPoints: 100 } };

/**
 * Plays out the known seed-44703/dealer-0 fixture (reused throughout this
 * file and the actions/state route tests) to a real win: discarding
 * 'tiao-7-4' leaves seat 2 with a real hu option; seat 1 passes; seat 2
 * claims hu. Returns the winning submitAction result.
 */
async function playSeed44703Win(
  db: Client,
  gameId: string,
): Promise<{ state: GameState; handNumber: number; lastSeq: number }> {
  const discard = await submitAction(db, gameId, { type: 'discard', seat: 0, tileId: 'tiao-7-4' });
  if (isSubmitRuleError(discard)) throw new Error(`unexpected rule error: ${discard.message}`);
  const pass1 = await submitAction(db, gameId, { type: 'pass', seat: 1 });
  if (isSubmitRuleError(pass1)) throw new Error(`unexpected rule error: ${pass1.message}`);
  const win = await submitAction(db, gameId, { type: 'claim', seat: 2, claim: { type: 'hu' } });
  if (isSubmitRuleError(win)) throw new Error(`unexpected rule error: ${win.message}`);
  if (win.state.phase.type !== 'hand-over' || win.state.phase.result.kind !== 'win') {
    throw new Error('test fixture assumption broken: expected a win result');
  }
  return win;
}

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

  it('returns windowOpenedAt/lastActionAt/rules from the same read', async () => {
    const db = await freshDb();
    await seedGameRow(db, 'gWin');
    await appendStartHand(db, 'gWin', { handNumber: 1, dealerSeat: 0, seed: 42, repeatCount: 0, prevailingWind: 'east' });

    const afterStart = await getCurrentHandState(db, 'gWin');
    if (afterStart === null) throw new Error('expected an active hand');
    // Right after start-hand, the opening window (the dealer's
    // awaiting-discard) opened exactly at the start-hand row's own
    // createdAt, which — with only one row so far — is also lastActionAt.
    expect(afterStart.windowOpenedAt).toBe(afterStart.lastActionAt);
    expect(afterStart.rules).toEqual(DEFAULT_RULES);
    expect(afterStart.state.phase.type).toBe('awaiting-discard');

    if (afterStart.state.phase.type !== 'awaiting-discard' || afterStart.state.phase.drawnTile === null) {
      throw new Error('test fixture assumption broken: expected awaiting-discard with a drawn tile');
    }
    const discard = await submitAction(db, 'gWin', {
      type: 'discard',
      seat: 0,
      tileId: afterStart.state.phase.drawnTile.id,
    });
    if (isSubmitRuleError(discard)) throw new Error(`unexpected rule error: ${discard.message}`);

    const afterDiscard = await getCurrentHandState(db, 'gWin');
    if (afterDiscard === null) throw new Error('expected an active hand');
    // The discard changed the window (awaiting-discard -> awaiting-claims,
    // or straight to the next seat's awaiting-draw if nobody has any legal
    // claim) — windowOpenedAt must have advanced past (or, at worst, tied)
    // the start-hand row's createdAt to reflect the NEW window, and can
    // never be AFTER lastActionAt (the latest row overall): submitAction's
    // own applyAutoPass may append a further zero-option seat's pass row
    // moments after the discard — that row doesn't change the window
    // signature (a mid-window response, per this module's own doc comment),
    // so it advances lastActionAt without moving windowOpenedAt, which is
    // exactly the "mid-window responses don't move windowOpenedAt" property
    // src/server/turn-timer.ts depends on.
    expect(afterDiscard.windowOpenedAt).toBeGreaterThanOrEqual(afterStart.windowOpenedAt);
    expect(afterDiscard.windowOpenedAt).toBeLessThanOrEqual(afterDiscard.lastActionAt);
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

    // Synthetic dealer history for hands 1-15: dealerSeat = (h-1) % 4, giving
    // exactly 3 "returns to seat 0" transitions by hand 13 (at hands 5, 9,
    // 13 — completing the East, South, and West rounds), with none added by
    // hands 14-15.
    for (let h = 1; h <= 15; h++) {
      await seedDummyStartHand(db, 'gFinish', h, ((h - 1) % 4) as Seat);
    }
    // Hand 16 is the real current hand: dealer 3 (consistent with the (h-1)%4
    // pattern), instantly exhausts. Advancing from here rotates the dealer
    // back to seat 0 for the 4th time, exhausting the wind progression
    // (E -> S -> W -> N, per RULES.md §2 — the corrected 4-rotation length).
    await appendStartHand(db, 'gFinish', { handNumber: 16, dealerSeat: 3, seed: 11, repeatCount: 0, prevailingWind: 'north' });

    const result = await advanceToNextHand(db, 'gFinish');
    expect(result).toEqual({ error: 'game-finished' });

    const gameRow = await db.execute({ sql: 'SELECT status FROM games WHERE id = ?', args: ['gFinish'] });
    expect(String(gameRow.rows[0].status)).toBe('finished');

    const rows17 = await listActionsForHand(db, 'gFinish', 17);
    expect(rows17.length).toBe(0); // no hand 17 was started
  });

  it('returns game-finished and flips status when a seat is at or below zero after a hand (bust, checked before wind exhaustion)', async () => {
    const db = await freshDb();
    const gameId = 'gBust';
    await seedGameRow(db, gameId, BUST_RULES);
    await appendStartHand(db, gameId, { handNumber: 1, dealerSeat: 0, seed: 44703, repeatCount: 0, prevailingWind: 'east' });

    const win = await playSeed44703Win(db, gameId);
    if (win.state.phase.type !== 'hand-over' || win.state.phase.result.kind !== 'win') {
      throw new Error('test fixture assumption broken');
    }
    // Sanity: with BUST_RULES' startingPoints of 100, the payer's leg
    // (basePoints 3000 + at least 1 tai) genuinely drives them negative.
    const payerLeg = win.state.phase.result.legs[0];
    expect(BUST_RULES.points.startingPoints - payerLeg.amount).toBeLessThanOrEqual(0);

    const result = await advanceToNextHand(db, gameId);
    expect(result).toEqual({ error: 'game-finished' });

    const gameRow = await db.execute({ sql: 'SELECT status FROM games WHERE id = ?', args: [gameId] });
    expect(String(gameRow.rows[0].status)).toBe('finished');

    // No hand 2 was dealt — the bust check ran before appendStartHand.
    const rows2 = await listActionsForHand(db, gameId, 2);
    expect(rows2.length).toBe(0);
  });

  it('still starts the next hand normally when all seats are positive and wind rounds remain (a win under default startingPoints)', async () => {
    const db = await freshDb();
    const gameId = 'gWinNoBust';
    await seedGameRow(db, gameId, DEFAULT_RULES);
    await appendStartHand(db, gameId, { handNumber: 1, dealerSeat: 0, seed: 44703, repeatCount: 0, prevailingWind: 'east' });

    await playSeed44703Win(db, gameId);

    const result = await advanceToNextHand(db, gameId);
    if ('error' in result) throw new Error(`unexpected error: ${result.error}`);
    expect(result.handNumber).toBe(2);

    const gameRow = await db.execute({ sql: 'SELECT status FROM games WHERE id = ?', args: [gameId] });
    expect(String(gameRow.rows[0].status)).toBe('in-progress');
  });

  it('called twice in a row after a busting hand returns game-finished both times and appends no new start-hand row the second time', async () => {
    const db = await freshDb();
    const gameId = 'gBustTwice';
    await seedGameRow(db, gameId, BUST_RULES);
    await appendStartHand(db, gameId, { handNumber: 1, dealerSeat: 0, seed: 44703, repeatCount: 0, prevailingWind: 'east' });
    await playSeed44703Win(db, gameId);

    const first = await advanceToNextHand(db, gameId);
    expect(first).toEqual({ error: 'game-finished' });
    const second = await advanceToNextHand(db, gameId);
    expect(second).toEqual({ error: 'game-finished' });

    const rows2 = await listActionsForHand(db, gameId, 2);
    expect(rows2.length).toBe(0);

    const startHandRows = await db.execute({
      sql: `SELECT COUNT(*) AS n FROM actions WHERE game_id = ? AND action_type = 'start-hand'`,
      args: [gameId],
    });
    expect(Number(startHandRows.rows[0].n)).toBe(1); // only hand 1's start-hand row
  });
});

describe('deriveMatchContinuation', () => {
  it('returns over when any seat has busted, even when wind rounds would otherwise remain', async () => {
    const db = await freshDb();
    const gameId = 'gDeriveBust';
    await seedGameRow(db, gameId, BUST_RULES);
    await appendStartHand(db, gameId, { handNumber: 1, dealerSeat: 0, seed: 44703, repeatCount: 0, prevailingWind: 'east' });
    await playSeed44703Win(db, gameId);

    const snapshot = await getMatchSnapshot(db, gameId);
    if (snapshot === null) throw new Error('expected a non-null snapshot');
    const continuation = await deriveMatchContinuation(db, gameId, snapshot.handNumber, snapshot.state, snapshot.matchPoints);
    expect(continuation).toEqual({ kind: 'over' });
  });

  it('returns continue with the unchanged prevailing wind when nobody busted and the dealer has not rotated back to seat 0', async () => {
    const db = await freshDb();
    const gameId = 'gDeriveContinue';
    await seedGameRow(db, gameId, DEFAULT_RULES);
    await appendStartHand(db, gameId, { handNumber: 1, dealerSeat: 0, seed: 44703, repeatCount: 0, prevailingWind: 'east' });
    await playSeed44703Win(db, gameId);

    const snapshot = await getMatchSnapshot(db, gameId);
    if (snapshot === null) throw new Error('expected a non-null snapshot');
    const continuation = await deriveMatchContinuation(db, gameId, snapshot.handNumber, snapshot.state, snapshot.matchPoints);
    // Seed-44703's win result: seat 2 wins, next dealer is not seat 0 (seat 0
    // was already dealer and doesn't stay on after losing this leg via
    // discard-win with a non-dealer winner) — see game-state's dealer-
    // rotation rules. Whichever seat is next, the assertion below only
    // depends on there being no rotation-to-seat-0 this time.
    if (continuation.kind !== 'continue') {
      throw new Error(`test fixture assumption broken: expected 'continue', got ${JSON.stringify(continuation)}`);
    }
    expect(continuation.nextWind).toBe('east');
  });
});

describe('finalizeMatchIfOver', () => {
  it('flips games.status to finished for a busting hand-over snapshot', async () => {
    const db = await freshDb();
    const gameId = 'gFinalizeBust';
    await seedGameRow(db, gameId, BUST_RULES);
    await appendStartHand(db, gameId, { handNumber: 1, dealerSeat: 0, seed: 44703, repeatCount: 0, prevailingWind: 'east' });
    await playSeed44703Win(db, gameId);

    const snapshot = await getMatchSnapshot(db, gameId);
    if (snapshot === null) throw new Error('expected a non-null snapshot');

    const result = await finalizeMatchIfOver(db, gameId, snapshot);
    expect(result).toBe('finished');

    const gameRow = await db.execute({ sql: 'SELECT status FROM games WHERE id = ?', args: [gameId] });
    expect(String(gameRow.rows[0].status)).toBe('finished');
  });

  it('is a no-op when the snapshot is not in the hand-over phase', async () => {
    const db = await freshDb();
    const gameId = 'gFinalizeActive';
    await seedGameRow(db, gameId, DEFAULT_RULES);
    await appendStartHand(db, gameId, { handNumber: 1, dealerSeat: 0, seed: 42, repeatCount: 0, prevailingWind: 'east' });

    const snapshot = await getMatchSnapshot(db, gameId);
    if (snapshot === null) throw new Error('expected a non-null snapshot');
    expect(snapshot.state.phase.type).not.toBe('hand-over'); // awaiting-discard on the opening draw

    const result = await finalizeMatchIfOver(db, gameId, snapshot);
    expect(result).toBe('in-progress');

    const gameRow = await db.execute({ sql: 'SELECT status FROM games WHERE id = ?', args: [gameId] });
    expect(String(gameRow.rows[0].status)).toBe('in-progress');
  });

  it('is a no-op when in hand-over but nobody busted and wind rounds remain', async () => {
    const db = await freshDb();
    const gameId = 'gFinalizeNoBust';
    await seedGameRow(db, gameId, DEFAULT_RULES);
    await appendStartHand(db, gameId, { handNumber: 1, dealerSeat: 0, seed: 44703, repeatCount: 0, prevailingWind: 'east' });
    await playSeed44703Win(db, gameId);

    const snapshot = await getMatchSnapshot(db, gameId);
    if (snapshot === null) throw new Error('expected a non-null snapshot');
    expect(snapshot.state.phase.type).toBe('hand-over');

    const result = await finalizeMatchIfOver(db, gameId, snapshot);
    expect(result).toBe('in-progress');

    const gameRow = await db.execute({ sql: 'SELECT status FROM games WHERE id = ?', args: [gameId] });
    expect(String(gameRow.rows[0].status)).toBe('in-progress');
  });
});

describe('getMatchSnapshot', () => {
  it('returns null for a game with no actions', async () => {
    const db = await freshDb();
    await seedGameRow(db, 'gMatchEmpty');
    expect(await getMatchSnapshot(db, 'gMatchEmpty')).toBeNull();
  });

  it(
    "starts every seat at rules.points.startingPoints (not 0) for a single in-progress hand, and its " +
      'state/lastSeq match getCurrentHandState for the same game',
    async () => {
      const db = await freshDb();
      const gameId = 'gMatchInProgress';
      await seedGameRow(db, gameId);
      await appendStartHand(db, gameId, { handNumber: 1, dealerSeat: 0, seed: 42, repeatCount: 0, prevailingWind: 'east' });

      const snapshot = await getMatchSnapshot(db, gameId);
      const current = await getCurrentHandState(db, gameId);
      if (snapshot === null || current === null) {
        throw new Error('expected both getMatchSnapshot and getCurrentHandState to be non-null');
      }

      expect(snapshot.matchPoints).toEqual(initialSeatTotals(DEFAULT_RULES));
      expect(snapshot.matchPoints).toEqual([
        DEFAULT_RULES.points.startingPoints,
        DEFAULT_RULES.points.startingPoints,
        DEFAULT_RULES.points.startingPoints,
        DEFAULT_RULES.points.startingPoints,
      ]);
      expect(snapshot.state).toEqual(current.state);
      expect(snapshot.handNumber).toBe(current.handNumber);
      expect(snapshot.lastSeq).toBe(current.lastSeq);
      expect(snapshot.prevailingWind).toBe('east');
      // Additive fields: windowOpenedAt/lastActionAt/rules must agree with
      // getCurrentHandState's own read of the exact same single-hand log.
      expect(snapshot.windowOpenedAt).toBe(current.windowOpenedAt);
      expect(snapshot.lastActionAt).toBe(current.lastActionAt);
      expect(snapshot.rules).toEqual(current.rules);
    },
  );

  it("folds a won hand's legs into pool-scale matchPoints (starting from startingPoints) after advancing to the next hand", async () => {
    const db = await freshDb();
    const gameId = 'gMatchWin';
    await seedGameRow(db, gameId);
    // Reuses the known seed-44703/dealer-0 fixture from auto-pass-mixed.test.ts:
    // discarding 'tiao-7-4' leaves seat 2 with a real hu option; seat 1 passes
    // its pung option, seat 2 claims hu, producing a real win result.
    await appendStartHand(db, gameId, { handNumber: 1, dealerSeat: 0, seed: 44703, repeatCount: 0, prevailingWind: 'east' });

    const discard = await submitAction(db, gameId, { type: 'discard', seat: 0, tileId: 'tiao-7-4' });
    if (isSubmitRuleError(discard)) throw new Error(`unexpected rule error: ${discard.message}`);
    const pass1 = await submitAction(db, gameId, { type: 'pass', seat: 1 });
    if (isSubmitRuleError(pass1)) throw new Error(`unexpected rule error: ${pass1.message}`);
    const win = await submitAction(db, gameId, { type: 'claim', seat: 2, claim: { type: 'hu' } });
    if (isSubmitRuleError(win)) throw new Error(`unexpected rule error: ${win.message}`);
    if (win.state.phase.type !== 'hand-over' || win.state.phase.result.kind !== 'win') {
      throw new Error('test fixture assumption broken: expected a win result');
    }
    const expectedTotals = sumPaymentLegs(win.state.phase.result.legs, initialSeatTotals(DEFAULT_RULES));

    const advanced = await advanceToNextHand(db, gameId);
    if ('error' in advanced) throw new Error(`unexpected error: ${advanced.error}`);

    const snapshot = await getMatchSnapshot(db, gameId);
    if (snapshot === null) throw new Error('expected a non-null snapshot');
    expect(snapshot.matchPoints).toEqual(expectedTotals);
    // Pool-scale sanity: the winner's total genuinely exceeds startingPoints
    // and at least one payer's total genuinely falls below it — proves this
    // isn't accidentally still delta-scale zeros.
    const winnerSeat = win.state.phase.result.winners[0].seat;
    expect(snapshot.matchPoints[winnerSeat]).toBeGreaterThan(DEFAULT_RULES.points.startingPoints);
    expect(snapshot.handNumber).toBe(2);
  });

  it('leaves matchPoints at startingPoints (unchanged) across an exhaustive-draw hand', async () => {
    const db = await freshDb();
    const gameId = 'gMatchDraw';
    await seedGameRow(db, gameId, HIGH_RESERVE_RULES);
    await appendStartHand(db, gameId, { handNumber: 1, dealerSeat: 0, seed: 5, repeatCount: 0, prevailingWind: 'east' });

    const advanced = await advanceToNextHand(db, gameId);
    if ('error' in advanced) throw new Error(`unexpected error: ${advanced.error}`);

    const snapshot = await getMatchSnapshot(db, gameId);
    if (snapshot === null) throw new Error('expected a non-null snapshot');
    expect(snapshot.matchPoints).toEqual(initialSeatTotals(HIGH_RESERVE_RULES));
    expect(snapshot.handNumber).toBe(2);
  });

  it('normalizes a legacy rules_config lacking points into a fully-populated RulesConfig before folding matchPoints', async () => {
    const db = await freshDb();
    const gameId = 'gMatchLegacyRules';
    const legacyRulesJson = JSON.stringify({
      deadWallReserve: 16,
      minTaiToWin: 0,
      basePoints: 3,
      pointsPerTai: 1,
      selfDrawTai: 1,
      robKongTai: 1,
      robKong: { enabled: true, robConcealedKong: false },
      sacredDiscard: { enabled: true, scope: 'until-next-self-discard' },
      multipleWinners: false,
      dealerRepeatsOnDraw: true,
      dealerBaseTai: 1,
      dealerRepeatBonusTaiPerRepeat: 2,
      // Deliberately no `points` key at all — a pre-round-2 persisted row.
    });
    await db.execute({
      sql: `INSERT INTO games (id, room_code, status, rules_config, engine_version, created_at, updated_at)
            VALUES (?, ?, 'in-progress', ?, '0.1.0', 1, 1)`,
      args: [gameId, gameId.slice(0, 6).toUpperCase().padEnd(6, 'X'), legacyRulesJson],
    });
    await appendStartHand(db, gameId, { handNumber: 1, dealerSeat: 0, seed: 42, repeatCount: 0, prevailingWind: 'east' });

    const snapshot = await getMatchSnapshot(db, gameId);
    if (snapshot === null) throw new Error('expected a non-null snapshot');
    // Normalized to DEFAULT_RULES.points.startingPoints for every seat, not
    // NaN/undefined-derived garbage from a missing `points` sub-object.
    expect(snapshot.matchPoints).toEqual(initialSeatTotals(DEFAULT_RULES));
  });

  it("derives prevailingWind correctly from the current hand's start-hand payload", async () => {
    const db = await freshDb();
    const gameId = 'gMatchWind';
    await seedGameRow(db, gameId);
    await appendStartHand(db, gameId, { handNumber: 1, dealerSeat: 0, seed: 42, repeatCount: 0, prevailingWind: 'south' });

    const snapshot = await getMatchSnapshot(db, gameId);
    if (snapshot === null) throw new Error('expected a non-null snapshot');
    expect(snapshot.prevailingWind).toBe('south');
  });
});
