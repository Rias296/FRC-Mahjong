/**
 * GET /api/games/[code]/stream — a Server-Sent-Events feed of "something
 * changed, go re-fetch /state" notifications for one game. Auth is via a
 * `?token=` query param rather than an Authorization header, since the
 * browser's native EventSource cannot set custom request headers.
 *
 * No `maxDuration` export: that is Vercel-specific deploy configuration, not
 * application code, and is deliberately left to deploy config rather than
 * guessed at here.
 */

import { getDb } from '@/server/db';
import { getGameByRoomCode, resolvePlayerToken } from '@/server/games';
import { DbPollingRealtimeSource } from '@/server/realtime';
import { applyTurnTimeouts } from '@/server/turn-timer';

export const dynamic = 'force-dynamic';

const HEARTBEAT_INTERVAL_MS = 15000;

function parseSinceSeq(url: URL): number {
  const raw = url.searchParams.get('since');
  const parsed = raw === null ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ code: string }> },
): Promise<Response> {
  const { code } = await params;
  const url = new URL(request.url);
  const token = url.searchParams.get('token');

  if (!token) {
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

  const sinceSeq = parseSinceSeq(url);

  // Cheap-gated: only wire the turn-timer enforcement hook (and thus only
  // pay for it on every poll tick of THIS connection) when it could
  // possibly matter — using data already loaded above (`game.status`,
  // `game.rules.turnTimerSeconds`), no extra query. `applyTurnTimeouts`
  // itself is a no-op in every case this skips too, but skipping the call
  // entirely avoids re-deriving that from scratch every 1.5s for every
  // waiting-for-players/finished/timer-disabled game's connected clients.
  const enforceTimeouts =
    game.status === 'in-progress' && game.rules.turnTimerSeconds > 0
      ? async (gid: string) => {
          await applyTurnTimeouts(db, gid);
        }
      : undefined;
  const source = new DbPollingRealtimeSource(db, enforceTimeouts);
  const encoder = new TextEncoder();

  // Shared by both `start` and `cancel` below via closure, so a client
  // disconnect (cancel) reliably stops the polling generator promptly
  // rather than waiting out its current poll interval.
  const abortController = new AbortController();
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  const onRequestAbort = (): void => abortController.abort();
  request.signal.addEventListener('abort', onRequestAbort);

  function cleanup(): void {
    if (heartbeatTimer !== undefined) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
    }
    request.signal.removeEventListener('abort', onRequestAbort);
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controllerStream) {
      heartbeatTimer = setInterval(() => {
        try {
          controllerStream.enqueue(encoder.encode(': heartbeat\n\n'));
        } catch {
          // The stream is already closed on the client side; the pump
          // loop's own cleanup (below) will have already run or will shortly.
        }
      }, HEARTBEAT_INTERVAL_MS);

      void (async () => {
        try {
          for await (const event of source.subscribe(game.gameId, sinceSeq, abortController.signal)) {
            controllerStream.enqueue(encoder.encode(`event: change\ndata: ${JSON.stringify(event)}\n\n`));
          }
        } catch (err) {
          if (!abortController.signal.aborted) {
            controllerStream.error(err);
          }
        } finally {
          cleanup();
          try {
            controllerStream.close();
          } catch {
            // Already closed (e.g. the client disconnected first).
          }
        }
      })();
    },
    cancel() {
      abortController.abort();
      cleanup();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
