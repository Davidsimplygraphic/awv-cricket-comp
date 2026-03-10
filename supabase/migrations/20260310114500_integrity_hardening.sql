revoke insert, update, delete on table public.balls from anon;
revoke insert, update, delete on table public.innings from anon;
revoke insert, update, delete on table public.matches from anon;
revoke insert, update, delete on table public.match_squads from anon;
revoke insert, update, delete on table public.players from anon;
revoke insert, update, delete on table public.teams from anon;

alter table public.match_scorer_sessions enable row level security;
alter table public.match_session_events enable row level security;
alter table public.balls add column if not exists updated_at timestamp with time zone not null default now();

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'balls_source_event_id_fkey'
      and conrelid = 'public.balls'::regclass
  ) then
    alter table public.balls
      add constraint balls_source_event_id_fkey
      foreign key (source_event_id)
      references public.match_session_events(event_id)
      on delete cascade
      not valid;
  end if;
end;
$$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'balls_source_event_id_required_check'
      and conrelid = 'public.balls'::regclass
  ) then
    alter table public.balls
      add constraint balls_source_event_id_required_check
      check (source_event_id is not null)
      not valid;
  end if;
end;
$$;

alter table public.balls validate constraint balls_source_event_id_fkey;

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
  v_effective_extra_type text;
  v_effective_extra_runs integer;
  v_effective_legal_ball boolean;
  v_legal_balls integer := 0;
  v_wickets integer := 0;
  v_total_runs integer := 0;
  v_first_innings_runs integer := 0;
  v_boundary_event_type text;
  v_should_complete boolean := false;
  v_post_state jsonb;
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
      'ball', v_event.result -> 'ball',
      'innings', v_event.result -> 'innings',
      'post_state', v_event.result -> 'post_state',
      'invalidate_post_state', coalesce((v_event.result ->> 'invalidate_post_state')::boolean, false),
      'result', coalesce(v_event.result, '{}'::jsonb)
    );
  end if;

  if p_event_type = 'add_ball' then
    if coalesce(v_innings.completed, false) then
      raise exception 'Cannot add a ball to a completed innings';
    end if;

    select
      coalesce(sum(case when b.legal_ball = false then 0 else 1 end), 0),
      coalesce(sum(case when coalesce(b.wicket, false) then 1 else 0 end), 0),
      coalesce(sum(coalesce(b.runs_off_bat, 0) + coalesce(b.extra_runs, 0)), 0)
      into v_legal_balls, v_wickets, v_total_runs
    from public.balls b
    where b.match_id = p_match_id
      and b.innings_id = p_innings_id;

    if v_innings.innings_no = 2 then
      select coalesce(sum(coalesce(b.runs_off_bat, 0) + coalesce(b.extra_runs, 0)), 0)
        into v_first_innings_runs
      from public.balls b
      join public.innings i on i.id = b.innings_id
      where b.match_id = p_match_id
        and i.match_id = p_match_id
        and i.innings_no = 1;
    else
      v_first_innings_runs := 0;
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

    v_should_complete := (
      v_legal_balls >= greatest(1, coalesce(v_match.overs_limit, 20)) * 6
      or v_wickets >= greatest(1, coalesce(v_match.wicket_cap, 10))
      or (v_innings.innings_no = 2 and v_total_runs >= (v_first_innings_runs + 1))
    );

    if coalesce(v_boundary_event_type, '') = 'end_innings' then
      v_should_complete := true;
    end if;

    if v_should_complete then
      update public.innings
      set completed = true
      where id = p_innings_id
        and match_id = p_match_id
      returning * into v_innings;

      update public.matches
      set status = case
        when v_innings.innings_no = 2 then 'completed'
        else 'playing'
      end
      where id = p_match_id
      returning * into v_match;

      raise exception 'Cannot add a ball to a completed innings';
    end if;

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
    on conflict (source_event_id) where source_event_id is not null do nothing
    returning * into v_ball;

    if v_ball.id is null then
      select * into v_ball
      from public.balls
      where source_event_id = p_event_id
      limit 1;
    end if;

    select
      coalesce(sum(case when b.legal_ball = false then 0 else 1 end), 0),
      coalesce(sum(case when coalesce(b.wicket, false) then 1 else 0 end), 0),
      coalesce(sum(coalesce(b.runs_off_bat, 0) + coalesce(b.extra_runs, 0)), 0)
      into v_legal_balls, v_wickets, v_total_runs
    from public.balls b
    where b.match_id = p_match_id
      and b.innings_id = p_innings_id;

    if v_innings.innings_no = 2 then
      select coalesce(sum(coalesce(b.runs_off_bat, 0) + coalesce(b.extra_runs, 0)), 0)
        into v_first_innings_runs
      from public.balls b
      join public.innings i on i.id = b.innings_id
      where b.match_id = p_match_id
        and i.match_id = p_match_id
        and i.innings_no = 1;
    else
      v_first_innings_runs := 0;
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

    v_should_complete := (
      v_legal_balls >= greatest(1, coalesce(v_match.overs_limit, 20)) * 6
      or v_wickets >= greatest(1, coalesce(v_match.wicket_cap, 10))
      or (v_innings.innings_no = 2 and v_total_runs >= (v_first_innings_runs + 1))
    );

    if coalesce(v_boundary_event_type, '') = 'end_innings' then
      v_should_complete := true;
    end if;

    update public.innings
    set completed = v_should_complete
    where id = p_innings_id
      and match_id = p_match_id
    returning * into v_innings;

    update public.matches
    set status = case
      when v_innings.innings_no = 2 and v_should_complete then 'completed'
      else 'playing'
    end
    where id = p_match_id
    returning * into v_match;

    v_post_state := case
      when jsonb_typeof(p_payload -> 'post_state') = 'object' then p_payload -> 'post_state'
      else null
    end;

    update public.match_session_events
    set status = 'applied',
        applied_at = clock_timestamp(),
        result = jsonb_strip_nulls(jsonb_build_object(
          'ball', to_jsonb(v_ball),
          'innings', to_jsonb(v_innings),
          'post_state', v_post_state
        ))
    where event_id = p_event_id;

    return jsonb_strip_nulls(jsonb_build_object(
      'ok', true,
      'duplicate', false,
      'event_id', p_event_id,
      'event_type', p_event_type,
      'ball', to_jsonb(v_ball),
      'innings', to_jsonb(v_innings),
      'post_state', v_post_state
    ));
  elsif p_event_type = 'edit_ball' then
    v_patch := coalesce(p_payload -> 'patch', '{}'::jsonb);
    v_target_source_event_id := nullif(p_payload ->> 'target_source_event_id', '');
    v_target_ball_id := nullif(p_payload ->> 'ball_id', '')::uuid;

    if v_target_ball_id is not null then
      select *
        into v_ball
      from public.balls
      where id = v_target_ball_id
        and match_id = p_match_id
        and innings_id = p_innings_id;
    elsif v_target_source_event_id is not null then
      select *
        into v_ball
      from public.balls
      where source_event_id = v_target_source_event_id
        and match_id = p_match_id
        and innings_id = p_innings_id;
    end if;

    if v_ball.id is null then
      raise exception 'Target ball not found for edit event %', p_event_id;
    end if;

    if exists (
      select 1
      from public.balls later_ball
      where later_ball.match_id = p_match_id
        and later_ball.innings_id = p_innings_id
        and (
          later_ball.over_no > v_ball.over_no
          or (later_ball.over_no = v_ball.over_no and later_ball.delivery_in_over > v_ball.delivery_in_over)
        )
    ) then
      raise exception 'Only the latest ball in an innings can be edited safely';
    end if;

    v_effective_extra_type := case
      when v_patch ? 'extra_type' then nullif(v_patch ->> 'extra_type', '')
      else v_ball.extra_type
    end;

    v_effective_extra_runs := case
      when v_effective_extra_type = 'wide' then greatest(2, coalesce((v_patch ->> 'extra_runs')::integer, v_ball.extra_runs, 0))
      when v_effective_extra_type = 'noball' then greatest(1, coalesce((v_patch ->> 'extra_runs')::integer, v_ball.extra_runs, 1))
      when v_effective_extra_type in ('bye', 'legbye') then greatest(0, coalesce((v_patch ->> 'extra_runs')::integer, v_ball.extra_runs, 0))
      else 0
    end;

    select case
      when v_effective_extra_type in ('wide', 'noball') then exists (
        select 1
        from public.balls b
        where b.match_id = p_match_id
          and b.innings_id = p_innings_id
          and b.over_no = v_ball.over_no
          and b.delivery_in_over < v_ball.delivery_in_over
          and b.legal_ball = false
      )
      else true
    end
    into v_effective_legal_ball;

    update public.balls
    set runs_off_bat = case
          when v_effective_extra_type in ('wide', 'bye', 'legbye') then 0
          else coalesce((v_patch ->> 'runs_off_bat')::integer, v_ball.runs_off_bat, 0)
        end,
        extra_type = v_effective_extra_type,
        extra_runs = v_effective_extra_runs,
        legal_ball = v_effective_legal_ball,
        wicket = coalesce((v_patch ->> 'wicket')::boolean, v_ball.wicket),
        dismissal_kind = case
          when coalesce((v_patch ->> 'wicket')::boolean, v_ball.wicket) = false then null
          when v_patch ? 'dismissal_kind' then nullif(v_patch ->> 'dismissal_kind', '')
          else v_ball.dismissal_kind
        end,
        dismissed_player_id = case
          when coalesce((v_patch ->> 'wicket')::boolean, v_ball.wicket) = false then null
          when v_patch ? 'dismissed_player_id' then nullif(v_patch ->> 'dismissed_player_id', '')::uuid
          else v_ball.dismissed_player_id
        end,
        updated_at = now()
    where id = v_ball.id
    returning * into v_ball;

    select
      coalesce(sum(case when b.legal_ball = false then 0 else 1 end), 0),
      coalesce(sum(case when coalesce(b.wicket, false) then 1 else 0 end), 0),
      coalesce(sum(coalesce(b.runs_off_bat, 0) + coalesce(b.extra_runs, 0)), 0)
      into v_legal_balls, v_wickets, v_total_runs
    from public.balls b
    where b.match_id = p_match_id
      and b.innings_id = p_innings_id;

    if v_innings.innings_no = 2 then
      select coalesce(sum(coalesce(b.runs_off_bat, 0) + coalesce(b.extra_runs, 0)), 0)
        into v_first_innings_runs
      from public.balls b
      join public.innings i on i.id = b.innings_id
      where b.match_id = p_match_id
        and i.match_id = p_match_id
        and i.innings_no = 1;
    else
      v_first_innings_runs := 0;
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

    v_should_complete := (
      v_legal_balls >= greatest(1, coalesce(v_match.overs_limit, 20)) * 6
      or v_wickets >= greatest(1, coalesce(v_match.wicket_cap, 10))
      or (v_innings.innings_no = 2 and v_total_runs >= (v_first_innings_runs + 1))
    );

    if coalesce(v_boundary_event_type, '') = 'end_innings' then
      v_should_complete := true;
    end if;

    update public.innings
    set completed = v_should_complete
    where id = p_innings_id
      and match_id = p_match_id
    returning * into v_innings;

    update public.matches
    set status = case
      when v_innings.innings_no = 2 and v_should_complete then 'completed'
      when exists (select 1 from public.balls where match_id = p_match_id) then 'playing'
      else 'scheduled'
    end
    where id = p_match_id
    returning * into v_match;

    update public.match_session_events
    set status = 'applied',
        applied_at = clock_timestamp(),
        result = jsonb_build_object(
          'ball', to_jsonb(v_ball),
          'innings', to_jsonb(v_innings),
          'invalidate_post_state', true
        )
    where event_id = p_event_id;

    return jsonb_build_object(
      'ok', true,
      'duplicate', false,
      'event_id', p_event_id,
      'event_type', p_event_type,
      'ball', to_jsonb(v_ball),
      'innings', to_jsonb(v_innings),
      'invalidate_post_state', true
    );
  elsif p_event_type = 'end_innings' then
    update public.innings
    set completed = true
    where id = p_innings_id
      and match_id = p_match_id
    returning * into v_innings;

    update public.matches
    set status = case
      when v_innings.innings_no = 2 then 'completed'
      else 'playing'
    end
    where id = p_match_id;

    update public.match_session_events
    set status = 'applied',
        applied_at = clock_timestamp(),
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

    update public.matches
    set status = case
      when exists (select 1 from public.balls where match_id = p_match_id) then 'playing'
      else 'scheduled'
    end
    where id = p_match_id;

    update public.match_session_events
    set status = 'applied',
        applied_at = clock_timestamp(),
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
        applied_at = clock_timestamp(),
        result = jsonb_build_object('error', v_error_message)
    where event_id = p_event_id;
    raise;
end;
$function$;

create or replace function public.get_innings_recovery_state(
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
  v_latest public.match_session_events%rowtype;
  v_latest_with_state public.match_session_events%rowtype;
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
    raise exception 'Only the assigned scorer can recover innings state for this match';
  end if;

  select *
    into v_innings
  from public.innings
  where id = p_innings_id
    and match_id = p_match_id;

  if v_innings.id is null then
    raise exception 'innings_id % does not belong to match %', p_innings_id, p_match_id;
  end if;

  select *
    into v_latest
  from public.match_session_events
  where match_id = p_match_id
    and innings_id = p_innings_id
    and status = 'applied'
  order by applied_at desc nulls last, created_at desc, id desc
  limit 1;

  if v_latest.id is not null and coalesce((v_latest.result ->> 'invalidate_post_state')::boolean, false) then
    return jsonb_build_object(
      'ok', true,
      'innings', to_jsonb(v_innings),
      'recovery_state', null,
      'state_invalidated', true,
      'event_id', v_latest.event_id
    );
  end if;

  select *
    into v_latest_with_state
  from public.match_session_events
  where match_id = p_match_id
    and innings_id = p_innings_id
    and status = 'applied'
    and result ? 'post_state'
  order by applied_at desc nulls last, created_at desc, id desc
  limit 1;

  return jsonb_build_object(
    'ok', true,
    'innings', to_jsonb(v_innings),
    'recovery_state', coalesce(v_latest_with_state.result -> 'post_state', 'null'::jsonb),
    'state_invalidated', false,
    'event_id', v_latest_with_state.event_id
  );
end;
$function$;

revoke execute on function public.get_innings_recovery_state(uuid, uuid) from public;
grant execute on function public.get_innings_recovery_state(uuid, uuid) to authenticated;

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

create or replace function public.reset_match_state(
  p_match_id uuid,
  p_client_session_id text default null,
  p_clear_squads boolean default true
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
    raise exception 'Only the assigned scorer can reset this match';
  end if;

  select *
    into v_active
  from public.match_scorer_sessions
  where match_id = p_match_id
    and status = 'active'
  order by created_at desc
  limit 1
  for update;

  if v_active.id is not null and coalesce(v_active.client_session_id, '') <> coalesce(p_client_session_id, '') then
    raise exception 'Match is locked by another scorer session';
  end if;

  delete from public.match_scorer_sessions
  where match_id = p_match_id;

  delete from public.match_session_events
  where match_id = p_match_id;

  delete from public.balls
  where match_id = p_match_id;

  delete from public.innings
  where match_id = p_match_id;

  if coalesce(p_clear_squads, false) and v_match.fixture_id is not null then
    delete from public.match_squads
    where fixture_id = v_match.fixture_id;
  end if;

  update public.matches
  set status = 'scheduled',
      wicket_cap = null
  where id = p_match_id
  returning * into v_match;

  return jsonb_build_object(
    'ok', true,
    'match', to_jsonb(v_match)
  );
end;
$function$;

revoke execute on function public.reset_match_state(uuid, text, boolean) from public;
grant execute on function public.reset_match_state(uuid, text, boolean) to authenticated;

create or replace function public.delete_match_state(
  p_match_id uuid,
  p_client_session_id text default null
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
    raise exception 'Only the assigned scorer can delete this match';
  end if;

  select *
    into v_active
  from public.match_scorer_sessions
  where match_id = p_match_id
    and status = 'active'
  order by created_at desc
  limit 1
  for update;

  if v_active.id is not null and coalesce(v_active.client_session_id, '') <> coalesce(p_client_session_id, '') then
    raise exception 'Match is locked by another scorer session';
  end if;

  if v_match.fixture_id is not null then
    delete from public.match_squads
    where fixture_id = v_match.fixture_id;
  end if;

  delete from public.matches
  where id = p_match_id;

  return jsonb_build_object(
    'ok', true,
    'match_id', p_match_id
  );
end;
$function$;

revoke execute on function public.delete_match_state(uuid, text) from public;
grant execute on function public.delete_match_state(uuid, text) to authenticated;
