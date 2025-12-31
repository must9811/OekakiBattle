-- Game sessions table
CREATE TABLE public.game_sessions (
  id uuid primary key default gen_random_uuid(),
  room_id uuid references public.rooms(id) on delete set null,
  room_name text not null,
  host_user_id uuid not null,
  rounds_total int not null,
  round_time_sec int not null,
  started_at timestamptz not null,
  ended_at timestamptz
);
CREATE UNIQUE INDEX ux_game_sessions_room_started ON public.game_sessions(room_id, started_at);
