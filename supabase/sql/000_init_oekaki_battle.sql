-- Oekaki Battle - Base Initialization SQL
-- This file only resets objects and defines shared extensions/enums.
-- Tables, functions, policies, and seed data are split into per-table SQL files.

-- =========================
-- Drop existing objects
-- =========================
DROP VIEW IF EXISTS public.v_room_scores;

DROP TABLE IF EXISTS public.guesses CASCADE;
DROP TABLE IF EXISTS public.rounds CASCADE;
DROP TABLE IF EXISTS public.room_members CASCADE;
DROP TABLE IF EXISTS public.prompts CASCADE;
DROP TABLE IF EXISTS public.rooms CASCADE;
DROP TABLE IF EXISTS public.round_snapshots CASCADE;
DROP TABLE IF EXISTS public.game_participants CASCADE;
DROP TABLE IF EXISTS public.game_sessions CASCADE;

DROP TYPE IF EXISTS public.room_status CASCADE;
DROP TYPE IF EXISTS public.round_status CASCADE;

DROP FUNCTION IF EXISTS public.handle_host_leave();
DROP FUNCTION IF EXISTS public.award_guess_points();
DROP FUNCTION IF EXISTS public.normalize_text(text);
DROP FUNCTION IF EXISTS public.is_drawer(uuid);
DROP FUNCTION IF EXISTS public.is_room_host(uuid);
DROP FUNCTION IF EXISTS public.my_member_id(uuid);
DROP FUNCTION IF EXISTS public.is_room_member(uuid);
DROP FUNCTION IF EXISTS public.is_session_participant(uuid);
DROP FUNCTION IF EXISTS public.is_room_member_or_profile(uuid);
DROP FUNCTION IF EXISTS public.is_room_finished(uuid);
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
