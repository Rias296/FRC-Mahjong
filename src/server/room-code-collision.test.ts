/**
 * Tester-authored coverage for round-1 review brief item 6: is
 * createGame's retry-on-UNIQUE-room-code-collision logic actually
 * reachable/exercised, given the astronomically low odds of a real
 * collision from 6 random alphabet draws? This forces a real collision by
 * mocking node:crypto's randomInt (a dependency, not application code) to
 * return a controlled sequence, so generateRoomCode() produces the SAME
 * code twice in a row before producing a distinct one.
 */
import { createClient, type Client } from '@libsql/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runMigrations } from './migrations';

const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

// Queue of forced return values for randomInt(0, n); once drained, falls
// back to the real implementation so unrelated randomInt use (e.g. the
// seed generation elsewhere) still works.
let forcedQueue: number[] = [];

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    randomInt: (...args: unknown[]) => {
      if (forcedQueue.length > 0) {
        return forcedQueue.shift() as number;
      }
      return (actual.randomInt as (...a: unknown[]) => number)(...args);
    },
  };
});

async function freshDb(): Promise<Client> {
  const db = createClient({ url: ':memory:' });
  await runMigrations(db);
  return db;
}

beforeEach(() => {
  forcedQueue = [];
});

describe('createGame room-code collision retry', () => {
  it('retries room-code generation and succeeds after a forced UNIQUE collision', async () => {
    // Import after the mock is set up (vi.mock is hoisted, but re-import per
    // test file is fine here since this file only imports games.ts once).
    const { createGame } = await import('./games');

    const db = await freshDb();

    // First game: force 6 draws of index 0 -> room code 'AAAAAA'.
    forcedQueue = [0, 0, 0, 0, 0, 0];
    const first = await createGame(db, { displayName: 'Alice' });
    expect(first.roomCode).toBe(ROOM_CODE_ALPHABET[0].repeat(6));

    // Second game: attempt 1 forces the SAME 6 draws (index 0 again) -> a
    // genuine UNIQUE(room_code) collision against the first game. Attempt 2
    // forces a different code (index 1 for every draw) -> succeeds.
    forcedQueue = [0, 0, 0, 0, 0, 0, /* attempt 2 */ 1, 1, 1, 1, 1, 1];
    const second = await createGame(db, { displayName: 'Bob' });

    expect(second.roomCode).not.toBe(first.roomCode);
    expect(second.roomCode).toBe(ROOM_CODE_ALPHABET[1].repeat(6));
    expect(forcedQueue.length).toBe(0); // both forced sequences were actually consumed

    // Both games actually exist and are independently addressable.
    const { getGameByRoomCode } = await import('./games');
    const fetchedFirst = await getGameByRoomCode(db, first.roomCode);
    const fetchedSecond = await getGameByRoomCode(db, second.roomCode);
    expect(fetchedFirst?.gameId).toBe(first.gameId);
    expect(fetchedSecond?.gameId).toBe(second.gameId);
  });

  it('gives up after MAX_ROOM_CODE_ATTEMPTS consecutive collisions rather than looping forever', async () => {
    const { createGame } = await import('./games');
    const db = await freshDb();

    forcedQueue = [0, 0, 0, 0, 0, 0];
    const first = await createGame(db, { displayName: 'Alice' });
    expect(first.roomCode).toBe(ROOM_CODE_ALPHABET[0].repeat(6));

    // Force every subsequent attempt (well beyond MAX_ROOM_CODE_ATTEMPTS=5)
    // to collide with the same code.
    forcedQueue = new Array(60).fill(0);
    await expect(createGame(db, { displayName: 'Bob' })).rejects.toThrow(/exhausted/);
  });
});
