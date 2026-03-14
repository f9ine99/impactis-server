-- Deal rooms: one per connection when startup + investor accept
create table if not exists public.deal_rooms (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null unique references public.connections(id) on delete cascade,
  name text,
  created_at timestamptz not null default timezone('utc', now())
);

-- In-app notifications
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  type text not null,
  title text not null,
  body text,
  link text,
  read_at timestamptz,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists notifications_user_read_idx on public.notifications(user_id, read_at);
create index if not exists notifications_user_created_idx on public.notifications(user_id, created_at desc);
