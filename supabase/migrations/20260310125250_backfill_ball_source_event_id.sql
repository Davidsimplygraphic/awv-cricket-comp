-- Legacy balls exist without corresponding scoring events.
-- No deterministic backfill is possible from current match_session_events data.
-- Intentionally left as a no-op to avoid corrupt historical linkage.

do $$
declare
  legacy_null_count integer;
begin
  select count(*) into legacy_null_count
  from public.balls
  where source_event_id is null;

  raise notice 'Legacy balls with null source_event_id remain: %', legacy_null_count;
end $$;