-- Defense-in-depth: a start-hand row must be unique per (game_id,
-- hand_number), even if a future direct/raw insert bypasses
-- appendStartHand's own application-level INSERT...WHERE NOT EXISTS guard.
CREATE UNIQUE INDEX idx_actions_one_start_hand_per_hand
  ON actions(game_id, hand_number)
  WHERE action_type = 'start-hand';
