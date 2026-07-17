/**
 * Coverage for src/server/turn-timer.ts, modeled off auto-pass-mixed.test.ts's
 * structure (real gameplay through submitAction against a `:memory:` DB, not
 * hand-unit-tested synthetic GameState, except where a specific phase shape
 * — e.g. awaiting-rob-kong, or the "only the drawn tile remains" discard
 * edge case — isn't cheaply reachable through real play, in which case a
 * clearly-labeled synthetic GameState override is used instead).
 *
 * Fixture: seed 44703, dealer 0 (reused from auto-pass-mixed.test.ts).
 * Dealer's opening hand, when discarding tile 'tiao-7-4', produces:
 *   - seat 2: a real hu option
 *   - seat 1: a real pung option (no hu)
 *   - seat 3: zero options (auto-passed by submitAction's own applyAutoPass)
 */
import { createClient, type Client } from '@libsql/client';
import { describe, expect, it, vi } from 'vitest';
import { runMigrations } from './migrations';
import { appendActionAtSeq, appendStartHand, listActionsForHand } from './actions-log';
import { getCurrentHandState, submitAction } from './replay';
import { applyTurnTimeouts, computeTurnDeadline, pickTimeoutAction } from './turn-timer';
import { DEFAULT_RULES, type RulesConfig } from '../engine/rules-config';
import * as gameStateModule from '../engine/game-state';
import { startHand, type GameState, type RuleError } from '../engine/game-state';
import { sortTilesForDisplay } from '../lib/table/tile-display';

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

/** Backdates every action row for `gameId` by `msAgo`, simulating an old window. */
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

/** Plays the known seed-44703/dealer-0 fixture to a real win via 3 manual actions. */
async function winSeed44703(
  db: Client,
  gameId: string,
): Promise<{ state: GameState; handNumber: number; lastSeq: number }> {
  const discard = await submitAction(db, gameId, { type: 'discard', seat: 0, tileId: 'tiao-7-4' });
  if (isSubmitRuleError(discard)) throw new Error(`unexpected rule error: ${discard.message}`);
  const pass1 = await submitAction(db, gameId, { type: 'pass', seat: 1 });
  if (isSubmitRuleError(pass1)) throw new Error(`unexpected rule error: ${pass1.message}`);
  const win = await submitAction(db, gameId, { type: 'claim', seat: 2, claim: { type: 'hu' } });
  if (isSubmitRuleError(win)) throw new Error(`unexpected rule error: ${win.message}`);
  return win;
}

// --- computeTurnDeadline -----------------------------------------------------

describe('computeTurnDeadline', () => {
  const windowOpenedAt = 1_000_000;

  it('returns null for hand-over, regardless of status/rules', () => {
    expect(computeTurnDeadline(DEFAULT_RULES, windowOpenedAt, 'hand-over', 'in-progress')).toBeNull();
    expect(computeTurnDeadline(DEFAULT_RULES, windowOpenedAt, 'hand-over', 'finished')).toBeNull();
  });

  it('returns null when status is not in-progress', () => {
    expect(computeTurnDeadline(DEFAULT_RULES, windowOpenedAt, 'awaiting-draw', 'waiting-for-players')).toBeNull();
    expect(computeTurnDeadline(DEFAULT_RULES, windowOpenedAt, 'awaiting-draw', 'finished')).toBeNull();
  });

  it('returns null when turnTimerSeconds <= 0 (disabled)', () => {
    const disabled: RulesConfig = { ...DEFAULT_RULES, turnTimerSeconds: 0 };
    expect(computeTurnDeadline(disabled, windowOpenedAt, 'awaiting-draw', 'in-progress')).toBeNull();
    const negative: RulesConfig = { ...DEFAULT_RULES, turnTimerSeconds: -5 };
    expect(computeTurnDeadline(negative, windowOpenedAt, 'awaiting-discard', 'in-progress')).toBeNull();
  });

  it('returns windowOpenedAt + turnTimerSeconds*1000 for every non-hand-over phase type when in-progress', () => {
    for (const phaseType of ['awaiting-draw', 'awaiting-discard', 'awaiting-claims', 'awaiting-rob-kong'] as const) {
      expect(computeTurnDeadline(DEFAULT_RULES, windowOpenedAt, phaseType, 'in-progress')).toBe(
        windowOpenedAt + DEFAULT_RULES.turnTimerSeconds * 1000,
      );
    }
  });
});

// --- pickTimeoutAction --------------------------------------------------------

describe('pickTimeoutAction', () => {
  it('returns null for hand-over', async () => {
    const db = await freshDb();
    const gameId = 'ptHandOver';
    await seedSeed44703Hand(db, gameId);
    const win = await winSeed44703(db, gameId);
    expect(win.state.phase.type).toBe('hand-over');
    expect(pickTimeoutAction(win.state)).toBeNull();
  });

  it('awaiting-draw: draws for the current turn seat', async () => {
    const db = await freshDb();
    const gameId = 'ptDraw';
    await seedSeed44703Hand(db, gameId);

    const discard = await submitAction(db, gameId, { type: 'discard', seat: 0, tileId: 'tiao-7-4' });
    if (isSubmitRuleError(discard)) throw new Error(discard.message);
    const pass1 = await submitAction(db, gameId, { type: 'pass', seat: 1 });
    if (isSubmitRuleError(pass1)) throw new Error(pass1.message);
    const pass2 = await submitAction(db, gameId, { type: 'pass', seat: 2 });
    if (isSubmitRuleError(pass2)) throw new Error(pass2.message);

    expect(pass2.state.phase.type).toBe('awaiting-draw');
    expect(pass2.state.currentTurnSeat).toBe(1);
    expect(pickTimeoutAction(pass2.state)).toEqual({ type: 'draw', seat: 1, timedOut: true });
  });

  it('awaiting-discard: discards the rightmost display-order tile excluding the just-drawn tile', async () => {
    const db = await freshDb();
    const gameId = 'ptDiscard';
    await seedSeed44703Hand(db, gameId);

    const discard = await submitAction(db, gameId, { type: 'discard', seat: 0, tileId: 'tiao-7-4' });
    if (isSubmitRuleError(discard)) throw new Error(discard.message);
    const pass1 = await submitAction(db, gameId, { type: 'pass', seat: 1 });
    if (isSubmitRuleError(pass1)) throw new Error(pass1.message);
    const pass2 = await submitAction(db, gameId, { type: 'pass', seat: 2 });
    if (isSubmitRuleError(pass2)) throw new Error(pass2.message);
    const draw1 = await submitAction(db, gameId, { type: 'draw', seat: 1 });
    if (isSubmitRuleError(draw1)) throw new Error(draw1.message);

    if (draw1.state.phase.type !== 'awaiting-discard' || draw1.state.phase.drawnTile === null) {
      throw new Error('test fixture assumption broken: expected awaiting-discard with a drawn tile');
    }
    const drawnTile = draw1.state.phase.drawnTile;
    const hand = draw1.state.players[1].hand;
    const expectedCandidates = hand.concealedTiles.filter((t) => t.id !== drawnTile.id);
    const expectedSorted = sortTilesForDisplay(expectedCandidates);
    const expectedTileId = expectedSorted[expectedSorted.length - 1].id;

    expect(pickTimeoutAction(draw1.state)).toEqual({
      type: 'discard',
      seat: 1,
      tileId: expectedTileId,
      timedOut: true,
    });
  });

  it('awaiting-discard edge case: discards the drawn tile itself when it is the only concealed tile remaining', () => {
    const base = startHand(0, 44703, DEFAULT_RULES, 0);
    const soleTile = base.players[0].hand.concealedTiles[0];
    const synthetic: GameState = {
      ...base,
      currentTurnSeat: 0,
      phase: { type: 'awaiting-discard', drawnTile: soleTile },
      players: [
        { ...base.players[0], hand: { concealedTiles: [soleTile], melds: base.players[0].hand.melds } },
        base.players[1],
        base.players[2],
        base.players[3],
      ],
    };
    expect(pickTimeoutAction(synthetic)).toEqual({ type: 'discard', seat: 0, tileId: soleTile.id, timedOut: true });
  });

  it('awaiting-claims: passes the first (lowest-seat) unresponded non-discarder seat', async () => {
    const db = await freshDb();
    const gameId = 'ptClaims';
    await seedSeed44703Hand(db, gameId);

    const discard = await submitAction(db, gameId, { type: 'discard', seat: 0, tileId: 'tiao-7-4' });
    if (isSubmitRuleError(discard)) throw new Error(discard.message);
    if (discard.state.phase.type !== 'awaiting-claims') throw new Error('unreachable');
    // seat 3 was already auto-passed (zero options) by submitAction's own
    // applyAutoPass; seat 1 is the lowest still-unresponded non-discarder.
    expect(discard.state.phase.responses).toEqual({ 3: 'pass' });

    expect(pickTimeoutAction(discard.state)).toEqual({ type: 'pass', seat: 1, timedOut: true });
  });

  it('awaiting-claims: returns null once every non-discarder seat has responded', async () => {
    const db = await freshDb();
    const gameId = 'ptClaimsDone';
    await seedSeed44703Hand(db, gameId);

    const discard = await submitAction(db, gameId, { type: 'discard', seat: 0, tileId: 'tiao-7-4' });
    if (isSubmitRuleError(discard)) throw new Error(discard.message);
    const pass1 = await submitAction(db, gameId, { type: 'pass', seat: 1 });
    if (isSubmitRuleError(pass1)) throw new Error(pass1.message);
    if (pass1.state.phase.type !== 'awaiting-claims') throw new Error('unreachable');

    // The real window resolves the instant the 3rd response lands, so an
    // "awaiting-claims with 0 unresponded seats" GameState only exists
    // transiently inside the engine's own handlePass/handleClaim before
    // resolution — not independently reachable through real play. A
    // clearly-labeled synthetic override reproduces that exact moment to
    // test pickTimeoutAction's null-return branch in isolation.
    const allResponded: GameState = {
      ...pass1.state,
      phase: { ...pass1.state.phase, responses: { ...pass1.state.phase.responses, 2: 'pass' } },
    };
    expect(pickTimeoutAction(allResponded)).toBeNull();
  });

  it('awaiting-rob-kong: passes the first unresponded eligible robber, and returns null once all have responded', () => {
    const base = startHand(0, 44703, DEFAULT_RULES, 0);
    const kongTile = base.players[0].hand.concealedTiles[0];
    const robKongPhase = {
      type: 'awaiting-rob-kong' as const,
      declarerSeat: 0 as const,
      kongTile,
      kongType: 'added' as const,
      pendingConcealedKongTiles: null,
      eligibleRobbers: [1, 2, 3] as const,
      responses: { 1: 'pass' as const },
    };
    const synthetic: GameState = { ...base, phase: robKongPhase };
    expect(pickTimeoutAction(synthetic)).toEqual({ type: 'pass', seat: 2, timedOut: true });

    const allResponded: GameState = {
      ...base,
      phase: { ...robKongPhase, responses: { 1: 'pass' as const, 2: 'pass' as const, 3: 'rob' as const } },
    };
    expect(pickTimeoutAction(allResponded)).toBeNull();
  });
});

// --- applyTurnTimeouts ---------------------------------------------------------

describe('applyTurnTimeouts', () => {
  const TIMER_RULES: RulesConfig = { ...DEFAULT_RULES, turnTimerSeconds: 5 };

  it('is a no-op before the deadline has passed', async () => {
    const db = await freshDb();
    const gameId = 'atNoOp';
    await seedSeed44703Hand(db, gameId, TIMER_RULES);

    const before = await getCurrentHandState(db, gameId);
    if (before === null) throw new Error('expected an active hand');

    await applyTurnTimeouts(db, gameId);

    const after = await getCurrentHandState(db, gameId);
    if (after === null) throw new Error('expected an active hand');
    expect(after.lastSeq).toBe(before.lastSeq);
  });

  it('is a no-op when turnTimerSeconds <= 0 (disabled), even for an ancient window', async () => {
    const db = await freshDb();
    const gameId = 'atDisabled';
    const disabledRules: RulesConfig = { ...DEFAULT_RULES, turnTimerSeconds: 0 };
    await seedSeed44703Hand(db, gameId, disabledRules);
    await backdateAllActions(db, gameId, 10 * 24 * 60 * 60 * 1000);

    const before = await getCurrentHandState(db, gameId);
    if (before === null) throw new Error('expected an active hand');

    await applyTurnTimeouts(db, gameId);

    const after = await getCurrentHandState(db, gameId);
    if (after === null) throw new Error('expected an active hand');
    expect(after.lastSeq).toBe(before.lastSeq);
  });

  it('appends a timedOut discard and advances the phase once the discard-turn deadline has expired', async () => {
    const db = await freshDb();
    const gameId = 'atDiscardTurn';
    await seedSeed44703Hand(db, gameId, TIMER_RULES);
    await backdateAllActions(db, gameId, 10000);

    await applyTurnTimeouts(db, gameId);

    const after = await getCurrentHandState(db, gameId);
    if (after === null) throw new Error('expected an active hand');
    // This seed's auto-discarded tile happens to be unclaimable by all 3
    // other seats, so applyTurnTimeouts's own applyAutoPass follow-through
    // (see its doc comment) instantly clears the resulting awaiting-claims
    // window in the SAME call, landing on awaiting-draw for the next seat
    // rather than sitting in awaiting-claims — this is the fix for the real
    // "left unresolved for a full extra turnTimerSeconds" bug found in
    // review, not a regression. The discard itself is still asserted below
    // by searching the log for it (no longer assumed to be the last row,
    // since the auto-passes now append after it in this same call).
    expect(after.state.phase.type).toBe('awaiting-draw');

    const rows = await listActionsForHand(db, gameId, 1);
    const discardRow = rows.find((row) => row.actionType === 'discard');
    expect(discardRow).toBeDefined();
    expect((discardRow?.payload as { timedOut?: boolean }).timedOut).toBe(true);
  });

  it(
    'appends timedOut passes for ALL remaining unresponded claimants in one call once the claim-window ' +
      'deadline has expired (not just one), and a timeout-pass on the hu-capable seat still triggers the ' +
      'sacred-discard bar (same rule as an explicit manual pass)',
    async () => {
      const db = await freshDb();
      const gameId = 'atClaimWindow';
      await seedSeed44703Hand(db, gameId, TIMER_RULES);

      const discard = await submitAction(db, gameId, { type: 'discard', seat: 0, tileId: 'tiao-7-4' });
      if (isSubmitRuleError(discard)) throw new Error(discard.message);
      if (discard.state.phase.type !== 'awaiting-claims') throw new Error('unreachable');
      // seat 3 already auto-passed (zero options); seat 1 (pung-eligible)
      // and seat 2 (hu-eligible) are still undecided.
      expect(discard.state.phase.responses).toEqual({ 3: 'pass' });

      await backdateAllActions(db, gameId, 10000);

      await applyTurnTimeouts(db, gameId);

      const rows = await listActionsForHand(db, gameId, 1);
      const timedOutPasses = rows.filter(
        (r) => r.actionType === 'pass' && (r.payload as { timedOut?: boolean }).timedOut === true,
      );
      // Both seat 1 and seat 2 were auto-passed within this SAME call.
      expect(timedOutPasses.map((r) => r.actorSeat).sort()).toEqual([1, 2]);

      const after = await getCurrentHandState(db, gameId);
      if (after === null) throw new Error('expected an active hand');
      // All non-discarder seats (3 auto + 1 + 2 timed-out) have now passed
      // -> the window resolves to the next seat's awaiting-draw.
      expect(after.state.phase.type).toBe('awaiting-draw');
      expect(after.state.currentTurnSeat).toBe(1);
      // Seat 2 could have won on this discard and passed (here, via
      // timeout) instead — RULES.md's sacred-discard bar applies whether by
      // explicit pass or timeout, identically to a manual pass.
      expect(after.state.players[2].barred).toBe(true);
    },
  );

  it('concurrent applyTurnTimeouts invocations on the same expired window append the auto-action exactly once', async () => {
    const db = await freshDb();
    const gameId = 'atConcurrent';
    await seedSeed44703Hand(db, gameId, TIMER_RULES);
    await backdateAllActions(db, gameId, 10000);

    await Promise.all([applyTurnTimeouts(db, gameId), applyTurnTimeouts(db, gameId)]);

    const rows = await listActionsForHand(db, gameId, 1);
    const timedOutDiscards = rows.filter(
      (r) => r.actionType === 'discard' && (r.payload as { timedOut?: boolean }).timedOut === true,
    );
    // Exactly one auto-discard row for the dealer's expired opening turn —
    // not two — proving the fresh-read-before-every-append +
    // seq-conflict-retry discipline prevents the exact applyAutoPass
    // duplicate-append corruption bug class this design is modeled to avoid.
    expect(timedOutDiscards.length).toBe(1);
  });

  it('stops cleanly (no throw) when the auto-action would fail validation against fresher state', async () => {
    const db = await freshDb();
    const gameId = 'atRuleError';
    await seedSeed44703Hand(db, gameId, TIMER_RULES);
    await backdateAllActions(db, gameId, 10000);

    const before = await listActionsForHand(db, gameId, 1);

    const spy = vi.spyOn(gameStateModule, 'applyAction').mockReturnValueOnce({
      type: 'rule-error',
      code: 'wrong-phase',
      message: 'forced for test: simulates fresher state rejecting the picked auto-action',
    });

    await expect(applyTurnTimeouts(db, gameId)).resolves.toBeUndefined();
    spy.mockRestore();

    // The forced-invalid auto-action must never have been appended.
    const after = await listActionsForHand(db, gameId, 1);
    expect(after.length).toBe(before.length);
  });

  it('mid-window non-signature-changing responses do not move windowOpenedAt / extend the effective deadline', async () => {
    const db = await freshDb();
    const gameId = 'atMidWindow';
    await seedSeed44703Hand(db, gameId, TIMER_RULES);

    const discard = await submitAction(db, gameId, { type: 'discard', seat: 0, tileId: 'tiao-7-4' });
    if (isSubmitRuleError(discard)) throw new Error(discard.message);
    const afterDiscard = await getCurrentHandState(db, gameId);
    if (afterDiscard === null) throw new Error('expected an active hand');
    const windowOpenedAtAfterDiscard = afterDiscard.windowOpenedAt;

    // A real response from one of several still-undecided claimants — the
    // window (awaiting-claims for THIS discarded tile) is still open for
    // seat 2, so this must NOT be mistaken for a new window opening.
    const pass1 = await submitAction(db, gameId, { type: 'pass', seat: 1 });
    if (isSubmitRuleError(pass1)) throw new Error(pass1.message);
    expect(pass1.state.phase.type).toBe('awaiting-claims');

    const afterPass1 = await getCurrentHandState(db, gameId);
    if (afterPass1 === null) throw new Error('expected an active hand');
    expect(afterPass1.windowOpenedAt).toBe(windowOpenedAtAfterDiscard);

    // Backdating relative to the discard's own (still-current) windowOpenedAt
    // correctly expires the window and lets enforcement proceed, confirming
    // applyTurnTimeouts uses the true windowOpenedAt (unaffected by seat 1's
    // intervening real pass), not "most recent row", to compute the deadline.
    await backdateAllActions(db, gameId, 10000);
    await applyTurnTimeouts(db, gameId);

    const rows = await listActionsForHand(db, gameId, 1);
    const timedOut = rows.filter((r) => (r.payload as { timedOut?: boolean }).timedOut === true);
    expect(timedOut.length).toBeGreaterThan(0);
  });

  it(
    'replay parity: a hand played via manual actions vs. the same hand with one turn replaced by a ' +
      'timeout-tagged auto-action produce identical resulting GameState',
    async () => {
      const dbA = await freshDb();
      const gameA = 'parityManual';
      await seedSeed44703Hand(dbA, gameA);
      const winA = await winSeed44703(dbA, gameA);

      const dbB = await freshDb();
      const gameB = 'parityTimeout';
      await seedSeed44703Hand(dbB, gameB);
      const discardB = await submitAction(dbB, gameB, { type: 'discard', seat: 0, tileId: 'tiao-7-4' });
      if (isSubmitRuleError(discardB)) throw new Error(discardB.message);

      // Seat 1's manual pass is replaced by an equivalent timedOut-tagged
      // pass, appended directly — the tag is a pure audit marker and must
      // be replay-inert.
      const currentB = await getCurrentHandState(dbB, gameB);
      if (currentB === null) throw new Error('expected an active hand');
      const appended = await appendActionAtSeq(
        dbB,
        gameB,
        1,
        { type: 'pass', seat: 1, timedOut: true },
        currentB.lastSeq + 1,
      );
      if (appended === 'seq-conflict') throw new Error('unexpected seq conflict in a single-writer test');

      const winB = await submitAction(dbB, gameB, { type: 'claim', seat: 2, claim: { type: 'hu' } });
      if (isSubmitRuleError(winB)) throw new Error(winB.message);

      expect(winB.state).toEqual(winA.state);
    },
  );
});
