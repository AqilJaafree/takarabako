-- tkCASH burned when a customer withdraws, shown on their History page.
alter table withdrawals add column if not exists tkcash_burned numeric not null default 0;
alter table withdrawals add column if not exists tkcash_tx_hash text;
