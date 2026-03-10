revoke insert, update, delete on table public.balls from anon;
revoke insert, update, delete on table public.innings from anon;
revoke insert, update, delete on table public.matches from anon;
revoke insert, update, delete on table public.match_squads from anon;
revoke insert, update, delete on table public.players from anon;
revoke insert, update, delete on table public.teams from anon;

alter table public.match_scorer_sessions enable row level security;
alter table public.match_session_events enable row level security;

revoke all on table public.match_scorer_sessions from anon;
revoke all on table public.match_scorer_sessions from authenticated;
revoke all on table public.match_session_events from anon;
revoke all on table public.match_session_events from authenticated;

drop policy if exists balls_delete_auth on public.balls;
drop policy if exists balls_insert_auth on public.balls;
drop policy if exists balls_update_auth on public.balls;

drop policy if exists innings_delete_auth on public.innings;
drop policy if exists innings_insert_auth on public.innings;
drop policy if exists innings_update_auth on public.innings;

drop policy if exists players_delete_anon on public.players;
drop policy if exists players_insert_anon on public.players;
drop policy if exists players_update_anon on public.players;

revoke execute on function public.acquire_match_scorer_lock(uuid, text, boolean, text) from public;
revoke execute on function public.apply_match_session_event(text, uuid, uuid, text, text, jsonb) from public;
revoke execute on function public.heartbeat_match_scorer_lock(uuid, text) from public;
revoke execute on function public.release_match_scorer_lock(uuid, text) from public;

grant execute on function public.acquire_match_scorer_lock(uuid, text, boolean, text) to authenticated;
grant execute on function public.apply_match_session_event(text, uuid, uuid, text, text, jsonb) to authenticated;
grant execute on function public.heartbeat_match_scorer_lock(uuid, text) to authenticated;
grant execute on function public.release_match_scorer_lock(uuid, text) to authenticated;

create or replace function public.acquire_match_scorer_lock(
  p_match_id uuid,
  p_client_session_id text,
  p_override boolean default false,
  p_device_label text default null
)
returns jsonb
language plpgsql
security definer
set search_path = 'public'
as $function$
declare
  v_match public.matches%rowtype;
  v_active public.match_scorer_sessions%rowtype;
  v_new public.match_scorer_sessions%rowtype;
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
    raise exception 'Only the assigned scorer can acquire this match lock';
  end if;

  if coalesce(trim(p_client_session_id), '') = '' then
    raise exception 'client_session_id is required';
  end if;

  select *
    into v_active
  from public.match_scorer_sessions
  where match_id = p_match_id
    and status = 'active'
  order by created_at desc
  limit 1
  for update;

  if v_active.id is not null then
    if v_active.client_session_id = p_client_session_id then
      update public.match_scorer_sessions
      set last_seen_at = now(),
          device_label = coalesce(p_device_label, device_label)
      where id = v_active.id
      returning * into v_new;

      return jsonb_build_object(
        'ok', true,
        'has_lock', true,
        'overridden', false,
        'session', to_jsonb(v_new)
      );
    end if;

    if not coalesce(p_override, false) then
      return jsonb_build_object(
        'ok', false,
        'has_lock', false,
        'locked_by_other', true,
        'active_session', to_jsonb(v_active)
      );
    end if;

    update public.match_scorer_sessions
    set status = 'superseded',
        released_at = now()
    where id = v_active.id;
  end if;

  insert into public.match_scorer_sessions (
    match_id,
    client_session_id,
    device_label,
    status,
    override_of,
    last_seen_at
  )
  values (
    p_match_id,
    p_client_session_id,
    p_device_label,
    'active',
    v_active.id,
    now()
  )
  returning * into v_new;

  return jsonb_build_object(
    'ok', true,
    'has_lock', true,
    'overridden', v_active.id is not null,
    'session', to_jsonb(v_new)
  );
end;
$function$;

create or replace function public.apply_match_session_event(
  p_event_id text,
  p_match_id uuid,
  p_innings_id uuid,
  p_client_session_id text default null,
  p_event_type text default 'add_ball',
  p_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = 'public'
as $function$
declare
  v_match public.matches%rowtype;
  v_event public.match_session_events%rowtype;
  v_ball public.balls%rowtype;
  v_innings public.innings%rowtype;
  v_patch jsonb;
  v_target_ball_id uuid;
  v_target_source_event_id text;
  v_error_message text;
  v_active_lock record;
begin
  if auth.uid() is null then
    raise exception 'authenticated scorer session required';
  end if;

  if coalesce(trim(p_event_id), '') = '' then
    raise exception 'event_id is required';
  end if;

  select *
    into v_match
  from public.matches
  where id = p_match_id;

  if v_match.id is null then
    raise exception 'match_id is required';
  end if;

  if v_match.scorer_user_id is distinct from auth.uid() then
    raise exception 'Only the assigned scorer can record events for this match';
  end if;

  select *
    into v_innings
  from public.innings
  where id = p_innings_id
    and match_id = p_match_id;

  if v_innings.id is null then
    raise exception 'innings_id % does not belong to match %', p_innings_id, p_match_id;
  end if;

  select id, client_session_id, last_seen_at
    into v_active_lock
  from public.match_scorer_sessions
  where match_id = p_match_id
    and status = 'active'
  order by created_at desc
  limit 1;

  if v_active_lock.id is not null and coalesce(v_active_lock.client_session_id, '') <> coalesce(p_client_session_id, '') then
    raise exception 'Match is locked by another scorer session';
  end if;

  insert into public.match_session_events (
    event_id,
    match_id,
    innings_id,
    client_session_id,
    event_type,
    payload
  )
  values (
    p_event_id,
    p_match_id,
    p_innings_id,
    p_client_session_id,
    p_event_type,
    coalesce(p_payload, '{}'::jsonb)
  )
  on conflict (event_id) do nothing;

  select * into v_event
  from public.match_session_events
  where event_id = p_event_id;

  if v_event.status = 'applied' then
    return jsonb_build_object(
      'ok', true,
      'duplicate', true,
      'event_id', v_event.event_id,
      'event_type', v_event.event_type,
      'result', coalesce(v_event.result, '{}'::jsonb)
    );
  end if;

  if p_event_type = 'add_ball' then
    insert into public.balls (
      match_id,
      innings_id,
      over_no,
      delivery_in_over,
      legal_ball,
      runs_off_bat,
      extra_type,
      extra_runs,
      wicket,
      dismissal_kind,
      dismissed_player_id,
      striker_id,
      non_striker_id,
      bowler_id,
      batting_turn,
      source_event_id
    )
    values (
      p_match_id,
      p_innings_id,
      nullif(p_payload #>> '{ball,over_no}', '')::integer,
      nullif(p_payload #>> '{ball,delivery_in_over}', '')::integer,
      coalesce((p_payload #>> '{ball,legal_ball}')::boolean, true),
      coalesce((p_payload #>> '{ball,runs_off_bat}')::integer, 0),
      nullif(p_payload #>> '{ball,extra_type}', ''),
      coalesce((p_payload #>> '{ball,extra_runs}')::integer, 0),
      coalesce((p_payload #>> '{ball,wicket}')::boolean, false),
      nullif(p_payload #>> '{ball,dismissal_kind}', ''),
      nullif(p_payload #>> '{ball,dismissed_player_id}', '')::uuid,
      nullif(p_payload #>> '{ball,striker_id}', '')::uuid,
      nullif(p_payload #>> '{ball,non_striker_id}', '')::uuid,
      nullif(p_payload #>> '{ball,bowler_id}', '')::uuid,
      coalesce((p_payload #>> '{ball,batting_turn}')::integer, 1),
      p_event_id
    )
    on conflict (source_event_id) do nothing
    returning * into v_ball;

    if v_ball.id is null then
      select * into v_ball
      from public.balls
      where source_event_id = p_event_id
      limit 1;
    end if;

    update public.match_session_events
    set status = 'applied',
        applied_at = now(),
        result = jsonb_build_object('ball', to_jsonb(v_ball))
    where event_id = p_event_id;

    return jsonb_build_object(
      'ok', true,
      'duplicate', false,
      'event_id', p_event_id,
      'event_type', p_event_type,
      'ball', to_jsonb(v_ball)
    );
  elsif p_event_type = 'edit_ball' then
    v_patch := coalesce(p_payload -> 'patch', '{}'::jsonb);
    v_target_source_event_id := nullif(p_payload ->> 'target_source_event_id', '');
    v_target_ball_id := nullif(p_payload ->> 'ball_id', '')::uuid;

    if v_target_ball_id is not null then
      update public.balls
      set runs_off_bat = coalesce((v_patch ->> 'runs_off_bat')::integer, runs_off_bat),
          extra_type = case when v_patch ? 'extra_type' then nullif(v_patch ->> 'extra_type', '') else extra_type end,
          extra_runs = coalesce((v_patch ->> 'extra_runs')::integer, extra_runs),
          wicket = coalesce((v_patch ->> 'wicket')::boolean, wicket),
          dismissal_kind = case when v_patch ? 'dismissal_kind' then nullif(v_patch ->> 'dismissal_kind', '') else dismissal_kind end,
          dismissed_player_id = case
            when v_patch ? 'dismissed_player_id' then nullif(v_patch ->> 'dismissed_player_id', '')::uuid
            else dismissed_player_id
          end
      where id = v_target_ball_id
        and match_id = p_match_id
        and innings_id = p_innings_id
      returning * into v_ball;
    elsif v_target_source_event_id is not null then
      update public.balls
      set runs_off_bat = coalesce((v_patch ->> 'runs_off_bat')::integer, runs_off_bat),
          extra_type = case when v_patch ? 'extra_type' then nullif(v_patch ->> 'extra_type', '') else extra_type end,
          extra_runs = coalesce((v_patch ->> 'extra_runs')::integer, extra_runs),
          wicket = coalesce((v_patch ->> 'wicket')::boolean, wicket),
          dismissal_kind = case when v_patch ? 'dismissal_kind' then nullif(v_patch ->> 'dismissal_kind', '') else dismissal_kind end,
          dismissed_player_id = case
            when v_patch ? 'dismissed_player_id' then nullif(v_patch ->> 'dismissed_player_id', '')::uuid
            else dismissed_player_id
          end
      where source_event_id = v_target_source_event_id
        and match_id = p_match_id
        and innings_id = p_innings_id
      returning * into v_ball;
    end if;

    if v_ball.id is null then
      raise exception 'Target ball not found for edit event %', p_event_id;
    end if;

    update public.match_session_events
    set status = 'applied',
        applied_at = now(),
        result = jsonb_build_object('ball', to_jsonb(v_ball))
    where event_id = p_event_id;

    return jsonb_build_object(
      'ok', true,
      'duplicate', false,
      'event_id', p_event_id,
      'event_type', p_event_type,
      'ball', to_jsonb(v_ball)
    );
  elsif p_event_type = 'end_innings' then
    update public.innings
    set completed = true
    where id = p_innings_id
      and match_id = p_match_id
    returning * into v_innings;

    update public.match_session_events
    set status = 'applied',
        applied_at = now(),
        result = jsonb_build_object('innings', to_jsonb(v_innings))
    where event_id = p_event_id;

    return jsonb_build_object(
      'ok', true,
      'duplicate', false,
      'event_id', p_event_id,
      'event_type', p_event_type,
      'innings', to_jsonb(v_innings)
    );
  elsif p_event_type = 'reopen_innings' then
    update public.innings
    set completed = false
    where id = p_innings_id
      and match_id = p_match_id
    returning * into v_innings;

    update public.match_session_events
    set status = 'applied',
        applied_at = now(),
        result = jsonb_build_object('innings', to_jsonb(v_innings))
    where event_id = p_event_id;

    return jsonb_build_object(
      'ok', true,
      'duplicate', false,
      'event_id', p_event_id,
      'event_type', p_event_type,
      'innings', to_jsonb(v_innings)
    );
  else
    raise exception 'Unsupported event_type: %', p_event_type;
  end if;
exception
  when others then
    v_error_message := sqlerrm;
    update public.match_session_events
    set status = 'failed',
        applied_at = now(),
        result = jsonb_build_object('error', v_error_message)
    where event_id = p_event_id;
    raise;
end;
$function$;

create or replace function public.heartbeat_match_scorer_lock(
  p_match_id uuid,
  p_client_session_id text
)
returns jsonb
language plpgsql
security definer
set search_path = 'public'
as $function$
declare
  v_match public.matches%rowtype;
  v_active public.match_scorer_sessions%rowtype;
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
    raise exception 'Only the assigned scorer can heartbeat this match lock';
  end if;

  select *
    into v_active
  from public.match_scorer_sessions
  where match_id = p_match_id
    and status = 'active'
  order by created_at desc
  limit 1;

  if v_active.id is null then
    return jsonb_build_object(
      'ok', false,
      'has_lock', false
    );
  end if;

  if v_active.client_session_id <> coalesce(p_client_session_id, '') then
    return jsonb_build_object(
      'ok', false,
      'has_lock', false,
      'active_session', to_jsonb(v_active)
    );
  end if;

  update public.match_scorer_sessions
  set last_seen_at = now()
  where id = v_active.id
  returning * into v_active;

  return jsonb_build_object(
    'ok', true,
    'has_lock', true,
    'session', to_jsonb(v_active)
  );
end;
$function$;

create or replace function public.release_match_scorer_lock(
  p_match_id uuid,
  p_client_session_id text
)
returns jsonb
language plpgsql
security definer
set search_path = 'public'
as $function$
declare
  v_match public.matches%rowtype;
  v_active public.match_scorer_sessions%rowtype;
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
    raise exception 'Only the assigned scorer can release this match lock';
  end if;

  select *
    into v_active
  from public.match_scorer_sessions
  where match_id = p_match_id
    and status = 'active'
  order by created_at desc
  limit 1
  for update;

  if v_active.id is null then
    return jsonb_build_object(
      'ok', true,
      'released', false
    );
  end if;

  if v_active.client_session_id <> coalesce(p_client_session_id, '') then
    return jsonb_build_object(
      'ok', false,
      'released', false,
      'active_session', to_jsonb(v_active)
    );
  end if;

  update public.match_scorer_sessions
  set status = 'released',
      released_at = now(),
      last_seen_at = now()
  where id = v_active.id
  returning * into v_active;

  return jsonb_build_object(
    'ok', true,
    'released', true,
    'session', to_jsonb(v_active)
  );
end;
$function$;
