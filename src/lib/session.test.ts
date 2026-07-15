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

describe('session (with a simulated browser window)', () => {
  let fakeStorage: FakeLocalStorage;

  beforeEach(() => {
    fakeStorage = new FakeLocalStorage();
    vi.stubGlobal('window', { localStorage: fakeStorage });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('saveSession then loadSession round-trips a GameSession', () => {
    saveSession(sampleSession);
    expect(loadSession()).toEqual(sampleSession);
  });

  it('loadSession returns null when no session is stored', () => {
    expect(loadSession()).toBeNull();
  });

  it('loadSession clears and returns null on corrupt JSON', () => {
    fakeStorage.setItem(STORAGE_KEY, '{not valid json');
    expect(loadSession()).toBeNull();
    expect(fakeStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('loadSession clears and returns null on invalid shape (seat out of range, missing token)', () => {
    fakeStorage.setItem(STORAGE_KEY, JSON.stringify({ roomCode: 'ABCD', seat: 7, displayName: 'Alice' }));
    expect(loadSession()).toBeNull();
    expect(fakeStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('clearSession removes the stored key', () => {
    saveSession(sampleSession);
    clearSession();
    expect(fakeStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('saveSession does not throw when localStorage.setItem throws', () => {
    vi.spyOn(fakeStorage, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(() => saveSession(sampleSession)).not.toThrow();
  });
});

describe('session (SSR — window undefined)', () => {
  beforeEach(() => {
    vi.stubGlobal('window', undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('all functions are safe no-ops when window is undefined', () => {
    expect(loadSession()).toBeNull();
    expect(() => saveSession(sampleSession)).not.toThrow();
    expect(() => clearSession()).not.toThrow();
  });
});
