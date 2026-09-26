-- Curvegrid MultiBaas integration: tkCASH mint tracking, the event log the
-- webhook fills, and the treasury ops agent's proposals.

-- The tkCASH recordCashIn tx for a deposit, so a retry never mints twice.
alter table deposits add column if not exists tkcash_tx_hash text;

-- Every contract event MultiBaas delivers by webhook (routes/webhooks.ts).
-- Kept here so the dashboard feed and positions survive a restart.
create table if not exists chain_events (
  id             text primary key, -- MultiBaas webhook event id
  name           text not null,
  contract_label text,
  contract_addr  text,
  inputs         jsonb not null default '{}',
  tx_hash        text,
  block_number   bigint,
  triggered_at   timestamptz not null,
  received_at    timestamptz not null default now()
);
create index if not exists chain_events_triggered on chain_events (triggered_at desc);
create index if not exists chain_events_name on chain_events (name, triggered_at desc);

-- Treasury ops agent proposals (opsAgent.ts). The agent only proposes; a
-- human approves or rejects, and approval executes it via MultiBaas.
create table if not exists ops_proposals (
  id          uuid primary key,
  action      text not null,
  args        jsonb not null,
  rationale   text not null,
  source      text not null default 'ask' check (source in ('ask', 'monitor')),
  status      text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'executed', 'failed')),
  tx_hash     text,
  error       text,
  created_at  timestamptz not null default now(),
  decided_at  timestamptz
);
create index if not exists ops_proposals_status on ops_proposals (status, created_at desc);

-- Alerts the monitor raises from webhook events (anomaly rules + agent notes).
create table if not exists ops_alerts (
  id          uuid primary key,
  rule        text not null,
  severity    text not null check (severity in ('info', 'warn', 'critical')),
  message     text not null,
  event_id    text,
  created_at  timestamptz not null default now()
);
create index if not exists ops_alerts_created on ops_alerts (created_at desc);
