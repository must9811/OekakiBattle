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
  max_players int not null default 10 check (max_players between 2 and 10),
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
RETURNS boolean LANGUAGE sql STABLE AS $$
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

  -- First-correct only: award +5, mark as correct. Otherwise, mark as incorrect and 0.
  IF NOT v_any_correct THEN
    NEW.is_correct := true;
    NEW.awarded_points := 5;
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
          ) THEN 3 ELSE 0 END)::int AS points
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
-- Avoid recursive reference to room_members in its own policy to prevent 42P17
-- Allow users to select their own row; hosts can select all rows in their room
CREATE POLICY room_members_select_self_or_host ON public.room_members
  FOR SELECT USING (
    room_members.user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.rooms r
      WHERE r.id = room_members.room_id AND r.host_user = auth.uid()
    )
  );
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
  ('虹','自然'), ('滝','自然'), ('砂漠','自然'), ('嵐','自然'), ('オーロラ','自然'),
  ('火山','自然'), ('夕焼け','自然'), ('森','自然'), ('氷山','自然'), ('流れ星','自然'),
  ('渓谷','自然'), ('霧','自然'), ('星空','自然'), ('湖','自然'), ('洞窟','自然'),
  ('満月','自然'), ('風車','自然'), ('夕立','自然'), ('山頂','自然'), ('海岸線','自然'),

  -- 動物
  ('カメレオン','動物'), ('コアラ','動物'), ('イルカ','動物'), ('ハリネズミ','動物'),
  ('タカ','動物'), ('アリクイ','動物'), ('ラクダ','動物'), ('ペンギン','動物'),
  ('クジラ','動物'), ('タコ','動物'),
  ('カバ','動物'), ('オオカミ','動物'), ('リス','動物'), ('ワニ','動物'), ('フラミンゴ','動物'),
  ('ナマケモノ','動物'), ('トラ','動物'), ('パンダ','動物'), ('ペリカン','動物'), ('ウサギ','動物'),

  -- 食べ物
  ('ピザ','食べ物'), ('ラーメン','食べ物'), ('寿司','食べ物'), ('たこ焼き','食べ物'),
  ('ホットケーキ','食べ物'), ('チョコレート','食べ物'), ('カレー','食べ物'),
  ('アイスクリーム','食べ物'), ('とうもろこし','食べ物'), ('サンドイッチ','食べ物'),
  ('おでん','食べ物'), ('オムライス','食べ物'), ('すいか','食べ物'), ('クレープ','食べ物'),
  ('ハンバーガー','食べ物'), ('ドーナツ','食べ物'), ('たいやき','食べ物'), ('ステーキ','食べ物'),
  ('パフェ','食べ物'), ('餃子','食べ物'),

  -- 日用品・家電
  ('傘','日用品'), ('メガネ','日用品'), ('リモコン','日用品'), ('電球','日用品'),
  ('時計','日用品'), ('歯ブラシ','日用品'), ('ハサミ','日用品'), ('洗濯機','家電'),
  ('ロボット掃除機','家電'), ('扇風機','家電'),

  -- 乗り物
  ('飛行機','乗り物'), ('潜水艦','乗り物'), ('救急車','乗り物'), ('宇宙船','乗り物'),
  ('ジェットコースター','乗り物'), ('気球','乗り物'), ('スケートボード','乗り物'),
  ('戦車','乗り物'), ('馬車','乗り物'), ('自転車','乗り物'),
  ('パトカー','乗り物'), ('トラック','乗り物'), ('ヘリコプター','乗り物'), ('新幹線','乗り物'),
  ('フェリー','乗り物'), ('馬','乗り物'), ('スノーモービル','乗り物'), ('トロッコ','乗り物'),
  ('電動キックボード','乗り物'), ('人工衛星','乗り物'),

  -- 人物・職業
  ('忍者','人物'), ('魔法使い','人物'), ('カメラマン','職業'), ('警察官','職業'),
  ('宇宙飛行士','職業'), ('画家','職業'), ('パン屋','職業'), ('外科医','職業'),
  ('探偵','職業'), ('教師','職業'),

  -- 建物・場所
  ('図書館','建物'), ('お城','建物'), ('灯台','建物'), 
  ('美術館','建物'), ('神社','建物'), ('遊園地','場所'), ('港','場所'), ('砂浜','場所'),
  ('墓地','場所'),

  -- スポーツ・活動
  ('バスケットボール','スポーツ'), ('サーフィン','スポーツ'), ('スキー','スポーツ'),
  ('ボウリング','スポーツ'), ('マラソン','スポーツ'), ('剣道','スポーツ'),
  ('スケート','スポーツ'), ('柔道','スポーツ'), ('卓球','スポーツ'), ('野球','スポーツ'),

  -- 感情・抽象
  ('失恋','感情・出来事'), ('友情','感情・出来事'), ('怒り','感情・出来事'),
  ('驚き','感情・出来事'), ('眠気','感情・出来事'), ('孤独','感情・出来事'),
  ('幸福','感情・出来事'), ('嫉妬','感情・出来事'), ('勇気','感情・出来事'),

  -- ファンタジー・SF
  ('ドラゴン','SF・ファンタジー'), ('タイムマシン','SF・ファンタジー'),
  ('宇宙人','SF・ファンタジー'), ('魔法のランプ','SF・ファンタジー'),
  ('ロボット','SF・ファンタジー'), ('幽霊','SF・ファンタジー'), ('宝の地図','SF・ファンタジー'),
  ('ゾンビ','SF・ファンタジー'), ('伝説の剣','SF・ファンタジー'), ('ワープ','SF・ファンタジー'),
  ('魔法陣','SF・ファンタジー'), 
  ('未来都市','SF・ファンタジー'), 
  ('クリスタル','SF・ファンタジー'), ('召喚','SF・ファンタジー'),
  ('空飛ぶじゅうたん','SF・ファンタジー'), ('ホログラム','SF・ファンタジー'),
  ('魔女','SF・ファンタジー'), ('呪文','SF・ファンタジー'),
  ('宇宙ステーション','SF・ファンタジー'), 
  ('モンスター','SF・ファンタジー'), 
  ('古代遺跡','SF・ファンタジー'), ('天空の城','SF・ファンタジー'),

  -- 行事・季節
  ('花火大会','季節・行事'), ('節分','季節・行事'), ('ハロウィン','季節・行事'),
  ('クリスマスツリー','季節・行事'), ('お正月','季節・行事'), ('ひな祭り','季節・行事'),
  ('夏祭り','季節・行事'), ('紅葉狩り','季節・行事'), ('バレンタイン','季節・行事'),
  ('初日の出','季節・行事'),

  -- 道具・アイテム
  ('地球儀','アイテム'), ('トランプ','アイテム'), ('双眼鏡','アイテム'),
  ('コンパス','アイテム'), ('傘立て','アイテム'), ('望遠鏡','アイテム'),
  ('手鏡','アイテム'), ('巻き物','アイテム'), ('鍵','アイテム'), ('砂時計','アイテム'),
  ('懐中電灯','アイテム'), ('スーツケース','アイテム'), ('スプーン','アイテム'),
  ('ヘッドホン','アイテム'), ('スマートフォン','アイテム'), ('ノートパソコン','アイテム'),
  ('傘','アイテム'), ('鉛筆','アイテム'), ('ルーペ','アイテム'), ('バケツ','アイテム'),
  ('ハンマー','アイテム'),  ('封筒','アイテム'),
  ('メトロノーム','アイテム'), ('釣り竿','アイテム'), 
  ('トランク','アイテム'), ('懐中時計','アイテム'), ('ホッチキス','アイテム'),
  ('鍵','アイテム'),

  -- 文化・芸術
  ('映画館','文化'), ('舞台','文化'), ('絵の具','文化'), ('ピアノ','文化'),
  ('ギター','文化'), ('カラオケ','文化'), ('彫刻','文化'), ('オーケストラ','文化'),
  ('ダンス','文化'), ('漫画','文化'),

  -- 社会・出来事
  ('選挙','社会'), ('卒業式','社会'), ('地震','社会'), ('ニュース番組','社会'),
  ('裁判','社会'), ('病院','社会'), ('引っ越し','社会'), ('プロポーズ','社会'),
  ('結婚式','社会'), ('渋滞','社会'),

  -- 生き物・植物
  ('ヒマワリ','植物'), ('サクラ','植物'), ('サボテン','植物'), ('キノコ','植物'),
  ('紅葉','植物'), ('スイカ','植物'), ('コスモス','植物'), ('竹','植物'),
  ('松ぼっくり','植物'), ('薔薇','植物'),
  ('アサガオ','植物'), ('タンポポ','植物'), ('ハイビスカス','植物'),
  ('イチョウ','植物'), 
  ('モミの木','植物'), ('レンコン','植物'), ('ひまわりの種','植物'),
  ('梅','植物'), ('クローバー','植物'), ('カエル','生き物'),
  ('トカゲ','生き物'), ('セミ','生き物'), ('チョウ','生き物'),
  ('カニ','生き物'), ('カブトムシ','生き物'), ('ナメクジ','生き物'),
  ('ハチ','生き物'), ('シャチ','生き物'),

  -- 遊び・娯楽
  ('ボードゲーム','娯楽'), ('ビデオゲーム','娯楽'), ('マジック','娯楽'),
  ('かくれんぼ','娯楽'),  ('占い','娯楽'),
  ('UFOキャッチャー','娯楽'), ('カードゲーム','娯楽'), ('折り紙','娯楽'), ('ドミノ倒し','娯楽'),

  -- 抽象・概念
  ('自由','概念'), ('未来','概念'), ('夢','概念'), ('時間','概念'), ('希望','概念'),
   ('平和','概念'), ('迷路','概念'),  ('記憶','概念')
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
