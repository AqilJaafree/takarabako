-- Sending by ENS name: box balance and tkCASH to another customer, and Aqua
-- positions whose deed (an ENS v2 name token) changed hands.
create table if not exists transfers (
  id            uuid primary key,
  kind          text not null check (kind in ('balance', 'tkcash', 'position')),
  from_user     text references accounts on delete set null,
  to_user       text references accounts on delete set null,
  to_name       text,              -- the ENS name the sender typed
  to_address    text,              -- what it resolved to
  amount_usd    numeric,
  position_id   uuid,
  tx_hash       text,
  created_at    timestamptz not null default now()
);
create index if not exists transfers_from on transfers (from_user, created_at desc);
create index if not exists transfers_to on transfers (to_user, created_at desc);
create unique index if not exists transfers_tx on transfers (kind, tx_hash) where tx_hash is not null and kind <> 'balance';

-- Who holds a position's deed right now, when it isn't a Takarabako customer.
alter table aqua_positions add column if not exists deed_holder text;
