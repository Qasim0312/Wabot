-- 1. Drop old tables to apply structural changes
drop table if exists public.whatsapp_sessions;
drop table if exists public.pending_views;

-- 2. Multi-instance Session tracking table
create table public.whatsapp_sessions (
  phone text not null, -- Key identifying which phone number owns this session
  id text not null, -- Key identifying the Baileys token category
  data jsonb not null,
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null,
  primary key (phone, id) -- Composite primary key
);

-- 3. Queue table updated to track target instances
create table public.pending_views (
  id uuid default gen_random_uuid() primary key,
  instance_phone text not null, -- Tracks which of your connected numbers received this file
  wa_id text not null unique,
  jid text not null,
  push_name text,
  media_type text not null,
  media_url text not null,
  direct_path text,
  media_key text not null,
  enc_sha256 text not null,
  file_sha256 text not null,
  mime text,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Enable RLS and setup full bypass rules for service role keys
alter table public.whatsapp_sessions enable row level security;
alter table public.pending_views enable row level security;
create policy "Allow master service actions on sessions" on public.whatsapp_sessions for all using (true) with check (true);
create policy "Allow master service actions on views" on public.pending_views for all using (true) with check (true);
