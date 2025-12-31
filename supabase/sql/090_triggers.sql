-- Triggers
CREATE TRIGGER trg_rooms_updated_at
BEFORE UPDATE ON public.rooms
FOR EACH ROW EXECUTE PROCEDURE public.touch_updated_at();

CREATE TRIGGER trg_award_guess
BEFORE INSERT ON public.guesses
FOR EACH ROW EXECUTE PROCEDURE public.award_guess_points();

DROP TRIGGER IF EXISTS trg_host_leave_cleanup ON public.room_members;
CREATE TRIGGER trg_host_leave_cleanup
AFTER DELETE ON public.room_members
FOR EACH ROW EXECUTE PROCEDURE public.handle_host_leave();

DROP TRIGGER IF EXISTS trg_on_correct_advance ON public.guesses;
CREATE TRIGGER trg_on_correct_advance
AFTER INSERT ON public.guesses
FOR EACH ROW EXECUTE PROCEDURE public.on_correct_advance();
