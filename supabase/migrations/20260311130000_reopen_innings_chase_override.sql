do $$
declare
  v_sql text;
begin
  select pg_get_functiondef('public.apply_match_session_event(text, uuid, uuid, text, text, jsonb)'::regprocedure)
    into v_sql;

  if v_sql is null then
    raise exception 'apply_match_session_event function is required before applying reopen chase override';
  end if;

  v_sql := replace(
    v_sql,
    'or (v_innings.innings_no = 2 and v_total_runs >= (v_first_innings_runs + 1))',
    'or (v_innings.innings_no = 2 and coalesce(v_boundary_event_type, '''') <> ''reopen_innings'' and v_total_runs >= (v_first_innings_runs + 1))'
  );

  execute v_sql;
end;
$$;

create or replace function public.get_innings_reopen_status(
  p_match_id uuid,
  p_innings_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = 'public'
as $function$
declare
  v_match public.matches%rowtype;
  v_innings public.innings%rowtype;
  v_boundary_event_type text;
begin
  if auth.uid() is null then
    raise exception 'authenticated scorer session required';
  end if;

  select *
    into v_match
  from public.matches
  where id = p_match_id;

  if v_match.id is null then
    raise exception 'match_id is required';
  end if;

  if v_match.scorer_user_id is distinct from auth.uid() then
    raise exception 'Only the assigned scorer can inspect innings reopen state for this match';
  end if;

  select *
    into v_innings
  from public.innings
  where id = p_innings_id
    and match_id = p_match_id;

  if v_innings.id is null then
    raise exception 'innings_id % does not belong to match %', p_innings_id, p_match_id;
  end if;

  select event_type
    into v_boundary_event_type
  from public.match_session_events
  where match_id = p_match_id
    and innings_id = p_innings_id
    and status = 'applied'
    and event_type in ('end_innings', 'reopen_innings')
  order by applied_at desc nulls last, created_at desc, id desc
  limit 1;

  return jsonb_build_object(
    'ok', true,
    'reopened_for_continuation', coalesce(v_boundary_event_type, '') = 'reopen_innings' and not coalesce(v_innings.completed, false),
    'boundary_event_type', v_boundary_event_type,
    'innings', to_jsonb(v_innings)
  );
end;
$function$;

revoke execute on function public.get_innings_reopen_status(uuid, uuid) from public;
grant execute on function public.get_innings_reopen_status(uuid, uuid) to authenticated;
