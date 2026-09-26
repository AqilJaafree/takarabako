-- The treasury agent's mandate (mandate.ts): proposals it executed on its
-- own, within its daily limits, rather than waiting for a human.
alter table ops_proposals add column if not exists autonomous boolean not null default false;

-- Daily treasury reports the agent writes (report.ts). `canonical` is the
-- exact JSON that was hashed; its keccak256 is anchored on-chain in
-- anchor_tx, so anyone can check the report wasn't changed afterwards.
create table if not exists agent_reports (
  id          uuid primary key,
  body        text not null,
  canonical   text not null,
  hash        text not null,
  anchor_tx   text,
  model       text,
  status      text not null default 'clear' check (status in ('clear', 'warn', 'critical')),
  created_at  timestamptz not null default now()
);
create index if not exists agent_reports_created on agent_reports (created_at desc);
