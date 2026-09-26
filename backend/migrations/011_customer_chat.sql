-- Chat with the maneki-neko (customerChat.ts): saved conversations per
-- customer. Uploaded files are read by the model and not kept; a message
-- only records their names and types.
create table if not exists chat_sessions (
  id             uuid primary key,
  privy_user_id  text not null references accounts (privy_user_id) on delete cascade,
  title          text not null default 'New chat',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists chat_sessions_user on chat_sessions (privy_user_id, updated_at desc);

create table if not exists chat_messages (
  id           uuid primary key,
  session_id   uuid not null references chat_sessions (id) on delete cascade,
  role         text not null check (role in ('user', 'assistant')),
  content      text not null,
  attachments  jsonb not null default '[]', -- [{ name, type }] only
  cards        jsonb not null default '[]', -- QR / confirm cards the app renders
  created_at   timestamptz not null default now()
);
create index if not exists chat_messages_session on chat_messages (session_id, created_at);
