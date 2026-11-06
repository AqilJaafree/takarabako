-- Closing a position now takes steps that can stop halfway (claim and record
-- the payout, dock the strategies, send the payout). A position in between is
-- "closing" with its payout on record, and closing it again resumes it.
-- Idempotent like the other migrations: runs at every startup.
alter table aqua_positions drop constraint if exists aqua_positions_status_check;
alter table aqua_positions add constraint aqua_positions_status_check check (status in ('open', 'closing', 'closed'));
alter table aqua_positions add column if not exists closing_at timestamptz;
