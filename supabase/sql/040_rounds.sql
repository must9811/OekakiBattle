-- Rounds table
CREATE TABLE public.rounds (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  number int not null,
  drawer_member_id uuid not null references public.room_members(id) on delete cascade,
  prompt_id uuid not null references public.prompts(id),
  status public.round_status not null default 'pending',
  started_at timestamptz,
  ended_at timestamptz
);
CREATE UNIQUE INDEX ux_rounds_room_number ON public.rounds(room_id, number);
