create table if not exists accounts (
  privy_user_id text primary key,
  email         text not null unique,
  privy_wallet  text not null unique,
  bound_address text not null,
  ens_name      text,
  qr_emailed_at timestamptz,
  created_at    timestamptz not null default now()
);

create table if not exists sessions (
  token         text primary key,
  privy_user_id text not null references accounts on delete cascade,
  scope         text not null check (scope in ('full', 'deposit')),
  expires_at    timestamptz not null
);
create index if not exists sessions_expires_at on sessions (expires_at);

create table if not exists deposits (
  id            uuid primary key,
  privy_user_id text not null references accounts on delete cascade,
  currency      text not null,
  amount        numeric not null,
  usd_amount    numeric not null,
  tx_hash       text not null,
  created_at    timestamptz not null default now()
);
