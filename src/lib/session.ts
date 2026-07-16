/**
 * Client-side session persistence for the single active game a player has
 * joined — a room code, seat, player token, and display name, stored in
 * localStorage so a page refresh doesn't lose the player's place at the
 * table. Pure browser-storage plumbing: no React, no fetch, no engine
 * imports beyond the `Seat` type.
 *
 * SSR-safe: every export guards `typeof window === 'undefined'` first (this
 * module may be imported from code that also runs during server rendering).
 * All storage access is wrapped in try/catch — Safari private-mode quota
 * errors, disabled storage, and corrupt JSON must never throw out of this
 * module.
 */

import type { Seat } from '../engine/seats';

export interface GameSession {
  readonly roomCode: string;
  readonly seat: Seat;
  readonly playerToken: string;
  readonly displayName: string;
}

const STORAGE_KEY = 'frc-mahjong:session:v1';

function hasLocalStorage(): boolean {
  return typeof window !== 'undefined' && !!window.localStorage;
}

function isValidSeat(value: unknown): value is Seat {
  return value === 0 || value === 1 || value === 2 || value === 3;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isValidSession(value: unknown): value is GameSession {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    isNonEmptyString(v.roomCode) &&
    isValidSeat(v.seat) &&
    isNonEmptyString(v.playerToken) &&
    isNonEmptyString(v.displayName)
  );
}

export function loadSession(): GameSession | null {
  if (!hasLocalStorage()) return null;

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      window.localStorage.removeItem(STORAGE_KEY);
      return null;
    }

    if (!isValidSession(parsed)) {
      window.localStorage.removeItem(STORAGE_KEY);
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

export function saveSession(session: GameSession): void {
  if (!hasLocalStorage()) return;

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    // Quota exceeded, private-mode restrictions, etc. — never throw from here.
  }
}

export function clearSession(): void {
  if (!hasLocalStorage()) return;

  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Never throw from here.
  }
}

// --- ProfileSession ---------------------------------------------------------
//
// A SEPARATE, additive localStorage entry for the ranked-ladder cross-match
// player identity (see docs/DECISIONS.md's "ranked-ladder sign-off" entry).
// Deliberately a distinct key/type from GameSession above: a GameSession is
// scoped to a single active game (room code, seat, per-game token); a
// ProfileSession is a long-lived identity that outlives any one game and is
// never cleared alongside it. Same SSR-safe try/catch discipline throughout.

export interface ProfileSession {
  readonly profileId: string;
  readonly profileToken: string;
  readonly displayName: string;
}

const PROFILE_STORAGE_KEY = 'frc-mahjong:profile:v1';

function isValidProfileSession(value: unknown): value is ProfileSession {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return isNonEmptyString(v.profileId) && isNonEmptyString(v.profileToken) && isNonEmptyString(v.displayName);
}

export function loadProfileSession(): ProfileSession | null {
  if (!hasLocalStorage()) return null;

  try {
    const raw = window.localStorage.getItem(PROFILE_STORAGE_KEY);
    if (raw === null) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      window.localStorage.removeItem(PROFILE_STORAGE_KEY);
      return null;
    }

    if (!isValidProfileSession(parsed)) {
      window.localStorage.removeItem(PROFILE_STORAGE_KEY);
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

export function saveProfileSession(session: ProfileSession): void {
  if (!hasLocalStorage()) return;

  try {
    window.localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(session));
  } catch {
    // Quota exceeded, private-mode restrictions, etc. — never throw from here.
  }
}

export function clearProfileSession(): void {
  if (!hasLocalStorage()) return;

  try {
    window.localStorage.removeItem(PROFILE_STORAGE_KEY);
  } catch {
    // Never throw from here.
  }
}
