/**
 * Adversarial/edge-case coverage for session.ts, beyond the builder's 7
 * tests in session.test.ts. See the Phase 4 plumbing review task: string-
 * typed numeric fields, missing-field-by-field coverage, save-overwrite
 * semantics, and a throwing getItem (not just a throwing setItem).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearSession, loadSession, saveSession, type GameSession } from './session';

const STORAGE_KEY = 'frc-mahjong:session:v1';

class FakeLocalStorage implements Storage {
  private store = new Map<string, string>();

  get length(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }

  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }

  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
}

const sampleSession: GameSession = {
  roomCode: 'ABCD',
  seat: 1,
  playerToken: 'token-123',
  displayName: 'Alice',
};

describe('session edge cases', () => {
  let fakeStorage: FakeLocalStorage;

  beforeEach(() => {
    fakeStorage = new FakeLocalStorage();
    vi.stubGlobal('window', { localStorage: fakeStorage });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects a seat stored as a numeric string ("1") rather than a number', () => {
    fakeStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ roomCode: 'ABCD', seat: '1', playerToken: 'tok', displayName: 'Alice' }),
    );
    expect(loadSession()).toBeNull();
    expect(fakeStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('rejects seat "0" as a string too (falsy-but-valid-looking edge)', () => {
    fakeStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ roomCode: 'ABCD', seat: '0', playerToken: 'tok', displayName: 'Alice' }),
    );
    expect(loadSession()).toBeNull();
  });

  const fields: readonly (keyof GameSession)[] = ['roomCode', 'seat', 'playerToken', 'displayName'];

  for (const missingField of fields) {
    it(`rejects a session missing exactly the "${missingField}" field`, () => {
      const full: Record<string, unknown> = { ...sampleSession };
      delete full[missingField];
      fakeStorage.setItem(STORAGE_KEY, JSON.stringify(full));
      expect(loadSession()).toBeNull();
      expect(fakeStorage.getItem(STORAGE_KEY)).toBeNull();
    });
  }

  it('rejects an empty-string roomCode/playerToken/displayName (non-empty-string check)', () => {
    fakeStorage.setItem(STORAGE_KEY, JSON.stringify({ ...sampleSession, roomCode: '' }));
    expect(loadSession()).toBeNull();

    fakeStorage.setItem(STORAGE_KEY, JSON.stringify({ ...sampleSession, playerToken: '' }));
    expect(loadSession()).toBeNull();

    fakeStorage.setItem(STORAGE_KEY, JSON.stringify({ ...sampleSession, displayName: '' }));
    expect(loadSession()).toBeNull();
  });

  it('rejects seat values outside 0-3, including negative and non-integer', () => {
    fakeStorage.setItem(STORAGE_KEY, JSON.stringify({ ...sampleSession, seat: -1 }));
    expect(loadSession()).toBeNull();

    fakeStorage.setItem(STORAGE_KEY, JSON.stringify({ ...sampleSession, seat: 4 }));
    expect(loadSession()).toBeNull();

    fakeStorage.setItem(STORAGE_KEY, JSON.stringify({ ...sampleSession, seat: 1.5 }));
    expect(loadSession()).toBeNull();

    fakeStorage.setItem(STORAGE_KEY, JSON.stringify({ ...sampleSession, seat: null }));
    expect(loadSession()).toBeNull();
  });

  it('saveSession called twice in a row overwrites, not merges, the previous session', () => {
    saveSession(sampleSession);
    const second: GameSession = {
      roomCode: 'WXYZ',
      seat: 3,
      playerToken: 'token-999',
      displayName: 'Bob',
    };
    saveSession(second);

    const loaded = loadSession();
    expect(loaded).toEqual(second);
    // Explicitly assert no residue of the first session's fields leaked through.
    expect(loaded?.roomCode).not.toBe(sampleSession.roomCode);
    expect(loaded?.displayName).not.toBe(sampleSession.displayName);
  });

  it('loadSession returns null (and does not throw) if localStorage.getItem itself throws', () => {
    vi.spyOn(fakeStorage, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError: storage disabled');
    });
    expect(() => loadSession()).not.toThrow();
    expect(loadSession()).toBeNull();
  });

  it('a top-level array (not an object) is rejected as invalid shape', () => {
    fakeStorage.setItem(STORAGE_KEY, JSON.stringify([sampleSession]));
    expect(loadSession()).toBeNull();
  });

  it('a bare JSON primitive (e.g. the number 5, or "null") is rejected as invalid shape', () => {
    fakeStorage.setItem(STORAGE_KEY, '5');
    expect(loadSession()).toBeNull();

    fakeStorage.setItem(STORAGE_KEY, 'null');
    expect(loadSession()).toBeNull();
  });

  it('clearSession after saveSession leaves loadSession returning null (round-trip sanity)', () => {
    saveSession(sampleSession);
    expect(loadSession()).toEqual(sampleSession);
    clearSession();
    expect(loadSession()).toBeNull();
  });
});
