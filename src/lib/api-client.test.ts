import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  advanceNextHand,
  createGame,
  gameStreamUrl,
  getState,
  joinGame,
  submitAction,
} from './api-client';
import type { ClientGameView, CreateGameResponse, JoinGameResponse, SubmitActionResponse } from './protocol';
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

describe('createGame', () => {
  it('POSTs displayName and returns ok with CreateGameResponse on 201', async () => {
    const response: CreateGameResponse = {
      roomCode: 'ABCD',
      seat: 0,
      playerToken: 'tok',
      rules: {} as CreateGameResponse['rules'],
      status: 'waiting-for-players',
    };
    let capturedInput = '';
    let capturedInit: RequestInit | undefined;
    stubFetch((input, init) => {
      capturedInput = input;
      capturedInit = init;
      return jsonResponse(201, response);
    });

    const result = await createGame({ displayName: 'Alice' });

    expect(capturedInput).toBe('/api/games');
    expect(capturedInit?.method).toBe('POST');
    expect(JSON.parse(capturedInit?.body as string)).toEqual({ displayName: 'Alice' });
    expect(result).toEqual({ ok: true, data: response });
  });
});

describe('joinGame', () => {
  it('maps 409 string errors to join-rejected with code game-full / already-started', async () => {
    stubFetch(() => jsonResponse(409, { error: 'game-full' }));
    const r1 = await joinGame('ABCD', { displayName: 'Bob' });
    expect(r1).toEqual({ ok: false, error: { kind: 'join-rejected', code: 'game-full' } });

    stubFetch(() => jsonResponse(409, { error: 'already-started' }));
    const r2 = await joinGame('ABCD', { displayName: 'Bob' });
    expect(r2).toEqual({ ok: false, error: { kind: 'join-rejected', code: 'already-started' } });
  });

  it('maps 404 to not-found', async () => {
    stubFetch(() => jsonResponse(404, { error: 'not-found' }));
    const result = await joinGame('ZZZZ', { displayName: 'Bob' });
    expect(result).toEqual({ ok: false, error: { kind: 'not-found' } });
  });

  it('returns ok with JoinGameResponse on 200', async () => {
    const response: JoinGameResponse = {
      roomCode: 'ABCD',
      seat: 1,
      playerToken: 'tok2',
      rules: {} as JoinGameResponse['rules'],
      status: 'waiting-for-players',
    };
    stubFetch(() => jsonResponse(200, response));
    const result = await joinGame('ABCD', { displayName: 'Bob' });
    expect(result).toEqual({ ok: true, data: response });
  });
});

describe('getState', () => {
  it('sends Authorization Bearer header and returns ClientGameView on 200', async () => {
    let capturedInit: RequestInit | undefined;
    stubFetch((_input, init) => {
      capturedInit = init;
      return jsonResponse(200, sampleView);
    });

    const result = await getState('ABCD', 'tok-abc');

    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok-abc');
    expect(result).toEqual({ ok: true, data: sampleView });
  });

  it('maps 401 to unauthorized and 404 to not-found', async () => {
    stubFetch(() => jsonResponse(401, { error: 'unauthorized' }));
    expect(await getState('ABCD', 'bad')).toEqual({ ok: false, error: { kind: 'unauthorized' } });

    stubFetch(() => jsonResponse(404, { error: 'not-found' }));
    expect(await getState('ZZZZ', 'tok')).toEqual({ ok: false, error: { kind: 'not-found' } });
  });
});

describe('submitAction', () => {
  const action: GameAction = { type: 'discard', seat: 0, tileId: 'wan-1-0' };

  it('wraps the action in { action } and returns SubmitActionResponse on 200', async () => {
    const response: SubmitActionResponse = { seq: 6, view: sampleView };
    let capturedInit: RequestInit | undefined;
    stubFetch((_input, init) => {
      capturedInit = init;
      return jsonResponse(200, response);
    });

    const result = await submitAction('ABCD', 'tok', action);

    expect(JSON.parse(capturedInit?.body as string)).toEqual({ action });
    expect(result).toEqual({ ok: true, data: response });
  });

  it('maps 409 RuleError body to rule-error preserving code and message', async () => {
    const ruleError: RuleError = { type: 'rule-error', code: 'wrong-phase', message: 'Not your turn' };
    stubFetch(() => jsonResponse(409, { error: ruleError }));

    const result = await submitAction('ABCD', 'tok', action);

    expect(result).toEqual({ ok: false, error: { kind: 'rule-error', ruleError } });
  });

  it('maps 400 validation-error object to validation-error with message', async () => {
    stubFetch(() =>
      jsonResponse(400, { error: { type: 'validation-error', message: 'The action payload does not match' } }),
    );

    const result = await submitAction('ABCD', 'tok', action);

    expect(result).toEqual({
      ok: false,
      error: { kind: 'validation-error', message: 'The action payload does not match' },
    });
  });

  it('maps 403 to seat-mismatch', async () => {
    stubFetch(() => jsonResponse(403, { error: 'seat-mismatch' }));
    const result = await submitAction('ABCD', 'tok', action);
    expect(result).toEqual({ ok: false, error: { kind: 'seat-mismatch' } });
  });

  it('maps 500 internal-error to server-error with status', async () => {
    stubFetch(() => jsonResponse(500, { error: { type: 'internal-error', message: 'boom' } }));
    const result = await submitAction('ABCD', 'tok', action);
    expect(result).toEqual({ ok: false, error: { kind: 'server-error', status: 500 } });
  });

  it('resolves to network-error without throwing when fetch rejects', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('offline'))),
    );

    const result = await submitAction('ABCD', 'tok', action);

    expect(result).toEqual({ ok: false, error: { kind: 'network-error', message: 'offline' } });
  });

  it('degrades a non-JSON error body to server-error without throwing', async () => {
    stubFetch(
      () =>
        ({
          ok: false,
          status: 500,
          json: async () => {
            throw new Error('not json');
          },
        }) as unknown as Response,
    );

    const result = await submitAction('ABCD', 'tok', action);

    expect(result).toEqual({ ok: false, error: { kind: 'server-error', status: 500 } });
  });
});

describe('advanceNextHand', () => {
  it('returns a bare ClientGameView on 200 (per the actual next-hand route response shape)', async () => {
    stubFetch(() => jsonResponse(200, sampleView));
    const result = await advanceNextHand('ABCD', 'tok');
    expect(result).toEqual({ ok: true, data: sampleView });
  });

  it('maps 409 hand-not-over / game-finished to a conflict error', async () => {
    stubFetch(() => jsonResponse(409, { error: 'hand-not-over' }));
    const r1 = await advanceNextHand('ABCD', 'tok');
    expect(r1).toEqual({ ok: false, error: { kind: 'conflict', reason: 'hand-not-over' } });

    stubFetch(() => jsonResponse(409, { error: 'game-finished' }));
    const r2 = await advanceNextHand('ABCD', 'tok');
    expect(r2).toEqual({ ok: false, error: { kind: 'conflict', reason: 'game-finished' } });
  });
});

describe('gameStreamUrl', () => {
  it('encodes room code and token and includes since', () => {
    const url = gameStreamUrl('AB CD', 'tok en?', 42);
    expect(url).toBe(`/api/games/${encodeURIComponent('AB CD')}/stream?since=42&token=${encodeURIComponent('tok en?')}`);
  });
});
