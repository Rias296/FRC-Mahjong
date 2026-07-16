import { createClient, type Client } from '@libsql/client';
import { describe, expect, it } from 'vitest';
import { runMigrations } from './migrations';
import { createGame, getGameByRoomCode, joinGame, listPlayers, resolvePlayerToken } from './games';
import { createProfile } from './ranked';
import { DEFAULT_RULES, type RulesConfig } from '../engine/rules-config';
import { computePaymentLegs } from '../engine/scoring';

async function freshDb(): Promise<Client> {
  const db = createClient({ url: ':memory:' });
  await runMigrations(db);
  return db;
}

describe('createGame', () => {
  it('generates a valid room code and seats the creator at seat 0', async () => {
    const db = await freshDb();
    const result = await createGame(db, { displayName: 'Alice' });

    expect(result.roomCode).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
    expect(result.seat).toBe(0);
    expect(result.rules).toEqual(DEFAULT_RULES);
    expect(result.playerToken.length).toBeGreaterThan(0);

    const fetched = await getGameByRoomCode(db, result.roomCode);
    expect(fetched?.status).toBe('waiting-for-players');
    expect(fetched?.gameId).toBe(result.gameId);
  });

  it('merges partial rule overrides over DEFAULT_RULES', async () => {
    const db = await freshDb();
    const result = await createGame(db, { displayName: 'Alice', rules: { minTaiToWin: 3 } });
    expect(result.rules.minTaiToWin).toBe(3);
    expect(result.rules.basePoints).toBe(DEFAULT_RULES.basePoints);
  });

  // --- FIXED (round 3): src/server/games.ts's `mergeRules` was not updated
  // for the round-2 points-pool feature and did a flat
  // `...DEFAULT_RULES, ...overrides` spread with explicit nested-merge only
  // for `robKong`/`sacredDiscard` — NOT `points`. A client-supplied *partial*
  // `points` override (which `isValidRulesOverride` explicitly accepts, see
  // src/lib/protocol.ts's `isValidPointsOverride`) therefore clobbered the
  // entire `points` object, silently dropping `basePoints`/`perTai` to
  // `undefined` for the rest of the game's lifetime (persisted as the
  // immutable `rules_config` row). `mergeRules` now delegates to
  // `normalizeRules`, which deep-merges `points` correctly — these tests
  // pin the fix.
  it('a partial points override at game creation deep-merges with DEFAULT_RULES.points instead of dropping basePoints/perTai', async () => {
    const db = await freshDb();
    const result = await createGame(db, {
      displayName: 'Alice',
      rules: { points: { startingPoints: 50000 } } as Partial<RulesConfig>,
    });

    // Matches normalizeRules' deep-merge semantics, and what
    // isValidRulesOverride's acceptance of a *partial* points object implies
    // callers may rely on: missing points sub-fields fall back to defaults.
    expect(result.rules.points).toEqual({
      startingPoints: 50000,
      basePoints: DEFAULT_RULES.points.basePoints,
      perTai: DEFAULT_RULES.points.perTai,
    });
  });

  it('a partial points override at game creation never produces NaN payment amounts downstream in computePaymentLegs', async () => {
    const db = await freshDb();
    const result = await createGame(db, {
      displayName: 'Alice',
      rules: { points: { startingPoints: 50000 } } as Partial<RulesConfig>,
    });

    const legs = computePaymentLegs({
      winnerSeat: 1,
      winType: 'discard',
      payerSeats: [2],
      handTai: 3,
      dealerSeat: 0,
      repeatCount: 0,
      rules: result.rules,
    });

    // Before the fix, rules.points.basePoints/perTai were undefined, so the
    // formula `basePoints + legTai * perTai` evaluated to NaN — corrupting
    // every payment leg for the entire match.
    expect(Number.isFinite(legs[0].amount)).toBe(true);
  });

  it('createGame without any rules override persists DEFAULT_RULES.points verbatim', async () => {
    const db = await freshDb();
    const result = await createGame(db, { displayName: 'Alice' });
    expect(result.rules.points).toEqual(DEFAULT_RULES.points);

    const fetched = await getGameByRoomCode(db, result.roomCode);
    expect(fetched?.rules.points).toEqual(DEFAULT_RULES.points);
  });

  it('generates distinct room codes across many games', async () => {
    const db = await freshDb();
    const codes = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const result = await createGame(db, { displayName: `Player${i}` });
      codes.add(result.roomCode);
    }
    expect(codes.size).toBe(20);
  });
});

describe('joinGame', () => {
  it('fills seats 0..3 in order and flips status to in-progress with a hand-1 start-hand event on the 4th join', async () => {
    const db = await freshDb();
    const created = await createGame(db, { displayName: 'Alice' });

    const j2 = await joinGame(db, created.roomCode, { displayName: 'Bob' });
    const j3 = await joinGame(db, created.roomCode, { displayName: 'Carol' });
    const j4 = await joinGame(db, created.roomCode, { displayName: 'Dave' });

    if ('error' in j2 || 'error' in j3 || 'error' in j4) {
      throw new Error('unexpected join error');
    }
    expect(j2.seat).toBe(1);
    expect(j3.seat).toBe(2);
    expect(j4.seat).toBe(3);
    expect(j4.status).toBe('in-progress');

    const fetched = await getGameByRoomCode(db, created.roomCode);
    expect(fetched?.status).toBe('in-progress');

    const actionsRow = await db.execute({
      sql: 'SELECT seq, hand_number, actor_seat, action_type, payload FROM actions WHERE game_id = ?',
      args: [created.gameId],
    });
    expect(actionsRow.rows.length).toBe(1);
    expect(actionsRow.rows[0].seq).toBe(1);
    expect(actionsRow.rows[0].actor_seat).toBeNull();
    expect(actionsRow.rows[0].action_type).toBe('start-hand');

    const payload = JSON.parse(String(actionsRow.rows[0].payload)) as {
      handNumber: number;
      dealerSeat: number;
      repeatCount: number;
      prevailingWind: string;
      seed: number;
    };
    expect(payload.handNumber).toBe(1);
    expect(payload.dealerSeat).toBe(0);
    expect(payload.repeatCount).toBe(0);
    expect(payload.prevailingWind).toBe('east');
    expect(typeof payload.seed).toBe('number');

    const players = await listPlayers(db, created.gameId);
    expect(players).toEqual([
      { seat: 0, displayName: 'Alice', profileId: null },
      { seat: 1, displayName: 'Bob', profileId: null },
      { seat: 2, displayName: 'Carol', profileId: null },
      { seat: 3, displayName: 'Dave', profileId: null },
    ]);
  });

  it('returns already-started on a 5th join once the game has naturally started', async () => {
    const db = await freshDb();
    const created = await createGame(db, { displayName: 'Alice' });
    await joinGame(db, created.roomCode, { displayName: 'Bob' });
    await joinGame(db, created.roomCode, { displayName: 'Carol' });
    await joinGame(db, created.roomCode, { displayName: 'Dave' });

    const fifth = await joinGame(db, created.roomCode, { displayName: 'Eve' });
    expect(fifth).toEqual({ error: 'already-started' });
  });

  it('defends against a corrupted waiting-for-players game with 4 seats already filled (returns game-full)', async () => {
    const db = await freshDb();
    const created = await createGame(db, { displayName: 'Alice' });
    await joinGame(db, created.roomCode, { displayName: 'Bob' });
    await joinGame(db, created.roomCode, { displayName: 'Carol' });
    await joinGame(db, created.roomCode, { displayName: 'Dave' });

    // Simulate corruption: force status back to waiting-for-players despite
    // all 4 seats being filled (shouldn't happen via the normal join path).
    await db.execute({
      sql: `UPDATE games SET status = 'waiting-for-players' WHERE id = ?`,
      args: [created.gameId],
    });

    const fifth = await joinGame(db, created.roomCode, { displayName: 'Eve' });
    expect(fifth).toEqual({ error: 'game-full' });
  });

  it('returns not-found for an unknown room code', async () => {
    const db = await freshDb();
    const result = await joinGame(db, 'ZZZZZZ', { displayName: 'Nobody' });
    expect(result).toEqual({ error: 'not-found' });
  });
});

describe('ranked-profile linking (createGame/joinGame)', () => {
  it('createGame persists profile_id on seat 0 when a valid profileId is given', async () => {
    const db = await freshDb();
    const profile = await createProfile(db, 'Alice');
    const created = await createGame(db, { displayName: 'Alice', profileId: profile.profileId });

    const players = await listPlayers(db, created.gameId);
    expect(players).toEqual([{ seat: 0, displayName: 'Alice', profileId: profile.profileId }]);
  });

  it('createGame leaves profile_id null when no profileId is given', async () => {
    const db = await freshDb();
    const created = await createGame(db, { displayName: 'Alice' });

    const players = await listPlayers(db, created.gameId);
    expect(players).toEqual([{ seat: 0, displayName: 'Alice', profileId: null }]);
  });

  it('joinGame persists profile_id for a joining seat when a valid profileId is given', async () => {
    const db = await freshDb();
    const created = await createGame(db, { displayName: 'Alice' });
    const profile = await createProfile(db, 'Bob');

    const joined = await joinGame(db, created.roomCode, { displayName: 'Bob', profileId: profile.profileId });
    if ('error' in joined) throw new Error(`unexpected join error: ${joined.error}`);
    expect(joined.seat).toBe(1);

    const players = await listPlayers(db, created.gameId);
    expect(players.find((p) => p.seat === 1)).toEqual({ seat: 1, displayName: 'Bob', profileId: profile.profileId });
  });

  it('a duplicate-profile join attempt (same profile already linked to a different seat in this game) succeeds with profile_id = NULL instead of failing', async () => {
    const db = await freshDb();
    const profile = await createProfile(db, 'Alice');
    const created = await createGame(db, { displayName: 'Alice', profileId: profile.profileId });

    // Bob attempts to join using the SAME profile Alice already linked to
    // seat 0 in this game — must not fail the join; the seat is granted,
    // just unranked (profile_id = NULL) for this seat.
    const joined = await joinGame(db, created.roomCode, { displayName: 'Bob', profileId: profile.profileId });
    if ('error' in joined) throw new Error(`unexpected join error: ${joined.error}`);
    expect(joined.seat).toBe(1);

    const players = await listPlayers(db, created.gameId);
    expect(players.find((p) => p.seat === 0)).toEqual({ seat: 0, displayName: 'Alice', profileId: profile.profileId });
    expect(players.find((p) => p.seat === 1)).toEqual({ seat: 1, displayName: 'Bob', profileId: null });
  });

  it('the same profile CAN link to different seats across two different games', async () => {
    const db = await freshDb();
    const profile = await createProfile(db, 'Alice');
    const gameA = await createGame(db, { displayName: 'Alice', profileId: profile.profileId });
    const gameB = await createGame(db, { displayName: 'Alice', profileId: profile.profileId });

    const playersA = await listPlayers(db, gameA.gameId);
    const playersB = await listPlayers(db, gameB.gameId);
    expect(playersA[0].profileId).toBe(profile.profileId);
    expect(playersB[0].profileId).toBe(profile.profileId);
  });
});

describe('legacy rules_config normalization', () => {
  // Directly seeds a games row with a rules_config JSON blob lacking the
  // `points` sub-object entirely (as any row persisted before round 2's
  // points-pool feature would have), bypassing createGame's own
  // mergeRules/normalizeRules — the point is to prove the READ side
  // (getGameByRoomCode, joinGame) normalizes on its own, independent of
  // whatever wrote the row.
  async function seedLegacyGameRow(db: Client, roomCode: string): Promise<string> {
    const gameId = `legacy-${roomCode}`;
    const legacyRulesJson = JSON.stringify({
      deadWallReserve: 16,
      minTaiToWin: 0,
      basePoints: 3,
      pointsPerTai: 1,
      selfDrawTai: 1,
      robKongTai: 1,
      robKong: { enabled: true, robConcealedKong: false },
      sacredDiscard: { enabled: true, scope: 'until-next-self-discard' },
      multipleWinners: false,
      dealerRepeatsOnDraw: true,
      dealerBaseTai: 1,
      dealerRepeatBonusTaiPerRepeat: 2,
      // Deliberately no `points` key at all.
    });
    const now = Date.now();
    await db.execute({
      sql: `INSERT INTO games (id, room_code, status, rules_config, engine_version, created_at, updated_at)
            VALUES (?, ?, 'waiting-for-players', ?, '0.1.0', ?, ?)`,
      args: [gameId, roomCode, legacyRulesJson, now, now],
    });
    return gameId;
  }

  it('getGameByRoomCode normalizes a legacy row lacking points into a fully-populated RulesConfig', async () => {
    const db = await freshDb();
    await seedLegacyGameRow(db, 'LEGACY1');

    const fetched = await getGameByRoomCode(db, 'LEGACY1');
    expect(fetched?.rules.points).toEqual(DEFAULT_RULES.points);
  });

  it('joinGame normalizes a legacy row lacking points into a fully-populated RulesConfig', async () => {
    const db = await freshDb();
    await seedLegacyGameRow(db, 'LEGACY2');
    // Seed the creator's own seat 0 row so joinGame can fill seat 1.
    await db.execute({
      sql: `INSERT INTO players (id, game_id, seat, display_name, join_token, created_at)
            VALUES ('legacy-player-0', 'legacy-LEGACY2', 0, 'Alice', 'legacy-token-0', ?)`,
      args: [Date.now()],
    });

    const joined = await joinGame(db, 'LEGACY2', { displayName: 'Bob' });
    if ('error' in joined) throw new Error(`unexpected join error: ${joined.error}`);
    expect(joined.rules.points).toEqual(DEFAULT_RULES.points);
  });
});

describe('resolvePlayerToken', () => {
  it('round-trips seat/game for a known token, and returns null for an unknown token', async () => {
    const db = await freshDb();
    const created = await createGame(db, { displayName: 'Alice' });

    const resolved = await resolvePlayerToken(db, created.playerToken);
    expect(resolved).toEqual({ gameId: created.gameId, seat: 0 });

    const unknown = await resolvePlayerToken(db, 'not-a-real-token');
    expect(unknown).toBeNull();
  });

  it('resolves each joined player to their own seat', async () => {
    const db = await freshDb();
    const created = await createGame(db, { displayName: 'Alice' });
    const j2 = await joinGame(db, created.roomCode, { displayName: 'Bob' });
    if ('error' in j2) throw new Error('unexpected join error');

    const resolved = await resolvePlayerToken(db, j2.playerToken);
    expect(resolved).toEqual({ gameId: created.gameId, seat: 1 });
  });
});
