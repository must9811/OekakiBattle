-- Debug helper for history save policy checks
CREATE OR REPLACE FUNCTION public.debug_history_policy(p_room_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_profile text;
  v_is_member boolean := false;
  v_is_member_or_profile boolean := false;
  v_room_exists boolean := false;
  v_room_host uuid;
  v_is_host boolean := false;
BEGIN
  SELECT p.username INTO v_profile FROM public.profiles p WHERE p.user_id = auth.uid();
  SELECT EXISTS (
    SELECT 1 FROM public.room_members m
    WHERE m.room_id = p_room_id AND m.user_id = auth.uid() AND m.left_at IS NULL
  ) INTO v_is_member;
  SELECT public.is_room_member_or_profile(p_room_id) INTO v_is_member_or_profile;
  SELECT EXISTS (SELECT 1 FROM public.rooms r WHERE r.id = p_room_id) INTO v_room_exists;
  SELECT r.host_user INTO v_room_host FROM public.rooms r WHERE r.id = p_room_id;
  v_is_host := (v_room_host = auth.uid());
  RETURN json_build_object(
    'auth_uid', auth.uid(),
    'profile_username', v_profile,
    'room_exists', v_room_exists,
    'room_host_user', v_room_host,
    'is_member', v_is_member,
    'is_member_or_profile', v_is_member_or_profile,
    'is_host', v_is_host
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.debug_history_policy(uuid) TO authenticated;
