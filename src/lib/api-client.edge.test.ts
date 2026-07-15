/**
 * Adversarial/edge-case coverage for api-client.ts, beyond the builder's own
 * api-client.test.ts. Cross-checked directly against the live route handlers
 * under src/app/api/games/** (not the module's doc comment, which is the
 * builder's own claim) as of this review. See the Phase 4 plumbing review
 * task for the exact areas this targets.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { advanceNextHand, createGame, gameStreamUrl, getState, joinGame, submitAction } from './api-client';
import type { ClientGameView, CreateGameResponse, JoinGameResponse } from './protocol';
import type { GameAction, RuleError } from '../engine/game-state';

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function stubFetch(impl: (input: string, init?: RequestInit) => Promise<Response> | Response): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init?: RequestInit) => Promise.resolve(impl(input, init))),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const sampleView: ClientGameView = {
  seq: 5,
  roomCode: 'ABCD',
  status: 'in-progress',
  handNumber: 1,
  prevailingWind: 'east',
  players: [],
  wallRemaining: 80,
  phase: null,
  viewerSeat: 0,
  currentTurnSeat: 0,
  dealerSeat: 0,
  repeatCount: 0,
};

// --- 1. Authorization header correctness ------------------------------------

describe('Authorization header discipline', () => {
  it('createGame sends NO Authorization header (unauthenticated by design)', async () => {
    let capturedInit: RequestInit | undefined;
    stubFetch((_input, init) => {
      capturedInit = init;
      return jsonResponse(201, {
        roomCode: 'ABCD',
        seat: 0,
        playerToken: 'tok',
        rules: {},
        status: 'waiting-for-players',
      } as unknown as CreateGameResponse);
    });

    await createGame({ displayName: 'Alice' });

    const headers = capturedInit?.headers as Record<string, string> | undefined;
    expect(headers).toBeDefined();
    expect(Object.keys(headers ?? {}).map((h) => h.toLowerCase())).not.toContain('authorization');
  });

  it('joinGame sends NO Authorization header (unauthenticated by design)', async () => {
    let capturedInit: RequestInit | undefined;
    stubFetch((_input, init) => {
      capturedInit = init;
      return jsonResponse(200, {
        roomCode: 'ABCD',
        seat: 1,
        playerToken: 'tok2',
        rules: {},
        status: 'waiting-for-players',
      } as unknown as JoinGameResponse);
    });

    await joinGame('ABCD', { displayName: 'Bob' });

    const headers = capturedInit?.headers as Record<string, string> | undefined;
    expect(headers).toBeDefined();
    expect(Object.keys(headers ?? {}).map((h) => h.toLowerCase())).not.toContain('authorization');
  });

  it('getState sends exactly "Bearer <token>" with a single space, no double-prefix', async () => {
    let capturedInit: RequestInit | undefined;
    stubFetch((_input, init) => {
      capturedInit = init;
      return jsonResponse(200, sampleView);
    });

    await getState('ABCD', 'raw-token-value');

    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer raw-token-value');
    expect(headers.Authorization).not.toBe('raw-token-value');
    expect(headers.Authorization).not.toBe('Bearer Bearer raw-token-value');
  });

  it('submitAction sends exactly "Bearer <token>" plus Content-Type json', async () => {
    let capturedInit: RequestInit | undefined;
    stubFetch((_input, init) => {
      capturedInit = init;
      return jsonResponse(200, { seq: 1, view: sampleView });
    });

    const action: GameAction = { type: 'pass', seat: 0 };
    await submitAction('ABCD', 'tok-xyz', action);

    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok-xyz');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('advanceNextHand sends exactly "Bearer <token>"', async () => {
    let capturedInit: RequestInit | undefined;
    stubFetch((_input, init) => {
      capturedInit = init;
      return jsonResponse(200, sampleView);
    });

    await advanceNextHand('ABCD', 'tok-next');

    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok-next');
  });
});

// --- 2. submitAction request body shape -------------------------------------

describe('submitAction request body shape', () => {
  it('sends exactly { action } — not the raw action, not double-wrapped', async () => {
    let capturedInit: RequestInit | undefined;
    stubFetch((_input, init) => {
      capturedInit = init;
      return jsonResponse(200, { seq: 1, view: sampleView });
    });

    const action: GameAction = { type: 'discard', seat: 2, tileId: 'tong-5-0' };
    await submitAction('ABCD', 'tok', action);

    const parsedBody = JSON.parse(capturedInit?.body as string);
    expect(Object.keys(parsedBody)).toEqual(['action']);
    expect(parsedBody.action).toEqual(action);
    // Not double-wrapped: parsedBody.action.action must not exist.
    expect((parsedBody.action as Record<string, unknown>).action).toBeUndefined();
    // Not sent as the raw, unwrapped action at the top level.
    expect(parsedBody.type).toBeUndefined();
    expect(parsedBody.seat).toBeUndefined();
  });
});

// --- 3. gameStreamUrl encoding ------------------------------------------------

describe('gameStreamUrl encoding', () => {
  it('encodes a room code containing "&" so it cannot inject an extra query param', () => {
    const url = gameStreamUrl('AB&CD', 'tok', 0);
    expect(url).toBe(`/api/games/${encodeURIComponent('AB&CD')}/stream?since=0&token=${encodeURIComponent('tok')}`);
    // Sanity: the raw ampersand must not appear unescaped inside the path segment.
    expect(url.split('?')[0]).not.toContain('AB&CD');
  });

  it('encodes a token containing "#" so it cannot truncate the query string as a fragment', () => {
    const url = gameStreamUrl('ABCD', 'tok#fragment', 3);
    expect(url).toBe(`/api/games/ABCD/stream?since=3&token=${encodeURIComponent('tok#fragment')}`);
    expect(url).not.toContain('token=tok#fragment');
  });

  it('encodes a token containing base64url-adjacent characters (+ / =) defensively', () => {
    const url = gameStreamUrl('ABCD', 'a+b/c=d', 7);
    expect(url).toBe(`/api/games/ABCD/stream?since=7&token=${encodeURIComponent('a+b/c=d')}`);
  });

  it('encodes a room code/token containing a literal space', () => {
    const url = gameStreamUrl('AB CD', 'tok en', 1);
    expect(url).toBe(
      `/api/games/${encodeURIComponent('AB CD')}/stream?since=1&token=${encodeURIComponent('tok en')}`,
    );
    expect(url).not.toContain(' ');
  });
});

// --- 4. parseError disambiguation per real route response shapes -------------

describe('parseError against real route response shapes', () => {
  it('games/route.ts: POST /api/games 400 bare-string displayName error maps to validation-error', async () => {
    stubFetch(() => jsonResponse(400, { error: 'displayName is required' }));
    const result = await createGame({ displayName: '' });
    expect(result).toEqual({ ok: false, error: { kind: 'validation-error', message: 'displayName is required' } });
  });

  it('games/route.ts: POST /api/games 400 validation-error object (invalid rules) maps correctly', async () => {
    stubFetch(() => jsonResponse(400, { error: { type: 'validation-error', message: 'Invalid rules override' } }));
    const result = await createGame({ displayName: 'Alice' });
    expect(result).toEqual({ ok: false, error: { kind: 'validation-error', message: 'Invalid rules override' } });
  });

  it('actions/route.ts: 400 bare-string "invalid-json" maps to validation-error carrying that string as message', async () => {
    stubFetch(() => jsonResponse(400, { error: 'invalid-json' }));
    const result = await submitAction('ABCD', 'tok', { type: 'pass', seat: 0 });
    expect(result).toEqual({ ok: false, error: { kind: 'validation-error', message: 'invalid-json' } });
  });

  it('actions/route.ts: 403 seat-mismatch is mapped purely by status code, independent of body content', async () => {
    // Confirms the route's actual body ({ error: 'seat-mismatch' }) round-trips correctly...
    stubFetch(() => jsonResponse(403, { error: 'seat-mismatch' }));
    expect(await submitAction('ABCD', 'tok', { type: 'pass', seat: 0 })).toEqual({
      ok: false,
      error: { kind: 'seat-mismatch' },
    });
  });

  it('actions/route.ts: 409 with a malformed RuleError body (missing code/message) degrades to server-error, not a bogus rule-error', async () => {
    stubFetch(() => jsonResponse(409, { error: { type: 'rule-error' } }));
    const result = await submitAction('ABCD', 'tok', { type: 'pass', seat: 0 });
    expect(result).toEqual({ ok: false, error: { kind: 'server-error', status: 409 } });
  });

  it('actions/route.ts: 409 whose error field is a bare string (unexpected shape for this context) degrades to server-error', async () => {
    stubFetch(() => jsonResponse(409, { error: 'unexpected-string' }));
    const result = await submitAction('ABCD', 'tok', { type: 'pass', seat: 0 });
    expect(result).toEqual({ ok: false, error: { kind: 'server-error', status: 409 } });
  });

  it('actions/route.ts: full RuleError body round-trips every RuleErrorCode variant untouched', async () => {
    const codes: readonly RuleError['code'][] = [
      'wrong-phase',
      'wrong-seat',
      'hand-is-over',
      'already-responded',
      'tile-not-in-hand',
      'illegal-claim',
      'illegal-kong',
      'barred-by-sacred-discard',
      'below-minimum-tai',
      'not-a-winning-hand',
      'no-replacement-available',
    ];
    for (const code of codes) {
      const ruleError: RuleError = { type: 'rule-error', code, message: `msg for ${code}` };
      stubFetch(() => jsonResponse(409, { error: ruleError }));
      const result = await submitAction('ABCD', 'tok', { type: 'pass', seat: 0 });
      expect(result).toEqual({ ok: false, error: { kind: 'rule-error', ruleError } });
    }
  });

  it('join/route.ts: 409 with an unrecognized string reason degrades to server-error instead of a fabricated join-rejected', async () => {
    stubFetch(() => jsonResponse(409, { error: 'seat-taken-by-nobody' }));
    const result = await joinGame('ABCD', { displayName: 'Bob' });
    expect(result).toEqual({ ok: false, error: { kind: 'server-error', status: 409 } });
  });

  it('next-hand/route.ts: 409 with an unrecognized string reason degrades to server-error', async () => {
    stubFetch(() => jsonResponse(409, { error: 'not-a-real-reason' }));
    const result = await advanceNextHand('ABCD', 'tok');
    expect(result).toEqual({ ok: false, error: { kind: 'server-error', status: 409 } });
  });

  it('next-hand/route.ts: cross-context confusion — a join-shaped 409 reason ("game-full") sent to next-hand degrades to server-error, not join-rejected', async () => {
    stubFetch(() => jsonResponse(409, { error: 'game-full' }));
    const result = await advanceNextHand('ABCD', 'tok');
    expect(result).toEqual({ ok: false, error: { kind: 'server-error', status: 409 } });
  });

  it('join/route.ts: cross-context confusion — a next-hand-shaped 409 reason ("hand-not-over") sent to join degrades to server-error, not conflict', async () => {
    stubFetch(() => jsonResponse(409, { error: 'hand-not-over' }));
    const result = await joinGame('ABCD', { displayName: 'Bob' });
    expect(result).toEqual({ ok: false, error: { kind: 'server-error', status: 409 } });
  });

  it('actions/route.ts: 500 internal-error object maps to server-error with the real status, not swallowed as validation-error', async () => {
    stubFetch(() => jsonResponse(500, { error: { type: 'internal-error', message: 'boom' } }));
    const result = await submitAction('ABCD', 'tok', { type: 'pass', seat: 0 });
    expect(result).toEqual({ ok: false, error: { kind: 'server-error', status: 500 } });
  });

  it('next-hand/route.ts: 500 internal-error object maps to server-error', async () => {
    stubFetch(() => jsonResponse(500, { error: { type: 'internal-error', message: 'boom' } }));
    const result = await advanceNextHand('ABCD', 'tok');
    expect(result).toEqual({ ok: false, error: { kind: 'server-error', status: 500 } });
  });

  it('state/route.ts: 401 covers missing/bad token AND a token/game mismatch, both mapped identically to unauthorized', async () => {
    stubFetch(() => jsonResponse(401, { error: 'unauthorized' }));
    expect(await getState('ABCD', 'expired-token')).toEqual({ ok: false, error: { kind: 'unauthorized' } });

    // Same status/body shape stands in for the token/game-mismatch branch — the
    // route never distinguishes it from a plain bad token (confirmed in
    // state/route.ts), so api-client must not either.
    stubFetch(() => jsonResponse(401, { error: 'unauthorized' }));
    expect(await getState('OTHERGAME', 'token-for-a-different-game')).toEqual({
      ok: false,
      error: { kind: 'unauthorized' },
    });
  });

  it('400 error field that is neither a validation-error object nor a string (e.g. a number) falls back to a generic Invalid request message', async () => {
    stubFetch(() => jsonResponse(400, { error: 42 }));
    const result = await submitAction('ABCD', 'tok', { type: 'pass', seat: 0 });
    expect(result).toEqual({ ok: false, error: { kind: 'validation-error', message: 'Invalid request' } });
  });

  it('400 body with no "error" field at all falls back to a generic Invalid request message', async () => {
    stubFetch(() => jsonResponse(400, {}));
    const result = await submitAction('ABCD', 'tok', { type: 'pass', seat: 0 });
    expect(result).toEqual({ ok: false, error: { kind: 'validation-error', message: 'Invalid request' } });
  });

  it('an entirely unmapped status code (e.g. 418) degrades to server-error with that status', async () => {
    stubFetch(() => jsonResponse(418, { error: "I'm a teapot" }));
    const result = await getState('ABCD', 'tok');
    expect(result).toEqual({ ok: false, error: { kind: 'server-error', status: 418 } });
  });
});

// --- 5. network-error coverage for every function, not just submitAction -----

describe('network-error resolves (never throws) for every endpoint', () => {
  function rejectingFetch(): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('offline'))),
    );
  }

  it('createGame', async () => {
    rejectingFetch();
    expect(await createGame({ displayName: 'A' })).toEqual({
      ok: false,
      error: { kind: 'network-error', message: 'offline' },
    });
  });

  it('joinGame', async () => {
    rejectingFetch();
    expect(await joinGame('ABCD', { displayName: 'A' })).toEqual({
      ok: false,
      error: { kind: 'network-error', message: 'offline' },
    });
  });

  it('getState', async () => {
    rejectingFetch();
    expect(await getState('ABCD', 'tok')).toEqual({
      ok: false,
      error: { kind: 'network-error', message: 'offline' },
    });
  });

  it('advanceNextHand', async () => {
    rejectingFetch();
    expect(await advanceNextHand('ABCD', 'tok')).toEqual({
      ok: false,
      error: { kind: 'network-error', message: 'offline' },
    });
  });

  it('a rejection with a non-Error value falls back to a generic message rather than throwing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject('raw string rejection')),
    );
    expect(await getState('ABCD', 'tok')).toEqual({
      ok: false,
      error: { kind: 'network-error', message: 'Network request failed' },
    });
  });
});

// --- 6. non-JSON error bodies never throw, for every endpoint ----------------

describe('non-JSON error response bodies degrade to server-error without throwing', () => {
  function nonJsonErrorResponse(status: number): Response {
    return {
      ok: false,
      status,
      json: async () => {
        throw new Error('not json');
      },
    } as unknown as Response;
  }

  it('createGame', async () => {
    stubFetch(() => nonJsonErrorResponse(500));
    expect(await createGame({ displayName: 'A' })).toEqual({
      ok: false,
      error: { kind: 'server-error', status: 500 },
    });
  });

  it('joinGame', async () => {
    stubFetch(() => nonJsonErrorResponse(502));
    expect(await joinGame('ABCD', { displayName: 'A' })).toEqual({
      ok: false,
      error: { kind: 'server-error', status: 502 },
    });
  });

  it('getState', async () => {
    stubFetch(() => nonJsonErrorResponse(503));
    expect(await getState('ABCD', 'tok')).toEqual({
      ok: false,
      error: { kind: 'server-error', status: 503 },
    });
  });

  it('advanceNextHand', async () => {
    stubFetch(() => nonJsonErrorResponse(500));
    expect(await advanceNextHand('ABCD', 'tok')).toEqual({
      ok: false,
      error: { kind: 'server-error', status: 500 },
    });
  });
});
