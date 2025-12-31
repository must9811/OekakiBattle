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
