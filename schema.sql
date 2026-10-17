-- 1. Table for tracking WhatsApp Multi-Device persistent session keys
create table if not exists public.whatsapp_sessions (
  id text primary key,
  data jsonb not null,
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- 2. Table to temporarily hold intercepted View Once message metadata
create table if not exists public.pending_views (
  id uuid default gen_random_uuid() primary key,
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

-- Enable Row Level Security (RLS) on both tables for security
alter table public.whatsapp_sessions enable row level security;
alter table public.pending_views enable row level security;

-- Create policies allowing all operations when using the Supabase Service Role Key
create policy "Allow all service role actions on sessions" on public.whatsapp_sessions for all using (true) with check (true);
create policy "Allow all service role actions on pending views" on public.pending_views for all using (true) with check (true);
