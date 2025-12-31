-- Rooms table
CREATE TABLE public.rooms (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  password_hash text not null,
  max_players int not null default 20 check (max_players between 2 and 20),
  rounds_total int not null default 3 check (rounds_total between 1 and 20),
  round_time_sec int not null default 60 check (round_time_sec between 30 and 300),
  status public.room_status not null default 'lobby',
  host_user uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
