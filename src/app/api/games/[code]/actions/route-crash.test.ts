/**
 * Regression coverage for a previously-fixed bug: the actions route used to
 * validate only that `action.type` was a string and `action.seat` was a
 * number — never that `action.type` was one of the real GameAction union
 * members, nor that a recognized type's other required fields were present.
 * Two concrete payloads crashed the REAL POST handler uncaught:
 *
 *   1. `{type: 'not-a-real-action', seat: 0}` hit applyAction's
 *      exhaustiveness-guard `throw new Error(...)` in game-state.ts.
 *   2. `{type: 'claim', seat: 0}` (missing the required `claim` sub-object)
 *      threw a raw TypeError from handleClaim's unconditional
 *      `action.claim.type` read.
 *
 * The route now validates every submitted action against the real
 * GameAction discriminated union shape via `isValidGameAction` (see
 * src/lib/protocol.ts) BEFORE ever calling submitAction/applyAction, and
 * wraps the submitAction call itself in a try/catch as a defense-in-depth
 * backstop. Both payloads below now resolve to a clean 400
 * `{error: {type: 'validation-error', ...}}` response instead of the promise
 * rejecting — this file proves that fix and guards against regression.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { Client } from '@libsql/client';
import { getDb } from '@/server/db';
import { runMigrations } from '@/server/migrations';
import { createGame, joinGame } from '@/server/games';
import { appendStartHand } from '@/server/actions-log';
import { submitAction } from '@/server/replay';
import type { GameState, RuleError } from '@/engine/game-state';
import { POST } from './route';

let db: Client;

beforeAll(async () => {
  process.env.TURSO_DATABASE_URL = ':memory:';
  delete process.env.TURSO_AUTH_TOKEN;
  db = getDb();
  await runMigrations(db);
});

function actionRequest(code: string, token: string, action: unknown): Request {
  return new Request(`http://localhost/api/games/${code}/actions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ action }),
  });
}

function callActions(code: string, token: string, action: unknown): Promise<Response> {
  return POST(actionRequest(code, token, action), { params: Promise.resolve({ code }) });
}

function isSubmitRuleError(
  r: { readonly state: GameState; readonly handNumber: number } | RuleError,
): r is RuleError {
  return 'type' in r && r.type === 'rule-error';
}

async function fullyJoinedGame(): Promise<{
  gameId: string;
  roomCode: string;
  tokens: readonly [string, string, string, string];
}> {
  const created = await createGame(db, { displayName: 'Alice' });
  const j2 = await joinGame(db, created.roomCode, { displayName: 'Bob' });
  const j3 = await joinGame(db, created.roomCode, { displayName: 'Carol' });
  const j4 = await joinGame(db, created.roomCode, { displayName: 'Dave' });
  if ('error' in j2 || 'error' in j3 || 'error' in j4) {
    throw new Error('unexpected join error setting up fixture');
  }
  return {
    gameId: created.gameId,
    roomCode: created.roomCode,
    tokens: [created.playerToken, j2.playerToken, j3.playerToken, j4.playerToken],
  };
}

describe('POST /api/games/[code]/actions — malformed action payloads return 400 validation-error instead of crashing', () => {
  it(
    'malformed action.type (passes no engine dispatch case) returns 400 validation-error instead ' +
      'of crashing: previously applyAction\'s exhaustiveness-guard `throw new Error(...)` ' +
      'propagated all the way out of submitAction and out of the route\'s POST(), rejecting the ' +
      'returned promise instead of resolving to any Response. Now isValidGameAction rejects it ' +
      'before submitAction is ever called.',
    async () => {
      const { roomCode, tokens } = await fullyJoinedGame();

      const response = await callActions(roomCode, tokens[0], { type: 'not-a-real-action', seat: 0 });
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: { type: string; message: string } };
      expect(body.error.type).toBe('validation-error');
    },
  );

  it(
    'a KNOWN action.type ("claim") missing its required `claim` sub-object now returns 400 ' +
      'validation-error instead of crashing: previously handleClaim read `action.claim.type` ' +
      'unconditionally once the phase was awaiting-claims, so {type:"claim", seat} with no ' +
      '`claim` field threw a raw TypeError from inside the route handler instead of a ' +
      'RuleError/409. isValidGameAction now requires `claim` to be a well-formed object before ' +
      'submitAction is ever called.',
    async () => {
      // Reuses the known fixture from submit-autopass-interaction.test.ts: seed 44703, dealer 0,
      // discarding tiao-7-4 leaves seat 2 with a real hu option (so the claim window stays open
      // and seat 2 remains unresponded — auto-pass only clears zero-option seats).
      const created = await createGame(db, { displayName: 'Alice' });
      const j2 = await joinGame(db, created.roomCode, { displayName: 'Bob' });
      const j3 = await joinGame(db, created.roomCode, { displayName: 'Carol' });
      const j4 = await joinGame(db, created.roomCode, { displayName: 'Dave' });
      if ('error' in j2 || 'error' in j3 || 'error' in j4) {
        throw new Error('unexpected join error setting up fixture');
      }
      const gameId = created.gameId;

      // The 4-player join flow already appended hand 1's start-hand row with a random seed.
      // Overwrite it with the known deterministic fixture seed so this test is reproducible,
      // mirroring the direct-DB-seeding technique already used elsewhere in this codebase.
      await db.execute({ sql: 'DELETE FROM actions WHERE game_id = ?', args: [gameId] });
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
      if (discardResult.state.phase.responses[2] !== undefined) {
        throw new Error('test fixture assumption broken: expected seat 2 (hu option) to remain unresponded');
      }

      const tokens = [created.playerToken, j2.playerToken, j3.playerToken, j4.playerToken] as const;

      const response = await callActions(created.roomCode, tokens[2], { type: 'claim', seat: 2 }); // no `claim` field at all
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: { type: string; message: string } };
      expect(body.error.type).toBe('validation-error');
    },
  );

  it(
    'a well-formed, legitimate claim action (hu, on a fixture where seat 2 genuinely has a hu ' +
      'option) is NOT rejected by isValidGameAction: reuses the exact same seed-44703 fixture as ' +
      'the crash-path test above to prove the new guard does not introduce a false rejection for ' +
      'the very shape (claim + claim sub-object) it was built to gate.',
    async () => {
      const created = await createGame(db, { displayName: 'Alice' });
      const j2 = await joinGame(db, created.roomCode, { displayName: 'Bob' });
      const j3 = await joinGame(db, created.roomCode, { displayName: 'Carol' });
      const j4 = await joinGame(db, created.roomCode, { displayName: 'Dave' });
      if ('error' in j2 || 'error' in j3 || 'error' in j4) {
        throw new Error('unexpected join error setting up fixture');
      }
      const gameId = created.gameId;

      await db.execute({ sql: 'DELETE FROM actions WHERE game_id = ?', args: [gameId] });
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

      const tokens = [created.playerToken, j2.playerToken, j3.playerToken, j4.playerToken] as const;

      const response = await callActions(created.roomCode, tokens[2], {
        type: 'claim',
        seat: 2,
        claim: { type: 'hu' },
      });
      // The point of this test is specifically that validation does not
      // false-reject it: a validation-error 400 would be a genuine
      // regression. Whatever the engine ultimately decides (200 accepted, or
      // a 409 rule-error for an unrelated engine reason) is out of scope —
      // only "did the NEW guard wrongly block a well-formed claim" matters
      // here.
      expect(response.status).not.toBe(400);
      if (response.status === 400) {
        const body = (await response.json()) as { error: { type: string } };
        expect(body.error.type).not.toBe('validation-error');
      }
    },
  );
});

describe('POST /api/games/[code]/actions — light fuzz pass beyond the two confirmed crash paths', () => {
  it('action as null returns a clean 400, not a crash', async () => {
    const { roomCode, tokens } = await fullyJoinedGame();
    const response = await callActions(roomCode, tokens[0], null);
    expect(response.status).toBe(400);
  });

  it('action as an array returns a clean 400, not a crash', async () => {
    const { roomCode, tokens } = await fullyJoinedGame();
    const response = await callActions(roomCode, tokens[0], [{ type: 'draw', seat: 0 }]);
    expect(response.status).toBe(400);
  });

  it('action.seat as a string instead of number returns a clean 400, not a crash', async () => {
    const { roomCode, tokens } = await fullyJoinedGame();
    const response = await callActions(roomCode, tokens[0], { type: 'draw', seat: '0' });
    expect(response.status).toBe(400);
  });

  it('action.seat as 4 (out of range) returns a clean 400, not a crash', async () => {
    const { roomCode, tokens } = await fullyJoinedGame();
    const response = await callActions(roomCode, tokens[0], { type: 'draw', seat: 4 });
    expect(response.status).toBe(400);
  });

  it('action.seat as -1 (out of range) returns a clean 400, not a crash', async () => {
    const { roomCode, tokens } = await fullyJoinedGame();
    const response = await callActions(roomCode, tokens[0], { type: 'draw', seat: -1 });
    expect(response.status).toBe(400);
  });

  it('claim.type as an invalid string returns a clean 400, not a crash', async () => {
    const { roomCode, tokens } = await fullyJoinedGame();
    const response = await callActions(roomCode, tokens[0], {
      type: 'claim',
      seat: 0,
      claim: { type: 'bogus' },
    });
    expect(response.status).toBe(400);
  });

  it('declare-concealed-kong with kind as a string instead of an object returns a clean 400, not a crash', async () => {
    const { roomCode, tokens } = await fullyJoinedGame();
    const response = await callActions(roomCode, tokens[0], {
      type: 'declare-concealed-kong',
      seat: 0,
      kind: 'wan-5',
    });
    expect(response.status).toBe(400);
  });

  it('chow claim with tileIds as a single string instead of a 2-array returns a clean 400, not a crash', async () => {
    const { roomCode, tokens } = await fullyJoinedGame();
    const response = await callActions(roomCode, tokens[0], {
      type: 'claim',
      seat: 0,
      claim: { type: 'chow', tileIds: 'wan-4-2' },
    });
    expect(response.status).toBe(400);
  });
});
