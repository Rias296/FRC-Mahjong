/**
 * Tester-authored coverage for round-1 review brief item 5: applyAutoPass
 * correctness with a REAL winning-option seat mixed with a real
 * pung-option seat and a genuinely-zero-option seat, all arising from real
 * gameplay through submitAction (not hand-unit-tested with a synthetic
 * GameState).
 *
 * Fixture: seed 44703, dealer 0. Dealer's opening hand, when discarding
 * tile 'tiao-7-4', produces (found via offline brute-force search over
 * seeds, see scratchpad/find-mixed-seed.ts):
 *   - seat 2: a real hu option
 *   - seat 1: a real pung option (no hu)
 *   - seat 3: zero options (no hu/pung/kong/chow)
 */
import { createClient, type Client } from '@libsql/client';
import { describe, expect, it } from 'vitest';
import { runMigrations } from './migrations';
import { appendStartHand, listActionsForHand } from './actions-log';
import { submitAction } from './replay';
import { DEFAULT_RULES } from '../engine/rules-config';
import type { GameState, RuleError } from '../engine/game-state';
import { canChow, canKongFromDiscard, canPung } from '../engine/actions';
import { canWin } from '../engine/hand';

function isRuleError(
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

describe('applyAutoPass with a real mixed hu/pung/zero-option discard', () => {
  it('auto-passes only the genuinely-zero-option seat, leaving the hu-eligible and pung-eligible seats to decide', async () => {
    const db = await freshDb();
    const gameId = 'mixed1';
    await seedGameRow(db, gameId);
    await appendStartHand(db, gameId, {
      handNumber: 1,
      dealerSeat: 0,
      seed: 44703,
      repeatCount: 0,
      prevailingWind: 'east',
    });

    const submitted = await submitAction(db, gameId, { type: 'discard', seat: 0, tileId: 'tiao-7-4' });
    if (isRuleError(submitted)) throw new Error(`unexpected rule error: ${submitted.message}`);

    // Sanity: confirm the fixture's claimed option shape against the real
    // post-discard hands, using the engine's own capability functions
    // (not hard-coded assumptions).
    const phase = submitted.state.phase;
    if (phase.type !== 'awaiting-claims') {
      throw new Error(`test fixture assumption broken: expected awaiting-claims, got ${phase.type}`);
    }
    const seat1Hand = submitted.state.players[1].hand;
    const seat2Hand = submitted.state.players[2].hand;
    const seat3Hand = submitted.state.players[3].hand;

    expect(canWin(seat2Hand.concealedTiles, seat2Hand.melds.length, phase.discardedTile)).toBe(true);
    expect(canPung(seat1Hand, phase.discardedTile) || canKongFromDiscard(seat1Hand, phase.discardedTile)).toBe(true);
    expect(canWin(seat1Hand.concealedTiles, seat1Hand.melds.length, phase.discardedTile)).toBe(false);
    expect(
      canWin(seat3Hand.concealedTiles, seat3Hand.melds.length, phase.discardedTile) ||
        canPung(seat3Hand, phase.discardedTile) ||
        canKongFromDiscard(seat3Hand, phase.discardedTile) ||
        canChow(seat3Hand, phase.discardedTile, 3, 0).length > 0,
    ).toBe(false);

    // The actual assertions under test: only seat 3 was auto-passed; seats
    // 1 and 2 are still undecided, and the window has NOT resolved.
    expect(phase.responses).toEqual({ 3: 'pass' });
    expect(phase.responses[1]).toBeUndefined();
    expect(phase.responses[2]).toBeUndefined();
    expect(submitted.state.phase.type).toBe('awaiting-claims');

    // Exactly one pass row was appended by the server (for seat 3); no pass
    // was fabricated for seats 1 or 2.
    const rows = await listActionsForHand(db, gameId, 1);
    const passRows = rows.filter((r) => r.actionType === 'pass');
    expect(passRows.length).toBe(1);
    expect(passRows[0].actorSeat).toBe(3);

    // The hand still correctly resolves once the real seats respond: seat 1
    // declines the pung (pass) and seat 2 takes the win.
    const seat1Pass = await submitAction(db, gameId, { type: 'pass', seat: 1 });
    if (isRuleError(seat1Pass)) throw new Error(`unexpected rule error: ${seat1Pass.message}`);
    expect(seat1Pass.state.phase.type).toBe('awaiting-claims');

    const seat2Hu = await submitAction(db, gameId, { type: 'claim', seat: 2, claim: { type: 'hu' } });
    if (isRuleError(seat2Hu)) throw new Error(`unexpected rule error: ${seat2Hu.message}`);
    expect(seat2Hu.state.phase.type).toBe('hand-over');
    if (seat2Hu.state.phase.type === 'hand-over' && seat2Hu.state.phase.result.kind === 'win') {
      expect(seat2Hu.state.phase.result.winners.map((w) => w.seat)).toEqual([2]);
    } else {
      throw new Error('expected a win result');
    }
  });
});
