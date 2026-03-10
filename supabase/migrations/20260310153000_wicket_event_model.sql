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
  v_effective_event_type text;
  v_delivery jsonb;
  v_post_state jsonb;
  v_action_type text;
  v_effective_extra_type text;
  v_effective_extra_runs integer;
  v_effective_runs_off_bat integer;
  v_effective_legal_ball boolean;
  v_effective_wicket boolean;
  v_effective_dismissal_kind text;
  v_effective_dismissed_player_id uuid;
  v_replacement_player_id uuid;
  v_current_post_state jsonb;
  v_current_striker_id uuid;
  v_current_non_striker_id uuid;
  v_current_bowler_id uuid;
  v_current_needs_next_bowler boolean := false;
  v_legal_balls integer := 0;
  v_wickets integer := 0;
  v_total_runs integer := 0;
  v_first_innings_runs integer := 0;
  v_boundary_event_type text;
  v_should_complete boolean := false;
  v_error_message text;
  v_active_lock record;
begin
  if auth.uid() is null then
    raise exception 'authenticated scorer session required';
  end if;

  if coalesce(trim(p_event_id), '') = '' then
    raise exception 'event_id is required';
  end if;

  v_effective_event_type := case
    when coalesce(trim(p_event_type), '') = '' then 'delivery_recorded'
    when p_event_type = 'add_ball' then 'delivery_recorded'
    else p_event_type
  end;

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
    v_effective_event_type,
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
      'administrative_state', v_event.result -> 'administrative_state',
      'invalidate_post_state', coalesce((v_event.result ->> 'invalidate_post_state')::boolean, false),
      'result', coalesce(v_event.result, '{}'::jsonb)
    );
  end if;

  if v_effective_event_type = 'delivery_recorded' then
    v_delivery := case
      when jsonb_typeof(p_payload -> 'delivery') = 'object' then p_payload -> 'delivery'
      when jsonb_typeof(p_payload -> 'ball') = 'object' then p_payload -> 'ball'
      else '{}'::jsonb
    end;

    if v_delivery = '{}'::jsonb then
      raise exception 'delivery payload is required';
    end if;

    v_post_state := case
      when jsonb_typeof(p_payload -> 'post_state') = 'object' then p_payload -> 'post_state'
      else null
    end;

    v_effective_extra_type := nullif(v_delivery ->> 'extra_type', '');
    v_effective_runs_off_bat := coalesce((v_delivery ->> 'runs_off_bat')::integer, 0);
    v_effective_extra_runs := coalesce((v_delivery ->> 'extra_runs')::integer, 0);
    v_effective_wicket := coalesce((v_delivery ->> 'wicket')::boolean, false);
    v_effective_dismissal_kind := nullif(v_delivery ->> 'dismissal_kind', '');
    v_effective_dismissed_player_id := nullif(v_delivery ->> 'dismissed_player_id', '')::uuid;

    if v_effective_dismissal_kind is not null or v_effective_dismissed_player_id is not null then
      v_effective_wicket := true;
    end if;

    if v_effective_extra_type = 'wide' then
      v_effective_runs_off_bat := 0;
      v_effective_extra_runs := greatest(2, coalesce(v_effective_extra_runs, 2));
    elsif v_effective_extra_type = 'noball' then
      v_effective_extra_runs := greatest(1, coalesce(v_effective_extra_runs, 1));
    elsif v_effective_extra_type in ('bye', 'legbye') then
      v_effective_runs_off_bat := 0;
      v_effective_extra_runs := greatest(0, coalesce(v_effective_extra_runs, 0));
    else
      v_effective_extra_type := null;
      v_effective_extra_runs := 0;
    end if;

    if v_effective_extra_type in ('wide', 'noball') then
      select case when exists (
        select 1
        from public.balls b
        where b.match_id = p_match_id
          and b.innings_id = p_innings_id
          and b.over_no = nullif(v_delivery ->> 'over_no', '')::integer
          and b.delivery_in_over < nullif(v_delivery ->> 'delivery_in_over', '')::integer
          and b.legal_ball = false
      ) then true else false end
      into v_effective_legal_ball;
    else
      v_effective_legal_ball := true;
    end if;

    if v_effective_wicket then
      if v_effective_dismissal_kind is null then
        raise exception 'dismissal_kind is required for wicket deliveries';
      end if;

      if v_effective_dismissed_player_id is null then
        raise exception 'dismissed_player_id is required for wicket deliveries';
      end if;

      if v_effective_dismissal_kind = 'retired hurt' then
        raise exception 'Use administrative_state_changed for retired hurt events';
      end if;

      if v_effective_dismissed_player_id is distinct from nullif(v_delivery ->> 'striker_id', '')::uuid
        and v_effective_dismissed_player_id is distinct from nullif(v_delivery ->> 'non_striker_id', '')::uuid then
        raise exception 'dismissed_player_id must match the striker or non-striker for wicket deliveries';
      end if;

      if v_effective_dismissal_kind = 'stumped' then
        if v_effective_runs_off_bat > 0 then
          raise exception 'Stumped deliveries cannot include completed bat runs in the current model';
        end if;

        if v_effective_extra_type is not null and v_effective_extra_type <> 'wide' then
          raise exception 'Only run out and stumped deliveries can record wicket extras';
        end if;

        if v_effective_extra_type = 'wide' and v_effective_extra_runs <> 2 then
          raise exception 'Stumped deliveries cannot include completed wide runs in the current model';
        end if;
      elsif v_effective_dismissal_kind <> 'run out' then
        if v_effective_runs_off_bat > 0 then
          raise exception 'Only run out deliveries can record completed bat runs with a wicket';
        end if;

        if v_effective_extra_type is not null or v_effective_extra_runs > 0 then
          raise exception 'Only run out deliveries can record wicket-plus-extras';
        end if;
      end if;
    else
      v_effective_dismissal_kind := null;
      v_effective_dismissed_player_id := null;
    end if;

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
      nullif(v_delivery ->> 'over_no', '')::integer,
      nullif(v_delivery ->> 'delivery_in_over', '')::integer,
      v_effective_legal_ball,
      v_effective_runs_off_bat,
      v_effective_extra_type,
      v_effective_extra_runs,
      v_effective_wicket,
      v_effective_dismissal_kind,
      v_effective_dismissed_player_id,
      nullif(v_delivery ->> 'striker_id', '')::uuid,
      nullif(v_delivery ->> 'non_striker_id', '')::uuid,
      nullif(v_delivery ->> 'bowler_id', '')::uuid,
      coalesce((v_delivery ->> 'batting_turn')::integer, 1),
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
      'event_type', v_effective_event_type,
      'ball', to_jsonb(v_ball),
      'innings', to_jsonb(v_innings),
      'post_state', v_post_state
    ));
  elsif v_effective_event_type = 'administrative_state_changed' then
    if coalesce(v_innings.completed, false) then
      raise exception 'Cannot apply an administrative state change to a completed innings';
    end if;

    v_action_type := nullif(p_payload ->> 'action_type', '');
    v_post_state := case
      when jsonb_typeof(p_payload -> 'post_state') = 'object' then p_payload -> 'post_state'
      else null
    end;

    if v_action_type is null then
      raise exception 'Unsupported administrative_state_changed action_type';
    end if;

    if v_action_type <> 'retired_hurt' then
      raise exception 'Unsupported administrative_state_changed action_type';
    end if;

    if v_post_state is null then
      raise exception 'post_state is required for administrative state changes';
    end if;

    select *
      into v_event
    from public.match_session_events
    where match_id = p_match_id
      and innings_id = p_innings_id
      and status = 'applied'
    order by applied_at desc nulls last, created_at desc, id desc
    limit 1;

    if v_event.id is not null and coalesce((v_event.result ->> 'invalidate_post_state')::boolean, false) then
      raise exception 'Administrative state changes require a current canonical scorer state';
    end if;

    select result -> 'post_state'
      into v_current_post_state
    from public.match_session_events
    where match_id = p_match_id
      and innings_id = p_innings_id
      and status = 'applied'
      and result ? 'post_state'
    order by applied_at desc nulls last, created_at desc, id desc
    limit 1;

    if v_current_post_state is null or v_current_post_state = 'null'::jsonb then
      raise exception 'Administrative state changes require a current canonical scorer state';
    end if;

    v_current_striker_id := nullif(v_current_post_state ->> 'striker_id', '')::uuid;
    v_current_non_striker_id := nullif(v_current_post_state ->> 'non_striker_id', '')::uuid;
    v_current_bowler_id := nullif(v_current_post_state ->> 'bowler_id', '')::uuid;
    v_current_needs_next_bowler := coalesce((v_current_post_state ->> 'needs_next_bowler')::boolean, false);
    v_effective_dismissed_player_id := nullif(p_payload ->> 'dismissed_player_id', '')::uuid;
    v_replacement_player_id := nullif(p_payload ->> 'replacement_player_id', '')::uuid;

    if v_effective_dismissed_player_id is null or v_replacement_player_id is null then
      raise exception 'dismissed_player_id and replacement_player_id are required for retired hurt';
    end if;

    if v_effective_dismissed_player_id is distinct from v_current_striker_id
      and v_effective_dismissed_player_id is distinct from v_current_non_striker_id then
      raise exception 'Retired hurt must apply to the current striker or non-striker';
    end if;

    if v_replacement_player_id = v_current_striker_id or v_replacement_player_id = v_current_non_striker_id then
      raise exception 'Replacement batter must not already be at the crease';
    end if;

    if v_effective_dismissed_player_id = v_current_striker_id then
      if nullif(v_post_state ->> 'striker_id', '')::uuid is distinct from v_replacement_player_id
        or nullif(v_post_state ->> 'non_striker_id', '')::uuid is distinct from v_current_non_striker_id then
        raise exception 'retired_hurt post_state does not match the canonical striker replacement';
      end if;
    else
      if nullif(v_post_state ->> 'striker_id', '')::uuid is distinct from v_current_striker_id
        or nullif(v_post_state ->> 'non_striker_id', '')::uuid is distinct from v_replacement_player_id then
        raise exception 'retired_hurt post_state does not match the canonical non-striker replacement';
      end if;
    end if;

    if nullif(v_post_state ->> 'bowler_id', '')::uuid is distinct from v_current_bowler_id
      or coalesce((v_post_state ->> 'needs_next_bowler')::boolean, false) <> v_current_needs_next_bowler then
      raise exception 'retired_hurt post_state must preserve the current bowler selection state';
    end if;

    update public.match_session_events
    set status = 'applied',
        applied_at = clock_timestamp(),
        result = jsonb_build_object(
          'administrative_state', jsonb_build_object(
            'action_type', v_action_type,
            'dismissed_player_id', v_effective_dismissed_player_id,
            'replacement_player_id', v_replacement_player_id
          ),
          'post_state', v_post_state
        )
    where event_id = p_event_id;

    return jsonb_build_object(
      'ok', true,
      'duplicate', false,
      'event_id', p_event_id,
      'event_type', v_effective_event_type,
      'administrative_state', jsonb_build_object(
        'action_type', v_action_type,
        'dismissed_player_id', v_effective_dismissed_player_id,
        'replacement_player_id', v_replacement_player_id
      ),
      'post_state', v_post_state
    );
  elsif v_effective_event_type = 'edit_ball' then
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

    v_effective_extra_runs := coalesce((v_patch ->> 'extra_runs')::integer, v_ball.extra_runs, 0);
    v_effective_runs_off_bat := coalesce((v_patch ->> 'runs_off_bat')::integer, v_ball.runs_off_bat, 0);
    v_effective_wicket := coalesce((v_patch ->> 'wicket')::boolean, v_ball.wicket);
    v_effective_dismissal_kind := case
      when v_effective_wicket = false then null
      when v_patch ? 'dismissal_kind' then nullif(v_patch ->> 'dismissal_kind', '')
      else v_ball.dismissal_kind
    end;
    v_effective_dismissed_player_id := case
      when v_effective_wicket = false then null
      when v_patch ? 'dismissed_player_id' then nullif(v_patch ->> 'dismissed_player_id', '')::uuid
      else v_ball.dismissed_player_id
    end;

    if v_effective_extra_type = 'wide' then
      v_effective_runs_off_bat := 0;
      v_effective_extra_runs := greatest(2, coalesce(v_effective_extra_runs, 2));
    elsif v_effective_extra_type = 'noball' then
      v_effective_extra_runs := greatest(1, coalesce(v_effective_extra_runs, 1));
    elsif v_effective_extra_type in ('bye', 'legbye') then
      v_effective_runs_off_bat := 0;
      v_effective_extra_runs := greatest(0, coalesce(v_effective_extra_runs, 0));
    else
      v_effective_extra_type := null;
      v_effective_extra_runs := 0;
    end if;

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

    if v_effective_wicket then
      if v_effective_dismissal_kind is null then
        raise exception 'dismissal_kind is required for wicket deliveries';
      end if;

      if v_effective_dismissed_player_id is null then
        raise exception 'dismissed_player_id is required for wicket deliveries';
      end if;

      if v_effective_dismissal_kind = 'retired hurt' then
        raise exception 'Use administrative_state_changed for retired hurt events';
      end if;

      if v_effective_dismissed_player_id is distinct from v_ball.striker_id
        and v_effective_dismissed_player_id is distinct from v_ball.non_striker_id then
        raise exception 'dismissed_player_id must match the striker or non-striker for wicket deliveries';
      end if;

      if v_effective_dismissal_kind = 'stumped' then
        if v_effective_runs_off_bat > 0 then
          raise exception 'Stumped deliveries cannot include completed bat runs in the current model';
        end if;

        if v_effective_extra_type is not null and v_effective_extra_type <> 'wide' then
          raise exception 'Only run out and stumped deliveries can record wicket extras';
        end if;

        if v_effective_extra_type = 'wide' and v_effective_extra_runs <> 2 then
          raise exception 'Stumped deliveries cannot include completed wide runs in the current model';
        end if;
      elsif v_effective_dismissal_kind <> 'run out' then
        if v_effective_runs_off_bat > 0 then
          raise exception 'Only run out deliveries can record completed bat runs with a wicket';
        end if;

        if v_effective_extra_type is not null or v_effective_extra_runs > 0 then
          raise exception 'Only run out deliveries can record wicket-plus-extras';
        end if;
      end if;
    end if;

    update public.balls
    set runs_off_bat = v_effective_runs_off_bat,
        extra_type = v_effective_extra_type,
        extra_runs = v_effective_extra_runs,
        legal_ball = v_effective_legal_ball,
        wicket = v_effective_wicket,
        dismissal_kind = v_effective_dismissal_kind,
        dismissed_player_id = v_effective_dismissed_player_id,
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
      'event_type', v_effective_event_type,
      'ball', to_jsonb(v_ball),
      'innings', to_jsonb(v_innings),
      'invalidate_post_state', true
    );
  elsif v_effective_event_type = 'end_innings' then
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
      'event_type', v_effective_event_type,
      'innings', to_jsonb(v_innings)
    );
  elsif v_effective_event_type = 'reopen_innings' then
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
      'event_type', v_effective_event_type,
      'innings', to_jsonb(v_innings)
    );
  else
    raise exception 'Unsupported event_type: %', v_effective_event_type;
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
