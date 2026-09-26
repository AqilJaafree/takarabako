-- 1inch Aqua yield positions (aqua.ts). The treasury is the Aqua maker;
-- each position is one or more shipped SwapVM strategies (bins) funded from
-- the customer's vault balance, and returned to it when closed.
create table if not exists aqua_positions (
  id            uuid primary key,
  privy_user_id text not null references accounts on delete cascade,
  mode          text not null check (mode in ('low', 'medium', 'high', 'advanced')),
  shape         text not null check (shape in ('full', 'spot', 'curve', 'bidask')),
  price_min     numeric,          -- USD per ETH; null for a full-range position
  price_max     numeric,
  spot_open     numeric not null, -- ETH/USD when opened
  amount_usd    numeric not null, -- taken from the vault
  fee_bps       int not null,
  apy_est_bps   int not null,
  strategies    jsonb not null,   -- [{ order, hash, min, max, meth, musdc, shipTx }]
  rationale     text,
  status        text not null default 'open' check (status in ('open', 'closed')),
  vault_tx      text,             -- the vault withdraw that funded it
  close_value   numeric,
  close_tx      text,             -- the vault deposit that returned it
  created_at    timestamptz not null default now(),
  closed_at     timestamptz
);
create index if not exists aqua_positions_user on aqua_positions (privy_user_id, status, created_at desc);
create index if not exists aqua_positions_open on aqua_positions (status) where status = 'open';
