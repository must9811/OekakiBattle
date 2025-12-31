-- Gameplay and history functions
CREATE OR REPLACE FUNCTION public.award_guess_points()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_prompt text;
  v_drawer uuid;
  v_room uuid;
  v_is_first boolean := false;
  v_any_correct boolean := false;
BEGIN
  -- Lock the round row to serialize concurrent scoring decisions
  PERFORM 1 FROM public.rounds r WHERE r.id = NEW.round_id FOR UPDATE;

  SELECT rd.room_id, rd.drawer_member_id, p.word INTO v_room, v_drawer, v_prompt
  FROM public.rounds rd JOIN public.prompts p ON p.id = rd.prompt_id
  WHERE rd.id = NEW.round_id;

  IF v_room IS NULL THEN
    RAISE EXCEPTION 'invalid_round';
  END IF;
  NEW.room_id := v_room;

  -- Drawer cannot score
  IF NEW.member_id = v_drawer THEN
    NEW.is_correct := false;
    NEW.awarded_points := 0;
    RETURN NEW;
  END IF;

  -- If content is not an exact match (normalized), it's incorrect
  IF public.normalize_text(NEW.content) <> public.normalize_text(v_prompt) THEN
    NEW.is_correct := false;
    NEW.awarded_points := 0;
    RETURN NEW;
  END IF;

  -- If this member already had a correct in this round, keep zero
  IF EXISTS (
    SELECT 1 FROM public.guesses g
    WHERE g.round_id = NEW.round_id AND g.member_id = NEW.member_id AND g.is_correct
  ) THEN
    NEW.is_correct := false;
    NEW.awarded_points := 0;
    RETURN NEW;
  END IF;

  -- Check whether any correct guess already exists in this round
  SELECT EXISTS (
    SELECT 1 FROM public.guesses g WHERE g.round_id = NEW.round_id AND g.is_correct
  ) INTO v_any_correct;

  -- First-correct only: award +1, mark as correct. Otherwise, mark as incorrect and 0.
  IF NOT v_any_correct THEN
    NEW.is_correct := true;
    NEW.awarded_points := 1;
  ELSE
    NEW.is_correct := false;
    NEW.awarded_points := 0;
  END IF;

  RETURN NEW;
END;
$$;

-- Host leaves -> delete room
CREATE OR REPLACE FUNCTION public.handle_host_leave()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_room_host uuid; BEGIN
  SELECT r.host_user INTO v_room_host FROM public.rooms r WHERE r.id = OLD.room_id;
  IF v_room_host = OLD.user_id THEN DELETE FROM public.rooms WHERE id = OLD.room_id; END IF;
  RETURN NULL; END;
$$;

CREATE OR REPLACE FUNCTION public.create_room(
  p_name text,
  p_password text,
  p_username text,
  p_max int default 10,
  p_rounds int default 3,
  p_time int default 60
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_room_id uuid; v_member_id uuid; BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'auth required'; END IF;
  IF EXISTS (SELECT 1 FROM public.rooms WHERE name = p_name) THEN RAISE EXCEPTION 'room_name_taken'; END IF;
  INSERT INTO public.rooms(name, password_hash, max_players, rounds_total, round_time_sec, host_user)
  VALUES (p_name, extensions.crypt(p_password, extensions.gen_salt('bf')), COALESCE(p_max,10), COALESCE(p_rounds,3), COALESCE(p_time,60), auth.uid())
  RETURNING id INTO v_room_id;
  INSERT INTO public.room_members(room_id, user_id, username, is_host)
  VALUES (v_room_id, auth.uid(), p_username, true)
  RETURNING id INTO v_member_id;
  RETURN json_build_object('room_id', v_room_id, 'member_id', v_member_id);
END; $$;

CREATE OR REPLACE FUNCTION public.join_room(
  p_name text,
  p_password text,
  p_username text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_room public.rooms%rowtype; v_member_id uuid; v_count int; BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'auth required'; END IF;
  SELECT * INTO v_room FROM public.rooms WHERE name = p_name; IF NOT FOUND THEN RAISE EXCEPTION 'room_not_found'; END IF;
  IF v_room.status <> 'lobby' THEN RAISE EXCEPTION 'room_not_joinable'; END IF;
  IF NOT public.verify_room_password(v_room.id, p_password) THEN RAISE EXCEPTION 'invalid_password'; END IF;
  SELECT count(*) INTO v_count FROM public.room_members WHERE room_id = v_room.id AND left_at IS NULL;
  IF v_count >= v_room.max_players THEN RAISE EXCEPTION 'room_full'; END IF;
  INSERT INTO public.room_members(room_id, user_id, username, is_host)
  VALUES (v_room.id, auth.uid(), p_username, false) RETURNING id INTO v_member_id;
  RETURN json_build_object('room_id', v_room.id, 'member_id', v_member_id);
END; $$;

CREATE OR REPLACE FUNCTION public.start_game(p_room_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_room public.rooms%rowtype; v_member_ids uuid[]; v_m uuid; v_prompt uuid; i int := 1; idx int := 1; total int; mcount int; BEGIN
  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'room_not_found'; END IF;
  IF v_room.host_user <> auth.uid() THEN RAISE EXCEPTION 'forbidden'; END IF;
  SELECT array_agg(id ORDER BY random()) INTO v_member_ids FROM public.room_members WHERE room_id = p_room_id AND left_at IS NULL;
  IF v_member_ids IS NULL OR array_length(v_member_ids,1) < 2 THEN RAISE EXCEPTION 'not_enough_players'; END IF;
  mcount := array_length(v_member_ids,1); total := v_room.rounds_total;
  DELETE FROM public.rounds WHERE room_id = p_room_id;
  WHILE i <= total LOOP
    v_m := v_member_ids[idx]; SELECT id INTO v_prompt FROM public.prompts WHERE is_active ORDER BY random() LIMIT 1;
    INSERT INTO public.rounds(room_id, number, drawer_member_id, prompt_id, status, started_at)
    VALUES (
      p_room_id,
      i,
      v_m,
      v_prompt,
      CASE WHEN i=1 THEN 'active'::public.round_status ELSE 'pending'::public.round_status END,
      CASE WHEN i=1 THEN now() ELSE NULL END
    );
    i := i + 1; idx := idx + 1; IF idx > mcount THEN idx := 1; END IF;
  END LOOP;
  UPDATE public.rooms SET status = 'in_progress' WHERE id = p_room_id;
END; $$;

CREATE OR REPLACE FUNCTION public.end_game(p_room_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.rooms r WHERE r.id = p_room_id AND r.host_user = auth.uid()) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  DELETE FROM public.rooms WHERE id = p_room_id;
END; $$;

-- Drawer-only prompt exposure; masked for others
CREATE OR REPLACE FUNCTION public.get_active_prompt(p_room_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_round public.rounds%rowtype; v_prompt text; v_drawer_user uuid; v_is_member boolean; v_is_drawer boolean := false; v_len int := 0; v_word text := null; BEGIN
  SELECT EXISTS(SELECT 1 FROM public.room_members m WHERE m.room_id = p_room_id AND m.user_id = auth.uid() AND m.left_at IS NULL) INTO v_is_member;
  IF NOT v_is_member THEN RAISE EXCEPTION 'forbidden'; END IF;
  SELECT * INTO v_round FROM public.rounds WHERE room_id = p_room_id AND status = 'active' LIMIT 1;
  IF NOT FOUND THEN RETURN json_build_object('prompt', null, 'length', 0, 'round_number', null); END IF;
  SELECT p.word INTO v_prompt FROM public.prompts p WHERE p.id = v_round.prompt_id;
  SELECT m.user_id INTO v_drawer_user FROM public.room_members m WHERE m.id = v_round.drawer_member_id;
  v_len := char_length(v_prompt);
  IF v_drawer_user = auth.uid() THEN v_is_drawer := true; END IF;
  IF v_is_drawer THEN v_word := v_prompt; END IF;
  RETURN json_build_object('prompt', v_word, 'length', v_len, 'round_number', v_round.number);
END; $$;

-- Member list for a room
CREATE OR REPLACE FUNCTION public.get_room_members(p_room_id uuid)
RETURNS TABLE(id uuid, username text, is_host boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.room_members m WHERE m.room_id = p_room_id AND m.user_id = auth.uid() AND m.left_at IS NULL) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  RETURN QUERY
    SELECT m.id, m.username, m.is_host FROM public.room_members m
    WHERE m.room_id = p_room_id AND m.left_at IS NULL
    ORDER BY m.joined_at;
END; $$;

-- Advance round (end current, activate next, or finish)
CREATE OR REPLACE FUNCTION public.advance_round(p_room_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_active public.rounds%rowtype; v_next public.rounds%rowtype; v_word text := null; v_finished boolean := false; BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.room_members m WHERE m.room_id = p_room_id AND m.user_id = auth.uid() AND m.left_at IS NULL) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  SELECT * INTO v_active FROM public.rounds WHERE room_id = p_room_id AND status = 'active' FOR UPDATE;
  IF NOT FOUND THEN RETURN json_build_object('finished', true); END IF;
  SELECT p.word INTO v_word FROM public.prompts p WHERE p.id = v_active.prompt_id;
  UPDATE public.rounds SET status = 'ended', ended_at = now() WHERE id = v_active.id;
  SELECT * INTO v_next FROM public.rounds WHERE room_id = p_room_id AND status = 'pending' ORDER BY number ASC LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF FOUND THEN
    UPDATE public.rounds SET status = 'active', started_at = now() WHERE id = v_next.id;
  ELSE
    UPDATE public.rooms SET status = 'finished' WHERE id = p_room_id; v_finished := true;
  END IF;
  RETURN json_build_object('finished', v_finished, 'ended_round', v_active.number, 'ended_word', v_word, 'next_round', CASE WHEN v_finished THEN NULL ELSE v_next.number END);
END; $$;

-- Auto-advance immediately on first correct (server-authoritative)
-- Frontend still shows 5s modal for UX, but server progresses state reliably.
CREATE OR REPLACE FUNCTION public.on_correct_advance()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_cnt int; v_room uuid; BEGIN
  IF NEW.is_correct THEN
    SELECT count(*) INTO v_cnt FROM public.guesses WHERE round_id = NEW.round_id AND is_correct;
    IF v_cnt = 1 THEN
      SELECT room_id INTO v_room FROM public.rounds WHERE id = NEW.round_id;
      PERFORM public.advance_round(v_room);
    END IF;
  END IF;
  RETURN NULL;
END; $$;

-- History upsert (bypass RLS with explicit checks)
CREATE OR REPLACE FUNCTION public.upsert_game_session(
  p_room_id uuid,
  p_room_name text,
  p_host_user_id uuid,
  p_rounds_total int,
  p_round_time_sec int,
  p_started_at timestamptz,
  p_ended_at timestamptz
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE v_id uuid; BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'auth required'; END IF;
  IF NOT (
    public.is_room_member_or_profile(p_room_id)
    OR EXISTS (
      SELECT 1 FROM public.rooms r
      WHERE r.id = p_room_id AND r.host_user = auth.uid()
    )
  ) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  INSERT INTO public.game_sessions(
    room_id, room_name, host_user_id, rounds_total, round_time_sec, started_at, ended_at
  ) VALUES (
    p_room_id, p_room_name, p_host_user_id, p_rounds_total, p_round_time_sec, p_started_at, p_ended_at
  )
  ON CONFLICT (room_id, started_at) DO UPDATE SET
    room_name = EXCLUDED.room_name,
    host_user_id = EXCLUDED.host_user_id,
    rounds_total = EXCLUDED.rounds_total,
    round_time_sec = EXCLUDED.round_time_sec,
    ended_at = EXCLUDED.ended_at
  RETURNING id INTO v_id;
  RETURN v_id;
END; $$;

GRANT EXECUTE ON FUNCTION public.upsert_game_session(uuid, text, uuid, int, int, timestamptz, timestamptz) TO authenticated;

-- History participants upsert (bulk)
CREATE OR REPLACE FUNCTION public.upsert_game_participants(p_rows jsonb)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE v_count int := 0; BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'auth required'; END IF;
  IF p_rows IS NULL THEN RETURN 0; END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(p_rows) AS x(
      session_id uuid,
      user_id uuid,
      username_at_time text,
      is_host boolean,
      score int,
      joined_at timestamptz,
      left_at timestamptz
    )
    JOIN public.game_sessions gs ON gs.id = x.session_id
    LEFT JOIN public.rooms r ON r.id = gs.room_id
    WHERE NOT (
      public.is_room_member_or_profile(gs.room_id)
      OR r.host_user = auth.uid()
    )
  ) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  INSERT INTO public.game_participants(
    session_id, user_id, username_at_time, is_host, score, joined_at, left_at
  )
  SELECT
    x.session_id, x.user_id, x.username_at_time, x.is_host, x.score, x.joined_at, x.left_at
  FROM jsonb_to_recordset(p_rows) AS x(
    session_id uuid,
    user_id uuid,
    username_at_time text,
    is_host boolean,
    score int,
    joined_at timestamptz,
    left_at timestamptz
  )
  ON CONFLICT (session_id, user_id) DO UPDATE SET
    username_at_time = EXCLUDED.username_at_time,
    is_host = EXCLUDED.is_host,
    score = EXCLUDED.score,
    joined_at = EXCLUDED.joined_at,
    left_at = EXCLUDED.left_at;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END; $$;

GRANT EXECUTE ON FUNCTION public.upsert_game_participants(jsonb) TO authenticated;

-- History snapshots upsert (bulk)
CREATE OR REPLACE FUNCTION public.upsert_round_snapshots(p_rows jsonb)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE v_count int := 0; BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'auth required'; END IF;
  IF p_rows IS NULL THEN RETURN 0; END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(p_rows) AS x(
      session_id uuid,
      round_number int,
      drawer_user_id uuid,
      prompt_id uuid,
      prompt_word text,
      image_url text,
      correct_user_id uuid,
      correct_answer text
    )
    JOIN public.game_sessions gs ON gs.id = x.session_id
    LEFT JOIN public.rooms r ON r.id = gs.room_id
    WHERE NOT (
      public.is_room_member_or_profile(gs.room_id)
      OR r.host_user = auth.uid()
    )
  ) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  INSERT INTO public.round_snapshots(
    session_id, round_number, drawer_user_id, prompt_id, prompt_word,
    image_url, correct_user_id, correct_answer
  )
  SELECT
    x.session_id, x.round_number, x.drawer_user_id, x.prompt_id, x.prompt_word,
    x.image_url, x.correct_user_id, x.correct_answer
  FROM jsonb_to_recordset(p_rows) AS x(
    session_id uuid,
    round_number int,
    drawer_user_id uuid,
    prompt_id uuid,
    prompt_word text,
    image_url text,
    correct_user_id uuid,
    correct_answer text
  )
  ON CONFLICT (session_id, round_number) DO UPDATE SET
    drawer_user_id = EXCLUDED.drawer_user_id,
    prompt_id = EXCLUDED.prompt_id,
    prompt_word = EXCLUDED.prompt_word,
    image_url = EXCLUDED.image_url,
    correct_user_id = EXCLUDED.correct_user_id,
    correct_answer = EXCLUDED.correct_answer;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END; $$;

GRANT EXECUTE ON FUNCTION public.upsert_round_snapshots(jsonb) TO authenticated;
