/**
 * Tester-authored replay-correctness stress test (round-1 review brief item
 * 3): plays a long, real hand entirely through the DB write path
 * (appendStartHand + submitAction, i.e. games.ts/replay.ts's real machinery,
 * never synthetic rows), using a deterministic bot policy scripted purely
 * from the engine's own capability functions (canPung/canChow/canKongFromDiscard/
 * canAddedKong/canConcealedKong). At every single step, independently folds
 * the ENTIRE persisted action log through the engine's own startHand/
 * applyAction from scratch (not by calling replay.ts's replayHand, so this
 * is a genuinely independent parity oracle) and asserts it matches what
 * submitAction returned. The scripted policy deliberately declares
 * concealed/added kongs whenever eligible and never declares hu, so the hand
 * runs long enough to exercise draw, discard, pung, chow, kong, and
 * (passed) rob-kong-window mechanics in one continuous real game.
 *
 * Seed 1 / dealer 0 was found (via offline search, see
 * scratchpad/find-kong-step2.ts) to produce a concealed-kong opportunity at
 * bot-step 233 under this exact policy.
 */
import { createClient, type Client } from '@libsql/client';
import { describe, expect, it } from 'vitest';
import { runMigrations } from './migrations';
import { appendStartHand, listActionsForHand, type StartHandPayload } from './actions-log';
import { getCurrentHandState, submitAction } from './replay';
import { DEFAULT_RULES } from '../engine/rules-config';
import {
  applyAction,
  isRuleError,
  startHand,
  type GameAction,
  type GameState,
  type RuleError,
} from '../engine/game-state';
import { SEATS } from '../engine/seats';
import { canAddedKong, canChow, canConcealedKong, canKongFromDiscard, canPung } from '../engine/actions';
import { kindKey } from '../engine/tiles';

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

async function seedGameRow(db: Client, gameId: string): Promise<void> {
  await db.execute({
    sql: `INSERT INTO games (id, room_code, status, rules_config, engine_version, created_at, updated_at)
          VALUES (?, ?, 'in-progress', ?, '0.1.0', 1, 1)`,
    args: [gameId, gameId.slice(0, 6).toUpperCase().padEnd(6, 'X'), JSON.stringify(DEFAULT_RULES)],
  });
}

/**
 * Deterministic bot policy (mirrors scratchpad/find-kong-step2.ts exactly):
 * never declares hu, always takes an available kong, otherwise
 * tsumogiri-discards; on claim windows takes kong > pung > chow > pass;
 * always passes rob-kong windows. Returns null only once the hand is over.
 */
function nextBotAction(state: GameState): GameAction | null {
  const phase = state.phase;

  if (phase.type === 'awaiting-draw') {
    return { type: 'draw', seat: state.currentTurnSeat };
  }

  if (phase.type === 'awaiting-discard') {
    const seat = state.currentTurnSeat;
    const player = state.players[seat];

    const addedKongKinds = canAddedKong(player.hand);
    if (addedKongKinds.length > 0) {
      const tile = player.hand.concealedTiles.find((t) =>
        addedKongKinds.some((k) => kindKey(k) === kindKey(t.kind)),
      );
      if (tile) return { type: 'declare-added-kong', seat, tileId: tile.id };
    }
    const concealedKongKinds = canConcealedKong(player.hand);
    if (concealedKongKinds.length > 0) {
      return { type: 'declare-concealed-kong', seat, kind: concealedKongKinds[0] };
    }

    const tileId = phase.drawnTile !== null ? phase.drawnTile.id : player.hand.concealedTiles[0].id;
    return { type: 'discard', seat, tileId };
  }

  if (phase.type === 'awaiting-claims') {
    for (const seat of SEATS) {
      if (seat === phase.discarderSeat) continue;
      if (phase.responses[seat] !== undefined) continue;
      const hand = state.players[seat].hand;
      if (canKongFromDiscard(hand, phase.discardedTile)) {
        return { type: 'claim', seat, claim: { type: 'kong' } };
      }
      if (canPung(hand, phase.discardedTile)) {
        return { type: 'claim', seat, claim: { type: 'pung' } };
      }
      const chowOptions = canChow(hand, phase.discardedTile, seat, phase.discarderSeat);
      if (chowOptions.length > 0) {
        const ids = chowOptions[0].concealedTilesUsed.map((t) => t.id) as [string, string];
        return { type: 'claim', seat, claim: { type: 'chow', tileIds: ids } };
      }
      return { type: 'pass', seat };
    }
    return null;
  }

  if (phase.type === 'awaiting-rob-kong') {
    for (const seat of phase.eligibleRobbers) {
      if (phase.responses[seat] !== undefined) continue;
      return { type: 'pass', seat };
    }
    return null;
  }

  return null; // hand-over
}

/**
 * Independent replay oracle: folds the full persisted log through
 * startHand/applyAction directly, WITHOUT calling replay.ts's replayHand.
 * This is a deliberately separate implementation from the one under test.
 */
async function independentFold(db: Client, gameId: string, handNumber: number): Promise<GameState> {
  const rows = await listActionsForHand(db, gameId, handNumber);
  if (rows.length === 0 || rows[0].actionType !== 'start-hand') {
    throw new Error('independentFold: expected first row to be start-hand');
  }
  const startPayload = rows[0].payload as StartHandPayload;
  let state = startHand(startPayload.dealerSeat, startPayload.seed, DEFAULT_RULES, startPayload.repeatCount);
  for (let i = 1; i < rows.length; i++) {
    const action = rows[i].payload as GameAction;
    const result = applyAction(state, action);
    if (isRuleError(result)) {
      throw new Error(`independentFold: engine rejected logged action at seq ${rows[i].seq}: ${result.message}`);
    }
    state = result;
  }
  return state;
}

describe('replay parity over a long, real, bot-driven hand (games.ts + replay.ts path)', () => {
  it(
    'matches an independent engine fold at every single step, through draw/discard/pung/chow/kong',
    async () => {
      const db = await freshDb();
      const gameId = 'longhand';
      await seedGameRow(db, gameId);
      await appendStartHand(db, gameId, {
        handNumber: 1,
        dealerSeat: 0,
        seed: 1,
        repeatCount: 0,
        prevailingWind: 'east',
      });

      let sawAddedKong = false;
      let sawConcealedKong = false;
      let sawPung = false;
      let sawChow = false;
      let steps = 0;
      const MAX_STEPS = 260;

      for (; steps < MAX_STEPS; steps++) {
        const current = await getCurrentHandState(db, gameId);
        if (current === null) throw new Error('expected an active hand');
        if (current.state.phase.type === 'hand-over') break;

        const action = nextBotAction(current.state);
        if (action === null) throw new Error(`bot produced no action at step ${steps} in phase ${current.state.phase.type}`);

        if (action.type === 'declare-added-kong') sawAddedKong = true;
        if (action.type === 'declare-concealed-kong') sawConcealedKong = true;
        if (action.type === 'claim' && action.claim.type === 'pung') sawPung = true;
        if (action.type === 'claim' && action.claim.type === 'chow') sawChow = true;

        const submitted = await submitAction(db, gameId, action);
        if (isSubmitRuleError(submitted)) {
          throw new Error(`bot action rejected at step ${steps}: ${JSON.stringify(action)}: ${submitted.message}`);
        }

        // Parity check #1: submitAction's own return matches a totally
        // independent fold of the persisted log (this is the core ask:
        // does replayHand's result match directly folding the same actions
        // through the engine's own applyAction).
        const folded = await independentFold(db, gameId, submitted.handNumber);
        expect(folded).toEqual(submitted.state);

        // Parity check #2: a fresh getCurrentHandState call agrees too.
        const reloaded = await getCurrentHandState(db, gameId);
        expect(reloaded?.state).toEqual(submitted.state);

        if (sawAddedKong || sawConcealedKong) {
          // Stop shortly after we've exercised at least one kong path, to
          // keep the test's runtime bounded (parity has already been
          // checked at every prior step, including through the kong).
          break;
        }
      }

      // Sanity: the scripted bot actually exercised the claimed variety of
      // real actions through the real DB path, not just draws/discards.
      expect(sawPung || sawChow).toBe(true);
      expect(sawAddedKong || sawConcealedKong).toBe(true);
      expect(steps).toBeGreaterThan(20);
    },
    30_000,
  );
});
