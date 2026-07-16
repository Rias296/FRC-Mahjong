-- Ranked-ladder round-2 concurrency/resilience hardening for
-- `settleRankedMatch` (src/server/ranked.ts) — see that function's own doc
-- comment for the full design. Additive-only: does not touch 0001-0003.

-- Distinguishes "this seat's rank_history row exists" from "the matching
-- profiles.rank_points update for it has actually landed". A row can exist
-- with rp_applied = 0 if a process died between the two steps (or, in a
-- migration from the pre-round-2 design, any other historical partial
-- write) — a later settleRankedMatch call treats that as still-incomplete
-- and safely finishes it, rather than treating "the row exists" as
-- unconditional proof the RP change was actually applied.
ALTER TABLE rank_history ADD COLUMN rp_applied INTEGER NOT NULL DEFAULT 0;

-- Backfill: every row that already existed before this column was added was
-- written by the pre-round-2 code, under which the only way a rank_history
-- row could exist at all was for its matching profiles.rank_points update to
-- have already, genuinely landed (that code had no partial-write/resumable
-- path). So every pre-existing row is retroactively "fully applied" and must
-- be marked rp_applied = 1 here, or a resuming settleRankedMatch call will
-- treat DEFAULT 0 as "still incomplete" and re-apply rp_delta, double-
-- crediting that seat's RP. This UPDATE runs once, at migration-apply time,
-- against whatever rows exist at that moment. Rows inserted after this
-- migration has run are written by the new resumable code, which explicitly
-- starts them at rp_applied = 0 and only flips them to 1 once the matching
-- profiles update is confirmed to have landed, so they are unaffected by
-- this backfill.
UPDATE rank_history SET rp_applied = 1;

-- Per-(game, seat) settlement-failure memory. Lets settleRankedMatch isolate
-- one permanently-broken seat (e.g. its linked profile row was deleted) from
-- the other 3: once a seat has failed at least once for a game, later
-- settlement attempts defer it to the END of that attempt's per-seat work,
-- so the healthy seats get to settle first instead of being blocked forever
-- behind a seat that will never succeed (the broken seat's own failure is
-- still re-raised at the end of the attempt, so callers keep seeing it until
-- it's actually fixed).
CREATE TABLE rank_settlement_failures (
  game_id TEXT NOT NULL REFERENCES games(id),
  seat INTEGER NOT NULL,
  last_error TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 1,
  first_failed_at INTEGER NOT NULL,
  last_failed_at INTEGER NOT NULL,
  PRIMARY KEY (game_id, seat)
);
