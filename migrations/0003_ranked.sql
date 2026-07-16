-- Ranked ladder: cross-match player identity (profiles) and per-match
-- settlement history (rank_history), plus an optional link from players to
-- profiles. Additive-only: does not touch 0001/0002.

CREATE TABLE profiles (
  id TEXT PRIMARY KEY,
  secret_token TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  rank_points INTEGER NOT NULL DEFAULT 0,
  apex_attained_at INTEGER NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- One row per (game, profile) settlement — UNIQUE(game_id, profile_id) is the
-- exactly-once settlement guard: a later round's concurrency-safe settlement
-- path relies on this to make a duplicate settlement attempt for the same
-- profile in the same game fail at the DB layer instead of double-paying RP.
CREATE TABLE rank_history (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL REFERENCES games(id),
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  seat INTEGER NOT NULL,
  placement INTEGER NOT NULL,
  rp_before INTEGER NOT NULL,
  rp_delta INTEGER NOT NULL,
  rp_after INTEGER NOT NULL,
  tier_after TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(game_id, profile_id)
);

ALTER TABLE players ADD COLUMN profile_id TEXT NULL;

-- Partial unique index: at most one seat per game may link to a given
-- profile (mirrors the 0002 partial-unique-index pattern). Multiple seats
-- with profile_id IS NULL (unlinked/unranked players) remain unrestricted.
CREATE UNIQUE INDEX idx_players_one_profile_per_game
  ON players(game_id, profile_id)
  WHERE profile_id IS NOT NULL;

CREATE INDEX idx_rank_history_profile_id ON rank_history(profile_id);
CREATE INDEX idx_profiles_apex_attained_at ON profiles(apex_attained_at);
