-- World ID (worldId.ts): one verified human per account. The nullifier is
-- World ID's anonymous, per-app identifier for a person — the same human
-- always produces the same one, so a unique index stops them verifying a
-- second account.
alter table accounts add column if not exists world_nullifier text;
alter table accounts add column if not exists world_credential text;   -- e.g. proof_of_human, device
alter table accounts add column if not exists world_verified_at timestamptz;
create unique index if not exists accounts_world_nullifier on accounts (world_nullifier) where world_nullifier is not null;
