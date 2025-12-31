-- Guesses table
CREATE TABLE public.guesses (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  round_id uuid not null references public.rounds(id) on delete cascade,
  member_id uuid not null references public.room_members(id) on delete cascade,
  content text not null,
  is_correct boolean not null default false,
  awarded_points int not null default 0,
  created_at timestamptz not null default now()
);
CREATE INDEX ix_guesses_round ON public.guesses(round_id, created_at);
