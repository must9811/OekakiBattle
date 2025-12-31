-- Round snapshots table
CREATE TABLE public.round_snapshots (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.game_sessions(id) on delete cascade,
  round_number int not null,
  drawer_user_id uuid references auth.users(id),
  prompt_id uuid references public.prompts(id),
  prompt_word text not null,
  image_url text not null,
  correct_user_id uuid references auth.users(id),
  correct_answer text,
  created_at timestamptz not null default now()
);
CREATE UNIQUE INDEX ux_round_snapshots_session_round ON public.round_snapshots(session_id, round_number);
