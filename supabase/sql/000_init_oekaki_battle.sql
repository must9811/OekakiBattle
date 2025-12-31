-- Oekaki Battle - Full Initialization SQL (fresh Supabase project)
-- Run this on a clean project (or accept drops) to set up schema, RLS, triggers, RPCs, and seed data.

-- =========================
-- Drop existing objects
-- =========================
DROP VIEW IF EXISTS public.v_room_scores;

DROP TABLE IF EXISTS public.guesses CASCADE;
DROP TABLE IF EXISTS public.rounds CASCADE;
DROP TABLE IF EXISTS public.room_members CASCADE;
DROP TABLE IF EXISTS public.prompts CASCADE;
DROP TABLE IF EXISTS public.rooms CASCADE;

DROP TYPE IF EXISTS public.room_status CASCADE;
DROP TYPE IF EXISTS public.round_status CASCADE;

DROP FUNCTION IF EXISTS public.handle_host_leave();
DROP FUNCTION IF EXISTS public.award_guess_points();
DROP FUNCTION IF EXISTS public.normalize_text(text);
DROP FUNCTION IF EXISTS public.is_drawer(uuid);
DROP FUNCTION IF EXISTS public.is_room_host(uuid);
DROP FUNCTION IF EXISTS public.my_member_id(uuid);
DROP FUNCTION IF EXISTS public.is_room_member(uuid);
DROP FUNCTION IF EXISTS public.verify_room_password(uuid, text);
DROP FUNCTION IF EXISTS public.touch_updated_at();
DROP FUNCTION IF EXISTS public.create_room(text, text, text, int, int, int);
DROP FUNCTION IF EXISTS public.join_room(text, text, text);
DROP FUNCTION IF EXISTS public.start_game(uuid);
DROP FUNCTION IF EXISTS public.end_game(uuid);
DROP FUNCTION IF EXISTS public.get_active_prompt(uuid);
DROP FUNCTION IF EXISTS public.get_room_members(uuid);
DROP FUNCTION IF EXISTS public.advance_round(uuid);
DROP FUNCTION IF EXISTS public.on_correct_advance();

-- =========================
-- Extensions
-- =========================
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- =========================
-- Enums
-- =========================
CREATE TYPE public.room_status AS ENUM ('lobby','in_progress','finished');
CREATE TYPE public.round_status AS ENUM ('pending','active','ended','skipped');

-- =========================
-- Tables
-- =========================
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

CREATE TABLE public.prompts (
  id uuid primary key default gen_random_uuid(),
  word text not null unique,
  category text,
  is_active boolean not null default true
);

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

-- =========================
-- Helpers & triggers
-- =========================
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_rooms_updated_at
BEFORE UPDATE ON public.rooms
FOR EACH ROW EXECUTE PROCEDURE public.touch_updated_at();

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

CREATE OR REPLACE FUNCTION public.normalize_text(t text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT lower(trim(t))
$$;

-- Guess scoring + correctness
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

CREATE TRIGGER trg_award_guess
BEFORE INSERT ON public.guesses
FOR EACH ROW EXECUTE PROCEDURE public.award_guess_points();

-- Host leaves -> delete room
CREATE OR REPLACE FUNCTION public.handle_host_leave()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_room_host uuid; BEGIN
  SELECT r.host_user INTO v_room_host FROM public.rooms r WHERE r.id = OLD.room_id;
  IF v_room_host = OLD.user_id THEN DELETE FROM public.rooms WHERE id = OLD.room_id; END IF;
  RETURN NULL; END;
$$;

CREATE TRIGGER trg_host_leave_cleanup
AFTER DELETE ON public.room_members
FOR EACH ROW EXECUTE PROCEDURE public.handle_host_leave();

-- Scores view
CREATE OR REPLACE VIEW public.v_room_scores AS
WITH guess_scores AS (
  SELECT room_id, member_id, sum(awarded_points)::int AS points
  FROM public.guesses
  GROUP BY room_id, member_id
), drawer_bonus AS (
  SELECT rd.room_id,
         rd.drawer_member_id AS member_id,
         (CASE WHEN EXISTS (
            SELECT 1 FROM public.guesses g
            WHERE g.round_id = rd.id AND g.is_correct
          ) THEN 1 ELSE 0 END)::int AS points
  FROM public.rounds rd
)
SELECT room_id, member_id, sum(points)::int AS points
FROM (
  SELECT * FROM guess_scores
  UNION ALL
  SELECT * FROM drawer_bonus
) s
GROUP BY room_id, member_id;

-- Realtime publication
DO $$ BEGIN
  BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.rooms; EXCEPTION WHEN others THEN NULL; END;
  BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.room_members; EXCEPTION WHEN others THEN NULL; END;
  BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.rounds; EXCEPTION WHEN others THEN NULL; END;
  BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.guesses; EXCEPTION WHEN others THEN NULL; END;
END $$;

-- =========================
-- RLS
-- =========================
ALTER TABLE public.rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.room_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rounds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.guesses ENABLE ROW LEVEL SECURITY;

-- Rooms
CREATE POLICY rooms_select_all ON public.rooms FOR SELECT USING (true);
CREATE POLICY rooms_insert_auth ON public.rooms FOR INSERT WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY rooms_update_host ON public.rooms FOR UPDATE USING (auth.uid() = host_user) WITH CHECK (auth.uid() = host_user);
CREATE POLICY rooms_delete_host ON public.rooms FOR DELETE USING (auth.uid() = host_user);

-- Room members
-- Members can read all rows within their room (Realtime updates use RLS)
CREATE POLICY room_members_select_same_room ON public.room_members
  FOR SELECT USING (public.is_room_member(room_id));
CREATE POLICY room_members_insert_join ON public.room_members
  FOR INSERT WITH CHECK (auth.uid() = user_id AND EXISTS (SELECT 1 FROM public.rooms r WHERE r.id = room_id));
CREATE POLICY room_members_update_self ON public.room_members FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY room_members_delete_self ON public.room_members FOR DELETE USING (auth.uid() = user_id);

-- Rounds
CREATE POLICY rounds_select_same_room ON public.rounds
  FOR SELECT USING (public.is_room_member(room_id));
CREATE POLICY rounds_write_host ON public.rounds
  FOR ALL USING (public.is_room_host(room_id)) WITH CHECK (public.is_room_host(room_id));

-- Guesses
CREATE POLICY guesses_select_same_room ON public.guesses
  FOR SELECT USING (public.is_room_member(room_id));
CREATE POLICY guesses_insert_members ON public.guesses
  FOR INSERT WITH CHECK (
    public.is_room_member(room_id)
    AND NOT public.is_drawer(round_id)
  );

-- =========================
-- Seed data
-- =========================
INSERT INTO public.prompts(word, category) VALUES
  -- 自然・風景
  ('にじ','自然'), ('たき','自然'), ('さばく','自然'), ('あらし','自然'), ('おーろら','自然'),
  ('かざん','自然'), ('ゆうやけ','自然'), ('もり','自然'), ('ひょうざん','自然'), ('ながれぼし','自然'),
  ('けいこく','自然'), ('きり','自然'), ('ほしぞら','自然'), ('みずうみ','自然'), ('どうくつ','自然'),
  ('まんげつ','自然'), ('ふうしゃ','自然'), ('ゆうだち','自然'), ('さんちょう','自然'), ('かいがんせん','自然'),

  -- 動物
  ('かめれおん','動物'), ('こあら','動物'), ('いるか','動物'), ('はりねずみ','動物'),
  ('たか','動物'), ('ありくい','動物'), ('らくだ','動物'), ('ぺんぎん','動物'),
  ('くじら','動物'), ('たこ','動物'),
  ('かば','動物'), ('おおかみ','動物'), ('りす','動物'), ('わに','動物'), ('ふらみんご','動物'),
  ('なまけもの','動物'), ('とら','動物'), ('ぱんだ','動物'), ('ぺりかん','動物'), ('うさぎ','動物'),

  -- 食べ物
  ('ぴざ','食べ物'), ('らーめん','食べ物'), ('すし','食べ物'), ('たこやき','食べ物'),
  ('ほっとけーき','食べ物'), ('ちょこれーと','食べ物'), ('かれー','食べ物'),
  ('あいすくりーむ','食べ物'), ('とうもろこし','食べ物'), ('さんどいっち','食べ物'),
  ('おでん','食べ物'), ('おむらいす','食べ物'), ('すいか','食べ物'), ('くれーぷ','食べ物'),
  ('はんばーがー','食べ物'), ('どーなつ','食べ物'), ('たいやき','食べ物'), ('すてーき','食べ物'),
  ('ぱふぇ','食べ物'), ('ぎょうざ','食べ物'),

  -- 日用品・家電
  ('かさ','日用品'), ('めがね','日用品'), ('りもこん','日用品'), ('でんきゅう','日用品'),
  ('とけい','日用品'), ('はぶらし','日用品'), ('はさみ','日用品'), ('せんたくき','家電'),
  ('ろぼっとそうじき','家電'), ('せんぷうき','家電'),

  -- 乗り物
  ('ひこうき','乗り物'), ('せんすいかん','乗り物'), ('きゅうきゅうしゃ','乗り物'), ('うちゅうせん','乗り物'),
  ('じぇっとこーすたー','乗り物'), ('ききゅう','乗り物'), ('すけーとぼーど','乗り物'),
  ('せんしゃ','乗り物'), ('ばしゃ','乗り物'), ('じてんしゃ','乗り物'),
  ('ぱとかー','乗り物'), ('とらっく','乗り物'), ('へりこぷたー','乗り物'), ('しんかんせん','乗り物'),
  ('ふぇりー','乗り物'), ('うま','乗り物'), ('すのーもーびる','乗り物'), ('とろっこ','乗り物'),
  ('でんどうきっくぼーど','乗り物'), ('じんこうえいせい','乗り物'),

  -- 人物・職業
  ('にんじゃ','人物'), ('まほうつかい','人物'), ('かめらまん','職業'), ('けいさつかん','職業'),
  ('うちゅうひこうし','職業'), ('がか','職業'), ('ぱんや','職業'), ('げかい','職業'),
  ('たんてい','職業'), ('きょうし','職業'),

  -- 建物・場所
  ('としょかん','建物'), ('おしろ','建物'), ('とうだい','建物'), 
  ('びじゅつかん','建物'), ('じんじゃ','建物'), ('ゆうえんち','場所'), ('みなと','場所'), ('すなはま','場所'),
  ('ぼち','場所'),

  -- スポーツ・活動
  ('ばすけっとぼーる','スポーツ'), ('さーふぃん','スポーツ'), ('すきー','スポーツ'),
  ('ぼうりんぐ','スポーツ'), ('まらそん','スポーツ'), ('けんどう','スポーツ'),
  ('すけーと','スポーツ'), ('じゅうどう','スポーツ'), ('たっきゅう','スポーツ'), ('やきゅう','スポーツ'),

  -- 感情・抽象
  ('しつれん','感情・出来事'), ('ゆうじょう','感情・出来事'), ('いかり','感情・出来事'),
  ('おどろき','感情・出来事'), ('ねむけ','感情・出来事'), ('こどく','感情・出来事'),
  ('こうふく','感情・出来事'), ('しっと','感情・出来事'), ('ゆうき','感情・出来事'),

  -- ファンタジー・SF
  ('どらごん','SF・ファンタジー'), ('たいむましん','SF・ファンタジー'),
  ('うちゅうじん','SF・ファンタジー'), ('まほうのらんぷ','SF・ファンタジー'),
  ('ろぼっと','SF・ファンタジー'), ('ゆうれい','SF・ファンタジー'), ('たからのちず','SF・ファンタジー'),
  ('ぞんび','SF・ファンタジー'), ('でんせつのつるぎ','SF・ファンタジー'), ('わーぷ','SF・ファンタジー'),
  ('まほうじん','SF・ファンタジー'), 
  ('みらいとし','SF・ファンタジー'), 
  ('くりすたる','SF・ファンタジー'), ('しょうかん','SF・ファンタジー'),
  ('そらとぶじゅうたん','SF・ファンタジー'), ('ほろぐらむ','SF・ファンタジー'),
  ('まじょ','SF・ファンタジー'), ('じゅもん','SF・ファンタジー'),
  ('うちゅうすてーしょん','SF・ファンタジー'), 
  ('もんすたー','SF・ファンタジー'), 
  ('こだいいせき','SF・ファンタジー'), ('てんくうのしろ','SF・ファンタジー'),

  -- 行事・季節
  ('はなびたいかい','季節・行事'), ('せつぶん','季節・行事'), ('はろうぃん','季節・行事'),
  ('くりすますつりー','季節・行事'), ('おしょうがつ','季節・行事'), ('ひなまつり','季節・行事'),
  ('なつまつり','季節・行事'), ('もみじがり','季節・行事'), ('ばれんたいん','季節・行事'),
  ('はつひので','季節・行事'),

  -- 道具・アイテム
  ('ちきゅうぎ','アイテム'), ('とらんぷ','アイテム'), ('そうがんきょう','アイテム'),
  ('こんぱす','アイテム'), ('かさたて','アイテム'), ('ぼうえんきょう','アイテム'),
  ('てかがみ','アイテム'), ('まきもの','アイテム'), ('かぎ','アイテム'), ('すなどけい','アイテム'),
  ('かいちゅうでんとう','アイテム'), ('すーつけーす','アイテム'), ('すぷーん','アイテム'),
  ('へっどほん','アイテム'), ('すまーとふぉん','アイテム'), ('のーとぱそこん','アイテム'),
  ('かさ','アイテム'), ('えんぴつ','アイテム'), ('るーぺ','アイテム'), ('ばけつ','アイテム'),
  ('はんまー','アイテム'), ('ふうとう','アイテム'),
  ('めとろのーむ','アイテム'), ('つりざお','アイテム'), 
  ('とらんく','アイテム'), ('かいちゅうどけい','アイテム'), ('ほっちきす','アイテム'),
  ('かぎ','アイテム'),

  -- 文化・芸術
  ('えいがかん','文化'), ('ぶたい','文化'), ('えのぐ','文化'), ('ぴあの','文化'),
  ('ぎたー','文化'), ('からおけ','文化'), ('ちょうこく','文化'), ('おーけすとら','文化'),
  ('だんす','文化'), ('まんが','文化'),

  -- 社会・出来事
  ('せんきょ','社会'), ('そつぎょうしき','社会'), ('じしん','社会'), ('にゅーすばんぐみ','社会'),
  ('さいばん','社会'), ('びょういん','社会'), ('ひっこし','社会'), ('ぷろぽーず','社会'),
  ('けっこんしき','社会'), ('じゅうたい','社会'),

  -- 生き物・植物
  ('ひまわり','植物'), ('さくら','植物'), ('さぼてん','植物'), ('きのこ','植物'),
  ('こうよう','植物'), ('すいか','植物'), ('こすもす','植物'), ('たけ','植物'),
  ('まつぼっくり','植物'), ('ばら','植物'),
  ('あさがお','植物'), ('たんぽぽ','植物'), ('はいびすかす','植物'),
  ('いちょう','植物'), 
  ('もみのき','植物'), ('れんこん','植物'), ('ひまわりのたね','植物'),
  ('うめ','植物'), ('くろーばー','植物'), ('かえる','生き物'),
  ('とかげ','生き物'), ('せみ','生き物'), ('ちょう','生き物'),
  ('かに','生き物'), ('かぶとむし','生き物'), ('なめくじ','生き物'),
  ('はち','生き物'), ('しゃち','生き物'),

  -- 遊び・娯楽
  ('ぼーどげーむ','娯楽'), ('びでおげーむ','娯楽'), ('まじっく','娯楽'),
  ('かくれんぼ','娯楽'), ('うらない','娯楽'),
  ('ゆーえふおーきゃっちゃー','娯楽'), ('かーどげーむ','娯楽'), ('おりがみ','娯楽'), ('どみのだおし','娯楽'),

  -- 抽象・概念
  ('じゆう','概念'), ('みらい','概念'), ('ゆめ','概念'), ('じかん','概念'), ('きぼう','概念'),
  ('へいわ','概念'), ('めいろ','概念'), ('きおく','概念')
ON CONFLICT (word) DO NOTHING;



-- =========================
-- RPCs (security definer)
-- =========================
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

DROP TRIGGER IF EXISTS trg_on_correct_advance ON public.guesses;
CREATE TRIGGER trg_on_correct_advance
AFTER INSERT ON public.guesses
FOR EACH ROW EXECUTE PROCEDURE public.on_correct_advance();
