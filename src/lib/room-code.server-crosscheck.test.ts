/**
 * Cross-check between the CLIENT-side alphabet/pattern in room-code.ts and
 * the SERVER-side `ROOM_CODE_ALPHABET` in src/server/games.ts's private
 * `generateRoomCode`. games.ts does not export its alphabet (kept private,
 * by design — the doc comment in room-code.ts says the client copy must be
 * "kept in sync if the server's alphabet ever changes"), so a plain string
 * comparison isn't possible from a client-only test. Instead this test
 * drives the REAL server code path (createGame -> generateRoomCode, backed
 * by an in-memory Turso DB, same pattern as src/server/join-race.test.ts)
 * many times and asserts every single server-generated code is accepted by
 * the client's `isValidRoomCode`. If a future edit changes one alphabet but
 * not the other, this test starts failing (probabilistically fast, and with
 * high confidence given the sample size below) instead of the two files
 * silently drifting apart.
 */
import { createClient, type Client } from '@libsql/client';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../server/migrations';
import { createGame } from '../server/games';
import { isValidRoomCode, normalizeRoomCode } from './room-code';

async function freshDb(): Promise<Client> {
  const db = createClient({ url: ':memory:' });
  await runMigrations(db);
  return db;
}

describe('room-code.ts alphabet vs. server games.ts alphabet (cross-check)', () => {
  it('every server-generated room code validates as-is against the client pattern (no normalization needed)', async () => {
    const db = await freshDb();
    const sampleSize = 40;

    for (let i = 0; i < sampleSize; i++) {
      const created = await createGame(db, { displayName: `Player${i}` });
      expect(created.roomCode).toHaveLength(6);
      // Already-canonical: normalizing should be a no-op, and the raw
      // server output must pass validation without any client-side cleanup.
      expect(normalizeRoomCode(created.roomCode)).toBe(created.roomCode);
      expect(isValidRoomCode(created.roomCode)).toBe(true);
    }
  }, 20000);

  it('server-generated codes never contain any of the excluded ambiguous characters (0, O, 1, I, L)', async () => {
    const db = await freshDb();
    const sampleSize = 40;
    const excluded = ['0', 'O', '1', 'I', 'L'];

    for (let i = 0; i < sampleSize; i++) {
      const created = await createGame(db, { displayName: `Player${i}` });
      for (const char of excluded) {
        expect(created.roomCode).not.toContain(char);
      }
    }
  }, 20000);
});
