-- Deposit sessions (one per customer visit to the cash slot), receipts, and
-- the rows behind the customer's History page.
create table if not exists deposit_sessions (
  id                 uuid primary key,
  privy_user_id      text not null references accounts on delete cascade,
  status             text not null default 'open' check (status in ('open', 'finished')),
  started_at         timestamptz not null default now(),
  finished_at        timestamptz,
  receipt_emailed_at timestamptz
);
create index if not exists deposit_sessions_user on deposit_sessions (privy_user_id, started_at desc);

alter table deposits add column if not exists session_id uuid references deposit_sessions on delete set null;

create table if not exists withdrawals (
  id            uuid primary key,
  privy_user_id text not null references accounts on delete cascade,
  destination   text not null check (destination in ('cash', 'wallet')),
  gross_usd     numeric not null,
  fee_bps       int not null,
  net_usd       numeric not null,
  tx_hash       text,
  created_at    timestamptz not null default now()
);

create table if not exists yield_events (
  id            uuid primary key,
  privy_user_id text not null references accounts on delete cascade,
  action        text not null check (action in ('open', 'close')),
  risk_tier     text,
  pair          text,
  apy_bps       int,
  amount_usd    numeric,
  rationale     text,
  ens_name      text,
  tx_hash       text,
  created_at    timestamptz not null default now()
);

create table if not exists refused_notes (
  id            uuid primary key,
  privy_user_id text not null references accounts on delete cascade,
  session_id    uuid references deposit_sessions on delete set null,
  reason        text not null check (reason in ('unsupported', 'bad_condition', 'no_session')),
  created_at    timestamptz not null default now()
);
