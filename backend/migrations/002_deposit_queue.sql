alter table deposits add column if not exists status text not null default 'confirmed'
  check (status in ('queued', 'sending', 'confirmed', 'failed'));
alter table deposits add column if not exists attempts int not null default 0;
alter table deposits add column if not exists error text;
alter table deposits add column if not exists updated_at timestamptz not null default now();
alter table deposits alter column tx_hash drop not null;
alter table deposits alter column usd_amount drop not null;
create index if not exists deposits_user_created on deposits (privy_user_id, created_at desc);
