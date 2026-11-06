-- Self-custody Aqua positions on Arc mainnet (selfPositions.ts). The customer's
-- own wallet is the Aqua maker and signs everything: no vault, no treasury.
-- Kept apart from aqua_positions on purpose, so the treasury-managed positions,
-- the market-maker simulator, the allowance keeper and the audit never see them.
create table if not exists self_positions (
  id            uuid primary key,
  privy_user_id text not null references accounts on delete cascade,
  wallet        text not null,         -- the customer's wallet: the Aqua maker
  chain_id      int not null,
  mode          text not null,         -- low, medium, high or hybrid
  amount_usd    numeric not null,
  spot_open     numeric not null,      -- ETH/USD when it was prepared
  fee_bps       int not null,
  price_min     numeric,               -- null for a full-range position
  price_max     numeric,
  strategies    jsonb not null,        -- [{ order, hash, min, max, weight, eth, usdc }]
  status        text not null default 'pending' check (status in ('pending', 'open', 'closed')),
  open_txs      jsonb,                 -- the hashes the customer signed to open it
  close_txs     jsonb,                 -- and to close it
  created_at    timestamptz not null default now(),
  opened_at     timestamptz,
  closed_at     timestamptz
);
create index if not exists self_positions_user on self_positions (privy_user_id, created_at desc);
-- added after the table first shipped: the transactions prepared for the customer to sign
alter table self_positions add column if not exists steps jsonb;
