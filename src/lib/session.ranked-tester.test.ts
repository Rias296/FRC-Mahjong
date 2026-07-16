/**
 * Tester round (ranked-ladder UI): targeted gap-fill for session.ts's
 * ProfileSession storage isolation, beyond session.test.ts /
 * session.edge.test.ts's existing coverage. Specifically: corrupt JSON in
 * ONE of the two keys must never disturb valid data sitting in the OTHER
 * key (the existing "separate keys" test in session.test.ts only exercises
 * explicit clear*, not corrupt-JSON self-healing cross-talk).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadProfileSession, loadSession, saveProfileSession, saveSession, type GameSession, type ProfileSession } from './session';

const STORAGE_KEY = 'frc-mahjong:session:v1';
const PROFILE_STORAGE_KEY = 'frc-mahjong:profile:v1';

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

const sampleSession: GameSession = { roomCode: 'ABCD', seat: 1, playerToken: 'tok', displayName: 'Alice' };
const sampleProfile: ProfileSession = { profileId: 'p1', profileToken: 'ptok', displayName: 'Alice' };

let fakeStorage: FakeLocalStorage;

beforeEach(() => {
  fakeStorage = new FakeLocalStorage();
  // @ts-expect-error test-only global stub
  globalThis.window = { localStorage: fakeStorage };
});

afterEach(() => {
  // @ts-expect-error test-only global stub
  delete globalThis.window;
});

describe('ProfileSession / GameSession storage isolation under corruption', () => {
  it('corrupt JSON in the PROFILE key self-heals (clears only that key) without disturbing a valid GameSession', () => {
    saveSession(sampleSession);
    fakeStorage.setItem(PROFILE_STORAGE_KEY, '{not valid json');

    expect(loadProfileSession()).toBeNull();
    expect(fakeStorage.getItem(PROFILE_STORAGE_KEY)).toBeNull();
    // The unrelated GameSession key must be completely untouched.
    expect(loadSession()).toEqual(sampleSession);
    expect(fakeStorage.getItem(STORAGE_KEY)).not.toBeNull();
  });

  it('corrupt JSON in the GAME key self-heals (clears only that key) without disturbing a valid ProfileSession', () => {
    saveProfileSession(sampleProfile);
    fakeStorage.setItem(STORAGE_KEY, '{not valid json');

    expect(loadSession()).toBeNull();
    expect(fakeStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(loadProfileSession()).toEqual(sampleProfile);
    expect(fakeStorage.getItem(PROFILE_STORAGE_KEY)).not.toBeNull();
  });

  it('an invalid-shape ProfileSession (missing displayName) self-heals without disturbing a valid GameSession', () => {
    saveSession(sampleSession);
    fakeStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify({ profileId: 'p1', profileToken: 'tok' }));

    expect(loadProfileSession()).toBeNull();
    expect(loadSession()).toEqual(sampleSession);
  });

  it('a wire value with the GameSession shape stored under the PROFILE key is rejected as invalid (no cross-shape false-positive)', () => {
    // Guards against a hypothetical future bug where the two shapes'
    // structural overlap (both have displayName) causes a mis-typed read to
    // silently "succeed" against the wrong schema.
    fakeStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(sampleSession));
    expect(loadProfileSession()).toBeNull();
  });

  it('a wire value with the ProfileSession shape stored under the GAME key is rejected as invalid (no cross-shape false-positive)', () => {
    fakeStorage.setItem(STORAGE_KEY, JSON.stringify(sampleProfile));
    expect(loadSession()).toBeNull();
  });
});
