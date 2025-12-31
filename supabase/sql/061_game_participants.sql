-- Game participants table
CREATE TABLE public.game_participants (
  session_id uuid not null references public.game_sessions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  username_at_time text not null,
  is_host boolean not null default false,
  score int not null default 0,
  joined_at timestamptz not null,
  left_at timestamptz,
  PRIMARY KEY (session_id, user_id)
);
