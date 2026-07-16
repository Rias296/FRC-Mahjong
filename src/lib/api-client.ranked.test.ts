/**
 * Tester coverage for the ranked-ladder additions to api-client.ts
 * (createProfile / getMyProfile / getApexLeaderboard / ensureProfile),
 * which had zero existing test coverage prior to this file. Follows the
 * same fake-fetch conventions as api-client.test.ts / api-client.edge.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProfile, ensureProfile, getApexLeaderboard, getMyProfile } from './api-client';
import { clearProfileSession, loadProfileSession, saveProfileSession } from './session';
import { RANKED_STRINGS } from './i18n/ranked';
import type { ApexLeaderboardResponse, CreateProfileResponse, ProfileMeResponse } from './protocol';

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function stubFetch(impl: (input: string, init?: RequestInit) => Promise<Response> | Response): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init?: RequestInit) => Promise.resolve(impl(input, init))),
  );
}

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

let fakeStorage: FakeLocalStorage;

beforeEach(() => {
  fakeStorage = new FakeLocalStorage();
  vi.stubGlobal('window', { localStorage: fakeStorage });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createProfile', () => {
  it('POSTs { displayName } with no Authorization header and returns CreateProfileResponse on 201', async () => {
    const response: CreateProfileResponse = { profileId: 'p1', profileToken: 'ptok' };
    let capturedInput = '';
    let capturedInit: RequestInit | undefined;
    stubFetch((input, init) => {
      capturedInput = input;
      capturedInit = init;
      return jsonResponse(201, response);
    });

    const result = await createProfile('Alice');

    expect(capturedInput).toBe('/api/profiles');
    expect(capturedInit?.method).toBe('POST');
    expect(JSON.parse(capturedInit?.body as string)).toEqual({ displayName: 'Alice' });
    const headers = capturedInit?.headers as Record<string, string> | undefined;
    expect(Object.keys(headers ?? {}).map((h) => h.toLowerCase())).not.toContain('authorization');
    expect(result).toEqual({ ok: true, data: response });
  });

  it('maps 400 { error: "displayName is required" } to validation-error', async () => {
    stubFetch(() => jsonResponse(400, { error: 'displayName is required' }));
    const result = await createProfile('');
    expect(result).toEqual({
      ok: false,
      error: { kind: 'validation-error', message: 'displayName is required' },
    });
  });
});

describe('getMyProfile', () => {
  it('sends Authorization Bearer header and returns ProfileMeResponse on 200', async () => {
    const response: ProfileMeResponse = {
      profileId: 'p1',
      displayName: 'Alice',
      rankPoints: 350,
      tier: 'bronze',
      division: 2,
    };
    let capturedInit: RequestInit | undefined;
    stubFetch((_input, init) => {
      capturedInit = init;
      return jsonResponse(200, response);
    });

    const result = await getMyProfile('ptok');

    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer ptok');
    expect(result).toEqual({ ok: true, data: response });
  });

  it('maps 401 to unauthorized', async () => {
    stubFetch(() => jsonResponse(401, { error: 'unauthorized' }));
    const result = await getMyProfile('bad-token');
    expect(result).toEqual({ ok: false, error: { kind: 'unauthorized' } });
  });
});

describe('getApexLeaderboard', () => {
  it('GETs /api/leaderboard/apex with no Authorization header and returns both orderings', async () => {
    const response: ApexLeaderboardResponse = {
      foundingOrder: [{ profileId: 'p1', displayName: 'Alice', rankPoints: 4500, apexAttainedAt: 1000 }],
      rpOrder: [{ profileId: 'p1', displayName: 'Alice', rankPoints: 4500, apexAttainedAt: 1000 }],
    };
    let capturedInput = '';
    let capturedInit: RequestInit | undefined;
    stubFetch((input, init) => {
      capturedInput = input;
      capturedInit = init;
      return jsonResponse(200, response);
    });

    const result = await getApexLeaderboard();

    expect(capturedInput).toBe('/api/leaderboard/apex');
    const headers = capturedInit?.headers as Record<string, string> | undefined;
    expect(Object.keys(headers ?? {}).map((h) => h.toLowerCase())).not.toContain('authorization');
    expect(result).toEqual({ ok: true, data: response });
  });

  it('resolves to network-error (never throws) when fetch rejects', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('offline'))),
    );
    const result = await getApexLeaderboard();
    expect(result).toEqual({ ok: false, error: { kind: 'network-error', message: 'offline' } });
  });
});

describe('ensureProfile', () => {
  it('returns the existing ProfileSession token and never calls fetch when a profile is already persisted', async () => {
    saveProfileSession({ profileId: 'p1', profileToken: 'existing-tok', displayName: 'Alice' });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const token = await ensureProfile('Alice');

    expect(token).toBe('existing-tok');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('creates a profile with the trimmed provided displayName and persists it', async () => {
    let capturedBody: unknown;
    stubFetch((_input, init) => {
      capturedBody = JSON.parse(init?.body as string);
      return jsonResponse(201, { profileId: 'p2', profileToken: 'new-tok' } satisfies CreateProfileResponse);
    });

    const token = await ensureProfile('  Bob  ');

    expect(capturedBody).toEqual({ displayName: 'Bob' });
    expect(token).toBe('new-tok');
    expect(loadProfileSession()).toEqual({ profileId: 'p2', profileToken: 'new-tok', displayName: 'Bob' });
  });

  it('creates a profile with a generated "Rookie Pilot NNNN" default name when displayName is undefined', async () => {
    let capturedBody: { displayName: string } | undefined;
    stubFetch((_input, init) => {
      capturedBody = JSON.parse(init?.body as string);
      return jsonResponse(201, { profileId: 'p3', profileToken: 'tok3' } satisfies CreateProfileResponse);
    });

    await ensureProfile();

    expect(capturedBody?.displayName).toMatch(
      new RegExp(`^${RANKED_STRINGS.defaultDisplayNamePrefix} \\d{4}$`),
    );
  });

  it('creates a profile with the generated default name when displayName is blank/whitespace-only', async () => {
    let capturedBody: { displayName: string } | undefined;
    stubFetch((_input, init) => {
      capturedBody = JSON.parse(init?.body as string);
      return jsonResponse(201, { profileId: 'p4', profileToken: 'tok4' } satisfies CreateProfileResponse);
    });

    await ensureProfile('   ');

    expect(capturedBody?.displayName).toMatch(
      new RegExp(`^${RANKED_STRINGS.defaultDisplayNamePrefix} \\d{4}$`),
    );
  });

  it('returns null and does not persist a session when createProfile fails (network error)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('offline'))),
    );

    const token = await ensureProfile('Alice');

    expect(token).toBeNull();
    expect(loadProfileSession()).toBeNull();
  });

  it('returns null and does not persist a session when createProfile returns a 400', async () => {
    stubFetch(() => jsonResponse(400, { error: 'displayName is required' }));

    const token = await ensureProfile('');

    expect(token).toBeNull();
    expect(loadProfileSession()).toBeNull();
  });

  // --- Requirement 7: double-mount / same-tick race -------------------------
  //
  // Two components both mounting on first render and each calling
  // ensureProfile() before either's createProfile response has landed is a
  // realistic double-mount scenario (React StrictMode dev double-invoke,
  // or two independent components each doing their own lazy bootstrap).
  // ensureProfile has NO in-flight de-duplication: it reads loadProfileSession()
  // synchronously, and if that's null it unconditionally calls createProfile
  // and unconditionally calls saveProfileSession with whatever comes back.
  // Two concurrent callers, before either write lands, will both observe
  // "no session yet", both create a real server-side profile, and the
  // second saveProfileSession call clobbers the first — permanently
  // orphaning the first profile's RP-earning capability with no way for the
  // client to ever reference it again.
  it('two concurrent calls before the first createProfile response lands share one in-flight request and converge on the same profile', async () => {
    let callCount = 0;
    const resolvers: Array<(body: CreateProfileResponse) => void> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        callCount += 1;
        return new Promise<Response>((resolve) => {
          resolvers.push((body) => resolve(jsonResponse(201, body)));
        });
      }),
    );

    // Both components mount and call ensureProfile in the same tick, before
    // either fetch has resolved.
    const p1 = ensureProfile('Alice');
    const p2 = ensureProfile('Alice');

    // The in-flight promise cache in ensureProfile (src/lib/api-client.ts)
    // means the second caller awaits the first's outcome instead of
    // starting its own createProfile call — only ONE fetch is ever made,
    // so there's no second response left to race against.
    expect(callCount).toBe(1);
    resolvers[0]({ profileId: 'profile-A', profileToken: 'token-A' });

    const [token1, token2] = await Promise.all([p1, p2]);

    expect(token1).toBe('token-A');
    expect(token2).toBe('token-A');
  });
});

afterEach(() => {
  clearProfileSession();
});
