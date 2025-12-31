-- RLS
ALTER TABLE public.rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.room_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rounds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.guesses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.game_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.game_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.round_snapshots ENABLE ROW LEVEL SECURITY;

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

-- Game sessions
CREATE POLICY game_sessions_select_participant ON public.game_sessions
  FOR SELECT USING (public.is_session_participant(id));
CREATE POLICY game_sessions_insert_member ON public.game_sessions
  FOR INSERT WITH CHECK (
    auth.uid() IS NOT NULL
    AND game_sessions.room_id IS NOT NULL
    AND (
      public.is_room_member_or_profile(game_sessions.room_id)
      OR EXISTS (
        SELECT 1 FROM public.rooms r
        WHERE r.id = game_sessions.room_id AND r.host_user = auth.uid()
      )
    )
  );
CREATE POLICY game_sessions_update_member ON public.game_sessions
  FOR UPDATE USING (
    auth.uid() IS NOT NULL
    AND (
      public.is_room_member_or_profile(game_sessions.room_id)
      OR EXISTS (
        SELECT 1 FROM public.rooms r
        WHERE r.id = game_sessions.room_id AND r.host_user = auth.uid()
      )
    )
  ) WITH CHECK (
    auth.uid() IS NOT NULL
    AND (
      public.is_room_member_or_profile(game_sessions.room_id)
      OR EXISTS (
        SELECT 1 FROM public.rooms r
        WHERE r.id = game_sessions.room_id AND r.host_user = auth.uid()
      )
    )
  );

-- Game participants
CREATE POLICY game_participants_select_same_session ON public.game_participants
  FOR SELECT USING (public.is_session_participant(session_id));
CREATE POLICY game_participants_insert_member ON public.game_participants
  FOR INSERT WITH CHECK (
    auth.uid() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.game_sessions gs
      WHERE gs.id = game_participants.session_id
        AND (
          public.is_room_member_or_profile(gs.room_id)
          OR EXISTS (
            SELECT 1 FROM public.rooms r
            WHERE r.id = gs.room_id AND r.host_user = auth.uid()
          )
        )
    )
  );
CREATE POLICY game_participants_update_member ON public.game_participants
  FOR UPDATE USING (
    auth.uid() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.game_sessions gs
      WHERE gs.id = game_participants.session_id
        AND (
          public.is_room_member_or_profile(gs.room_id)
          OR EXISTS (
            SELECT 1 FROM public.rooms r
            WHERE r.id = gs.room_id AND r.host_user = auth.uid()
          )
        )
    )
  ) WITH CHECK (
    auth.uid() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.game_sessions gs
      WHERE gs.id = game_participants.session_id
        AND (
          public.is_room_member_or_profile(gs.room_id)
          OR EXISTS (
            SELECT 1 FROM public.rooms r
            WHERE r.id = gs.room_id AND r.host_user = auth.uid()
          )
        )
    )
  );

-- Round snapshots
CREATE POLICY round_snapshots_select_same_session ON public.round_snapshots
  FOR SELECT USING (public.is_session_participant(session_id));
CREATE POLICY round_snapshots_insert_member ON public.round_snapshots
  FOR INSERT WITH CHECK (
    auth.uid() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.game_sessions gs
      WHERE gs.id = round_snapshots.session_id
        AND (
          public.is_room_member_or_profile(gs.room_id)
          OR EXISTS (
            SELECT 1 FROM public.rooms r
            WHERE r.id = gs.room_id AND r.host_user = auth.uid()
          )
        )
    )
  );
CREATE POLICY round_snapshots_update_member ON public.round_snapshots
  FOR UPDATE USING (
    auth.uid() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.game_sessions gs
      WHERE gs.id = round_snapshots.session_id
        AND (
          public.is_room_member_or_profile(gs.room_id)
          OR EXISTS (
            SELECT 1 FROM public.rooms r
            WHERE r.id = gs.room_id AND r.host_user = auth.uid()
          )
        )
    )
  ) WITH CHECK (
    auth.uid() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.game_sessions gs
      WHERE gs.id = round_snapshots.session_id
        AND (
          public.is_room_member_or_profile(gs.room_id)
          OR EXISTS (
            SELECT 1 FROM public.rooms r
            WHERE r.id = gs.room_id AND r.host_user = auth.uid()
          )
        )
    )
  );
