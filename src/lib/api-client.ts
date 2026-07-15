/**
 * Typed fetch wrapper around the /api/games/** routes. Pure client-side
 * plumbing: no React, no engine logic, no reads of session.ts — every
 * function takes whatever tokens it needs as explicit parameters so this
 * module stays trivially testable and has no hidden dependency on browser
 * storage.
 *
 * Every route's exact success/error body shape was confirmed by reading the
 * live route handlers under src/app/api/games/** (not guessed):
 *  - POST /api/games                      → 201 CreateGameResponse; 400 string or {type:'validation-error',message} error bodies.
 *  - POST /api/games/{code}/join          → 200 JoinGameResponse; 400 string errors; 404 {error:'not-found'}; 409 {error:'game-full'|'already-started'}.
 *  - GET  /api/games/{code}/state         → 200 bare ClientGameView; 401 {error:'unauthorized'} (covers missing/bad token AND a token/game mismatch — the
 *                                            route never returns seat-mismatch here); 404 {error:'not-found'}.
 *  - POST /api/games/{code}/actions       → 200 SubmitActionResponse ({seq, view}); 401 unauthorized; 400 string 'invalid-json' or {type:'validation-error',message};
 *                                            403 {error:'seat-mismatch'}; 409 {error: RuleError}; 500 {error:{type:'internal-error',message}}.
 *  - POST /api/games/{code}/next-hand     → 200 bare ClientGameView (confirmed against the current route.ts source — NOT {seq, view}); 401 unauthorized;
 *                                            404 not-found; 409 {error:'hand-not-over'|'game-finished'} (a bare string, unlike actions' RuleError object);
 *                                            500 {error:{type:'internal-error',...}}.
 *
 * The 409 body shape differs by endpoint (RuleError object for actions,
 * plain reason strings for join and next-hand), so the shared `parseError`
 * below takes an `ErrorContext` hint to disambiguate — a single
 * status-code-only mapping cannot tell these apart.
 */

import type {
  ClientGameView,
  CreateGameRequest,
  CreateGameResponse,
  JoinGameRequest,
  JoinGameResponse,
  SubmitActionResponse,
} from './protocol';
import type { GameAction, RuleError } from '../engine/game-state';

export type ApiResult<T> = { readonly ok: true; readonly data: T } | { readonly ok: false; readonly error: ApiError };

/**
 * next-hand's two 409 reasons ('hand-not-over' | 'game-finished') don't fit
 * any of the other ApiError variants cleanly — they're neither a rule
 * violation on a submitted action, nor a validation problem, nor a
 * join-time seating conflict. Folded into one generic `conflict` variant
 * (rather than two bespoke `hand-not-over`/`game-finished` variants) since
 * that keeps the union smaller and every current/likely future caller just
 * needs to show `reason` as-is; a UI that wants distinct copy per reason can
 * still switch on `error.reason`.
 */
export type ApiError =
  | { readonly kind: 'rule-error'; readonly ruleError: RuleError }
  | { readonly kind: 'validation-error'; readonly message: string }
  | { readonly kind: 'unauthorized' }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'seat-mismatch' }
  | { readonly kind: 'join-rejected'; readonly code: 'game-full' | 'already-started' }
  | { readonly kind: 'conflict'; readonly reason: 'hand-not-over' | 'game-finished' }
  | { readonly kind: 'server-error'; readonly status: number }
  | { readonly kind: 'network-error'; readonly message: string };

type ErrorContext = 'join' | 'action' | 'next-hand' | 'generic';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function extractErrorField(body: unknown): unknown {
  if (isPlainObject(body) && 'error' in body) return body.error;
  return undefined;
}

function isRuleErrorBody(value: unknown): value is RuleError {
  return (
    isPlainObject(value) &&
    value.type === 'rule-error' &&
    typeof value.code === 'string' &&
    typeof value.message === 'string'
  );
}

function isValidationErrorBody(value: unknown): value is { readonly type: 'validation-error'; readonly message?: unknown } {
  return isPlainObject(value) && value.type === 'validation-error';
}

function parseError(status: number, body: unknown, context: ErrorContext): ApiError {
  const errorField = extractErrorField(body);

  if (status === 401) return { kind: 'unauthorized' };
  if (status === 404) return { kind: 'not-found' };
  if (status === 403) return { kind: 'seat-mismatch' };

  if (status === 400) {
    if (isValidationErrorBody(errorField)) {
      const message = typeof errorField.message === 'string' ? errorField.message : 'Invalid request';
      return { kind: 'validation-error', message };
    }
    if (typeof errorField === 'string') {
      return { kind: 'validation-error', message: errorField };
    }
    return { kind: 'validation-error', message: 'Invalid request' };
  }

  if (status === 409) {
    if (context === 'join' && (errorField === 'game-full' || errorField === 'already-started')) {
      return { kind: 'join-rejected', code: errorField };
    }
    if (context === 'next-hand' && (errorField === 'hand-not-over' || errorField === 'game-finished')) {
      return { kind: 'conflict', reason: errorField };
    }
    if (context === 'action' && isRuleErrorBody(errorField)) {
      return { kind: 'rule-error', ruleError: errorField };
    }
    // Unrecognized 409 shape for this context — degrade rather than guess.
    return { kind: 'server-error', status };
  }

  return { kind: 'server-error', status };
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

async function doFetch(input: string, init: RequestInit | undefined, context: ErrorContext): Promise<ApiResult<unknown>> {
  let response: Response;
  try {
    response = await fetch(input, init);
  } catch (err) {
    return {
      ok: false,
      error: { kind: 'network-error', message: err instanceof Error ? err.message : 'Network request failed' },
    };
  }

  const body = await safeJson(response);

  if (!response.ok) {
    return { ok: false, error: parseError(response.status, body, context) };
  }

  return { ok: true, data: body };
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

export async function createGame(req: CreateGameRequest): Promise<ApiResult<CreateGameResponse>> {
  const result = await doFetch(
    '/api/games',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    },
    'generic',
  );
  return result as ApiResult<CreateGameResponse>;
}

export async function joinGame(code: string, req: JoinGameRequest): Promise<ApiResult<JoinGameResponse>> {
  const result = await doFetch(
    `/api/games/${encodeURIComponent(code)}/join`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    },
    'join',
  );
  return result as ApiResult<JoinGameResponse>;
}

export async function getState(code: string, token: string): Promise<ApiResult<ClientGameView>> {
  const result = await doFetch(
    `/api/games/${encodeURIComponent(code)}/state`,
    { method: 'GET', headers: authHeaders(token) },
    'generic',
  );
  return result as ApiResult<ClientGameView>;
}

export async function submitAction(
  code: string,
  token: string,
  action: GameAction,
): Promise<ApiResult<SubmitActionResponse>> {
  const result = await doFetch(
    `/api/games/${encodeURIComponent(code)}/actions`,
    {
      method: 'POST',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    },
    'action',
  );
  return result as ApiResult<SubmitActionResponse>;
}

/**
 * The response is a bare ClientGameView (not {seq, view}) — confirmed
 * directly against src/app/api/games/[code]/next-hand/route.ts's
 * `return Response.json(view, { status: 200 })`.
 */
export async function advanceNextHand(code: string, token: string): Promise<ApiResult<ClientGameView>> {
  const result = await doFetch(
    `/api/games/${encodeURIComponent(code)}/next-hand`,
    { method: 'POST', headers: authHeaders(token) },
    'next-hand',
  );
  return result as ApiResult<ClientGameView>;
}

export function gameStreamUrl(code: string, token: string, sinceSeq: number): string {
  return `/api/games/${encodeURIComponent(code)}/stream?since=${sinceSeq}&token=${encodeURIComponent(token)}`;
}
