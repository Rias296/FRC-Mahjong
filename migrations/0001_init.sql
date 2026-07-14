CREATE TABLE games (
  id TEXT PRIMARY KEY,
  room_code TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('waiting-for-players','in-progress','finished')),
  rules_config TEXT NOT NULL,
  engine_version TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE players (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL REFERENCES games(id),
  seat INTEGER NOT NULL CHECK (seat BETWEEN 0 AND 3),
  display_name TEXT NOT NULL,
  join_token TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  UNIQUE(game_id, seat)
);

CREATE TABLE actions (
  id INTEGER PRIMARY KEY,
  game_id TEXT NOT NULL REFERENCES games(id),
  hand_number INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  actor_seat INTEGER NULL,
  action_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(game_id, seq)
);

CREATE INDEX idx_games_room_code ON games(room_code);
CREATE INDEX idx_players_join_token ON players(join_token);
CREATE INDEX idx_actions_game_hand ON actions(game_id, hand_number);
