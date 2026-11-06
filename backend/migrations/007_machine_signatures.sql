-- Verifiable kiosks: every note a kiosk takes is signed by its device key,
-- registered for the kiosk id (kiosks table, machine.ts).
alter table deposits add column if not exists machine_name text;      -- e.g. mumbai-01
alter table deposits add column if not exists machine_signer text;    -- recovered device address
alter table deposits add column if not exists machine_nonce numeric;
alter table deposits add column if not exists machine_sig text;
alter table deposits add column if not exists machine_verified boolean not null default false;
-- A device nonce can only be used once per kiosk (no replayed signatures).
create unique index if not exists deposits_machine_nonce on deposits (machine_name, machine_nonce) where machine_nonce is not null;
