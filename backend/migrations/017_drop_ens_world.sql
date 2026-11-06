-- ENS v2 and World ID are gone. Customers are identified by their wallet
-- address plus a label kept here; kiosks are registered device keys; the
-- daily limit is uniform. Idempotent, like every migration.

-- Account labels replace ENS names ("alice-1234.takarabako.eth" -> "alice-1234").
alter table accounts add column if not exists label text;
do $$
begin
  if exists (select 1 from information_schema.columns where table_name = 'accounts' and column_name = 'ens_name') then
    execute $q$update accounts set label = split_part(ens_name, '.', 1) where label is null and ens_name is not null$q$;
    alter table accounts drop column ens_name;
  end if;
end $$;
create unique index if not exists accounts_label on accounts (lower(label)) where label is not null;

-- World ID: columns and the one-human-per-account index.
drop index if exists accounts_world_nullifier;
alter table accounts drop column if exists world_nullifier;
alter table accounts drop column if exists world_credential;
alter table accounts drop column if exists world_verified_at;

-- Yield history keeps a label for the position ("aqua-1a2b3c4d").
do $$
begin
  if exists (select 1 from information_schema.columns where table_name = 'yield_events' and column_name = 'ens_name') then
    alter table yield_events rename column ens_name to label;
  end if;
end $$;
update yield_events set label = split_part(label, '.', 1) where label like '%.%';

-- Positions are owned by the account row, not by a name token.
alter table aqua_positions drop column if exists deed_holder;

-- Deposits record the kiosk id that took the note ("mumbai-01").
update deposits set machine_name = split_part(machine_name, '.', 1) where machine_name like '%.%';

-- Registered kiosks. The signer is the public address of the key the kiosk
-- generated on its own device; a note counts as machine-verified only when it
-- is signed by the registered key of an active kiosk.
create table if not exists kiosks (
  id         text primary key check (id ~ '^[a-z0-9-]{2,40}$'),
  label      text,
  signer     text not null check (signer ~ '^0x[0-9a-f]{40}$'),
  chain      text not null default 'sepolia',
  active     boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index if not exists kiosks_signer on kiosks (signer);
