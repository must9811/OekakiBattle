-- Helper functions
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- Password verification (use extensions.crypt)
CREATE OR REPLACE FUNCTION public.verify_room_password(p_room_id uuid, p_password text)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT (r.password_hash = extensions.crypt(p_password, r.password_hash))
  FROM public.rooms r WHERE r.id = p_room_id
$$;

-- Membership helpers
CREATE OR REPLACE FUNCTION public.is_room_member(p_room_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET row_security = off AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.room_members m
    WHERE m.room_id = p_room_id AND m.user_id = auth.uid() AND m.left_at IS NULL
  )
$$;

CREATE OR REPLACE FUNCTION public.is_room_member_or_profile(p_room_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET row_security = off AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.room_members m
    WHERE m.room_id = p_room_id
      AND m.left_at IS NULL
      AND (
        m.user_id = auth.uid()
        OR m.username = (SELECT p.username FROM public.profiles p WHERE p.user_id = auth.uid())
      )
  )
$$;

CREATE OR REPLACE FUNCTION public.is_room_finished(p_room_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET row_security = off AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.rooms r
    WHERE r.id = p_room_id
      AND r.status = 'finished'
  )
$$;

CREATE OR REPLACE FUNCTION public.my_member_id(p_room_id uuid)
RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT m.id FROM public.room_members m
  WHERE m.room_id = p_room_id AND m.user_id = auth.uid() AND m.left_at IS NULL
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.is_room_host(p_room_id uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.rooms r
    WHERE r.id = p_room_id AND r.host_user = auth.uid()
  )
$$;

CREATE OR REPLACE FUNCTION public.is_drawer(p_round_id uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.rounds rd
    JOIN public.room_members m ON m.id = rd.drawer_member_id
    WHERE rd.id = p_round_id AND m.user_id = auth.uid() AND m.left_at IS NULL
  )
$$;

CREATE OR REPLACE FUNCTION public.is_session_participant(p_session_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET row_security = off AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.game_participants gp
    WHERE gp.session_id = p_session_id
      AND gp.user_id = auth.uid()
  )
$$;

CREATE OR REPLACE FUNCTION public.normalize_text(t text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT lower(trim(t))
$$;
