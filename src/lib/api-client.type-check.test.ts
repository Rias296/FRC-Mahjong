/**
 * Compile-time verification that ApiResult<T>'s discriminated union actually
 * narrows on `ok`. This file's assertions are load-bearing at COMPILE time,
 * not just runtime: if the discrimination were broken (e.g. `ok` were widened
 * to `boolean` instead of the literal `true`/`false`, or `data`/`error` were
 * both always present), `npx tsc --noEmit` would fail on the `@ts-expect-error`
 * lines below (because there would be no error to "expect"), and the
 * `expectTypeMatch` assignments would fail because a wrongly-widened type is
 * not assignable to the narrow target type.
 *
 * The `it` blocks themselves also execute as ordinary runtime tests so this
 * file participates in `npm run test` too, not just `tsc --noEmit`.
 */
import { describe, expect, it } from 'vitest';
import type { ApiError, ApiResult } from './api-client';
import type { CreateGameResponse } from './protocol';

// Forces an exact-type check (not just "assignable") so a widened/`any`
// leak in the narrowed branch is also caught — `any` is assignable to
// everything, which would silently defeat a plain assignment check.
type Exact<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
function expectExactType<A, B>(matches: Exact<A, B>): void {
  void matches; // Type-level only; no runtime behavior.
}

function narrowOk(result: ApiResult<CreateGameResponse>): CreateGameResponse {
  if (result.ok) {
    // `.data` must be accessible and typed as CreateGameResponse here.
    const data: CreateGameResponse = result.data;
    expectExactType<typeof data, CreateGameResponse>(true);

    // @ts-expect-error — `.error` must NOT exist on the ok:true branch; if
    // the union were not properly discriminated (e.g. both fields optional
    // on a single flat type) this property access would compile cleanly and
    // the ts-expect-error directive itself would then fail to compile,
    // failing `tsc --noEmit`.
    const leaked = result.error;
    void leaked;

    return data;
  }

  // `.error` must be accessible and typed as ApiError here.
  const err: ApiError = result.error;
  expectExactType<typeof err, ApiError>(true);

  // @ts-expect-error — `.data` must NOT exist on the ok:false branch.
  const leaked2 = result.data;
  void leaked2;

  throw new Error(err.kind);
}

describe('ApiResult discriminated union (compile-time narrowing)', () => {
  it('narrows result.data on the ok:true branch and rejects result.error there', () => {
    const okResult: ApiResult<CreateGameResponse> = {
      ok: true,
      data: {
        roomCode: 'ABCD',
        seat: 0,
        playerToken: 'tok',
        rules: {} as CreateGameResponse['rules'],
        status: 'waiting-for-players',
      },
    };
    expect(narrowOk(okResult).roomCode).toBe('ABCD');
  });

  it('narrows result.error on the ok:false branch and rejects result.data there', () => {
    const errResult: ApiResult<CreateGameResponse> = {
      ok: false,
      error: { kind: 'not-found' },
    };
    expect(() => narrowOk(errResult)).toThrow('not-found');
  });

  it('every ApiError kind is a distinct literal reachable via exhaustive switch (compile-time exhaustiveness)', () => {
    function describeError(error: ApiError): string {
      switch (error.kind) {
        case 'rule-error':
          return error.ruleError.code;
        case 'validation-error':
          return error.message;
        case 'unauthorized':
          return 'unauthorized';
        case 'not-found':
          return 'not-found';
        case 'seat-mismatch':
          return 'seat-mismatch';
        case 'join-rejected':
          return error.code;
        case 'conflict':
          return error.reason;
        case 'server-error':
          return String(error.status);
        case 'network-error':
          return error.message;
        default: {
          // Exhaustiveness guard: if ApiError ever grows a new variant
          // without a case above, `error` here is not `never` and this
          // line fails to compile.
          const exhaustive: never = error;
          throw new Error(`Unhandled ApiError kind: ${JSON.stringify(exhaustive)}`);
        }
      }
    }

    expect(describeError({ kind: 'not-found' })).toBe('not-found');
    expect(describeError({ kind: 'seat-mismatch' })).toBe('seat-mismatch');
    expect(describeError({ kind: 'join-rejected', code: 'game-full' })).toBe('game-full');
    expect(describeError({ kind: 'conflict', reason: 'hand-not-over' })).toBe('hand-not-over');
    expect(describeError({ kind: 'server-error', status: 500 })).toBe('500');
  });
});
