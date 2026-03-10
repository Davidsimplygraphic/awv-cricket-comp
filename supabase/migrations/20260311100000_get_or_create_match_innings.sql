create or replace function public.get_or_create_match_innings(
  p_match_id uuid,
  p_innings_no integer
)
returns public.innings
language plpgsql
security definer
set search_path = 'public'
as $function$
declare
  v_match public.matches%rowtype;
  v_innings public.innings%rowtype;
begin
  if auth.uid() is null then
    raise exception 'authenticated scorer session required';
  end if;

  if p_match_id is null then
    raise exception 'match_id is required';
  end if;

  if p_innings_no not in (1, 2) then
    raise exception 'innings_no must be 1 or 2';
  end if;

  select *
    into v_match
  from public.matches
  where id = p_match_id;

  if v_match.id is null then
    raise exception 'match_id % not found', p_match_id;
  end if;

  if v_match.scorer_user_id is distinct from auth.uid() then
    raise exception 'Only the assigned scorer can create or access innings for this match';
  end if;

  select *
    into v_innings
  from public.innings
  where match_id = p_match_id
    and innings_no = p_innings_no
  limit 1;

  if v_innings.id is not null then
    return v_innings;
  end if;

  insert into public.innings (
    match_id,
    innings_no,
    batting_team_id,
    bowling_team_id,
    completed
  )
  values (
    p_match_id,
    p_innings_no,
    case when p_innings_no = 2 then v_match.team_b_id else v_match.team_a_id end,
    case when p_innings_no = 2 then v_match.team_a_id else v_match.team_b_id end,
    false
  )
  on conflict (match_id, innings_no) do nothing;

  select *
    into v_innings
  from public.innings
  where match_id = p_match_id
    and innings_no = p_innings_no
  limit 1;

  if v_innings.id is null then
    raise exception 'Unable to create or load innings % for match %', p_innings_no, p_match_id;
  end if;

  return v_innings;
end;
$function$;

revoke execute on function public.get_or_create_match_innings(uuid, integer) from public;
grant execute on function public.get_or_create_match_innings(uuid, integer) to authenticated;
