/**
 * POST /api/games/[code]/actions — submits one player intent (draw, discard,
 * claim, pass, kong declarations, rob) against the game's current hand. All
 * rule validation and the optimistic-concurrency write path live in
 * src/server/replay.ts's submitAction; this route only authenticates, checks
 * the caller isn't spoofing another seat, and shapes the response.
 */

import { getDb } from '@/server/db';
import { getGameByRoomCode, listPlayers, resolvePlayerToken } from '@/server/games';
import { getMatchSnapshot, submitAction } from '@/server/replay';
import type { GameAction, GameState, RuleError } from '@/engine/game-state';
import { toClientView } from '@/server/views';
import { isValidGameAction, type SubmitActionResponse } from '@/lib/protocol';

/** Route-local shape check, used only to safely reach into a parsed-JSON `unknown` body. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Duplicated per-route-file convention (see src/engine/*.test.ts). */
function extractBearerToken(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1] : null;
}

/**
 * submitAction's success case is `{ state, handNumber, lastSeq }`, not a bare
 * GameState, so the engine's own `isRuleError` (typed against
 * `GameState | RuleError`) doesn't directly apply to its return type. Same
 * narrowing pattern as replay.test.ts's local `isSubmitRuleError`.
 */
function isSubmitRuleError(
  r: { readonly state: GameState; readonly handNumber: number; readonly lastSeq: number } | RuleError,
): r is RuleError {
  return 'type' in r && r.type === 'rule-error';
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ code: string }> },
): Promise<Response> {
  const { code } = await params;

  const token = extractBearerToken(request);
  if (token === null) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  const db = getDb();
  const resolved = await resolvePlayerToken(db, token);
  if (resolved === null) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  const game = await getGameByRoomCode(db, code);
  if (game === null) {
    return Response.json({ error: 'not-found' }, { status: 404 });
  }
  if (resolved.gameId !== game.gameId) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'invalid-json' }, { status: 400 });
  }

  // Structural validation against the real GameAction discriminated union —
  // NOT just "type is a string" — before this ever reaches applyAction.
  // Two confirmed crash paths this closes: (1) a type string that matches no
  // GameAction union member, which previously hit applyAction's
  // exhaustiveness-guard `throw` uncaught; (2) a known type (e.g. 'claim')
  // missing its required sub-fields, which previously threw a raw TypeError
  // from inside the corresponding handler. Both now return a clean 400
  // instead of ever calling submitAction.
  const rawAction: unknown = isPlainObject(body) ? body.action : undefined;
  if (!isValidGameAction(rawAction)) {
    return Response.json(
      {
        error: {
          type: 'validation-error',
          message: 'The action payload does not match a known GameAction shape',
        },
      },
      { status: 400 },
    );
  }
  const action: GameAction = rawAction;

  const viewerSeat = resolved.seat;
  if (action.seat !== viewerSeat) {
    return Response.json({ error: 'seat-mismatch' }, { status: 403 });
  }

  // Defense-in-depth: the upfront validation above should already catch both
  // known crash paths before this point, but nothing thrown here should ever
  // propagate out of the route handler uncaught (e.g. a future engine change
  // reintroducing an unguarded path).
  let result: { readonly state: GameState; readonly handNumber: number; readonly lastSeq: number } | RuleError;
  try {
    result = await submitAction(db, game.gameId, action);
  } catch {
    return Response.json(
      { error: { type: 'internal-error', message: 'An unexpected error occurred' } },
      { status: 500 },
    );
  }
  if (isSubmitRuleError(result)) {
    return Response.json({ error: result }, { status: 409 });
  }

  // The response is built from a single getMatchSnapshot read taken AFTER
  // submitAction's write already landed, rather than from submitAction's own
  // returned state/handNumber/lastSeq plus a separate prevailingWind lookup:
  // this is the "every field from ONE snapshot" consistency rule (see
  // docs/DECISIONS.md's "seq can outrun view content" entries). A snapshot
  // taken right after a successful append is guaranteed to include that
  // append (the action log is append-only/monotonic), so this is safe, not a
  // race — and it additionally gives us matchPoints, which submitAction's
  // own return value deliberately does not compute (see getMatchSnapshot's
  // doc comment on why it's kept out of the write path).
  const snapshot = await getMatchSnapshot(db, game.gameId);
  if (snapshot === null) {
    // Unreachable in practice: submitAction just succeeded, which requires
    // an active hand (and therefore at least one action row) to exist.
    return Response.json(
      { error: { type: 'internal-error', message: 'An unexpected error occurred' } },
      { status: 500 },
    );
  }

  const players = await listPlayers(db, game.gameId);
  const status = game.status as 'waiting-for-players' | 'in-progress' | 'finished';

  const view = toClientView(
    snapshot.state,
    viewerSeat,
    players,
    code,
    status,
    snapshot.handNumber,
    snapshot.prevailingWind,
    snapshot.lastSeq,
    snapshot.matchPoints,
  );

  const response: SubmitActionResponse = { seq: snapshot.lastSeq, view };
  return Response.json(response, { status: 200 });
}
