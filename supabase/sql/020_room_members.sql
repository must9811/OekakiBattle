-- Room members table
CREATE TABLE public.room_members (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  user_id uuid not null,
  username text not null,
  is_host boolean not null default false,
  joined_at timestamptz not null default now(),
  left_at timestamptz
);
ALTER TABLE public.room_members REPLICA IDENTITY FULL;
ALTER TABLE public.room_members ADD CONSTRAINT uq_room_user UNIQUE (room_id, user_id);
ALTER TABLE public.room_members ADD CONSTRAINT uq_room_username UNIQUE (room_id, username);
ALTER TABLE public.room_members ADD CONSTRAINT ck_username_length CHECK (char_length(username) between 1 and 16);
