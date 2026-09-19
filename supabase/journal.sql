-- Run once in the Supabase SQL Editor for the bot's project.
create table if not exists public.agro_observations (
  id uuid primary key,
  chat_id text not null,
  message_id bigint not null,
  created_at timestamptz not null default now(),
  crop text not null,
  file_id text not null,
  media_type text not null check (media_type in ('photo', 'document')),
  caption text not null default '',
  assessment jsonb not null,
  parent_id uuid,
  unique (chat_id, message_id)
);
create index if not exists agro_observations_chat_date on public.agro_observations (chat_id, created_at desc);
alter table public.agro_observations enable row level security;
revoke all on public.agro_observations from anon, authenticated;
grant select, insert, delete on public.agro_observations to service_role;
-- No public access policies. Only the server secret key may access this table.
-- Records remain until the user calls /delete. Photo bytes are never stored here.
