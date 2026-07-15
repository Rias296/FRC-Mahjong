/**
 * Room-code normalization and validation shared by every lobby entry point
 * (home page's join form, the room page's URL param, the room-page recovery
 * join form). Pure string logic only — no React, no fetch.
 *
 * The alphabet below is copied verbatim from `ROOM_CODE_ALPHABET` in
 * src/server/games.ts (excludes 0/O/1/I/L to avoid visually-ambiguous room
 * codes) — keep these two in sync if the server's alphabet ever changes.
 */

const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const ROOM_CODE_LENGTH = 6;

const ROOM_CODE_PATTERN = new RegExp(`^[${ROOM_CODE_ALPHABET}]{${ROOM_CODE_LENGTH}}$`);

/** Trims whitespace and uppercases — the canonical form every caller should validate/compare. */
export function normalizeRoomCode(raw: string): string {
  return raw.trim().toUpperCase();
}

/** True iff `code` is exactly a 6-character code drawn from the room-code alphabet. Callers must normalize first. */
export function isValidRoomCode(code: string): boolean {
  return ROOM_CODE_PATTERN.test(code);
}
