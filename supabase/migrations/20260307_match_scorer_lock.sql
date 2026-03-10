-- Historical placeholder migration.
--
-- The repository now replays from the canonical schema snapshot in
-- 20260310082624_remote_schema.sql. Earlier scorer-lock and session-event
-- objects are therefore documented here but created by the later snapshot so
-- clean local resets do not fail on duplicate or out-of-order DDL.
do $$
begin
  raise notice 'Historical scorer lock/session event bootstrap is superseded by 20260310082624_remote_schema.sql';
end;
$$;
