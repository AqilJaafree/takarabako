-- Takarabako runs on several chains at once (Ethereum Sepolia, Arc Testnet).
-- Rows that already exist were all written on Sepolia.
alter table deposits add column if not exists chain text not null default 'sepolia';
alter table withdrawals add column if not exists chain text not null default 'sepolia';
alter table transfers add column if not exists chain text not null default 'sepolia';
alter table chain_events add column if not exists chain text not null default 'sepolia';
create index if not exists chain_events_chain on chain_events (chain, triggered_at desc);
create index if not exists deposits_chain on deposits (chain, created_at desc);

-- Where the log indexer for chains MultiBaas doesn't cover left off (arcIndexer.ts).
create table if not exists indexer_cursors (
  chain      text not null,
  contract   text not null,
  last_block bigint not null,
  updated_at timestamptz not null default now(),
  primary key (chain, contract)
);

-- USDC moved between chains with Circle CCTP V2 (bridge.ts). The row is the
-- record; each state change is stored before the next step starts, so a
-- restart resumes a transfer instead of repeating a burn.
create table if not exists bridge_transfers (
  id            uuid primary key,
  privy_user_id text references accounts on delete set null,
  kind          text not null default 'customer' check (kind in ('customer', 'treasury')),
  from_chain    text not null,
  to_chain      text not null,
  amount_usd    numeric not null check (amount_usd > 0),
  recipient     text not null,           -- address on the destination chain that receives the USDC
  state         text not null default 'created'
                check (state in ('created', 'withdrawn', 'burned', 'attested', 'minted', 'credited', 'failed')),
  withdraw_tx   text,                    -- vault withdrawal on the source chain
  burn_tx       text,                    -- depositForBurn on the source chain
  message       text,                    -- CCTP message bytes, once attested
  attestation   text,
  mint_tx       text,                    -- receiveMessage on the destination chain
  credit_tx     text,                    -- vault depositFor on the destination chain
  error         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists bridge_transfers_user on bridge_transfers (privy_user_id, created_at desc);
create index if not exists bridge_transfers_state on bridge_transfers (state, created_at desc);
