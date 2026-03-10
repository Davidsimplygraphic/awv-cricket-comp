drop extension if exists "pg_net";


  create table "public"."balls" (
    "id" uuid not null default extensions.uuid_generate_v4(),
    "match_id" uuid,
    "innings_id" uuid,
    "over_no" integer not null,
    "delivery_in_over" integer not null,
    "legal_ball" boolean not null default true,
    "runs_off_bat" integer default 0,
    "extra_type" text,
    "extra_runs" integer default 0,
    "wicket" boolean default false,
    "dismissed_player_id" uuid,
    "dismissal_kind" text,
    "fielder_player_id" uuid,
    "striker_id" uuid,
    "non_striker_id" uuid,
    "bowler_id" uuid,
    "created_at" timestamp with time zone default now(),
    "batting_turn" integer,
    "source_event_id" text
      );


alter table "public"."balls" enable row level security;


  create table "public"."innings" (
    "id" uuid not null default extensions.uuid_generate_v4(),
    "match_id" uuid,
    "innings_no" integer not null,
    "batting_team_id" uuid,
    "bowling_team_id" uuid,
    "completed" boolean default false,
    "created_at" timestamp with time zone not null default now(),
    "updated_at" timestamp with time zone not null default now(),
    "batting_sequence" integer
      );


alter table "public"."innings" enable row level security;


  create table "public"."match_scorer_sessions" (
    "id" uuid not null default gen_random_uuid(),
    "match_id" uuid not null,
    "client_session_id" text not null,
    "device_label" text,
    "status" text not null default 'active'::text,
    "override_of" uuid,
    "created_at" timestamp with time zone not null default now(),
    "last_seen_at" timestamp with time zone not null default now(),
    "released_at" timestamp with time zone,
    "metadata" jsonb not null default '{}'::jsonb
      );



  create table "public"."match_session_events" (
    "id" uuid not null default gen_random_uuid(),
    "event_id" text not null,
    "match_id" uuid not null,
    "innings_id" uuid not null,
    "client_session_id" text,
    "event_type" text not null,
    "payload" jsonb not null default '{}'::jsonb,
    "status" text not null default 'pending'::text,
    "result" jsonb,
    "created_at" timestamp with time zone not null default now(),
    "applied_at" timestamp with time zone
      );



  create table "public"."match_squads" (
    "id" uuid not null default gen_random_uuid(),
    "fixture_id" uuid not null,
    "team_id" uuid not null,
    "player_id" uuid not null,
    "is_playing" boolean default true,
    "created_at" timestamp with time zone default now()
      );


alter table "public"."match_squads" enable row level security;


  create table "public"."matches" (
    "id" uuid not null default extensions.uuid_generate_v4(),
    "team_a_id" uuid,
    "team_b_id" uuid,
    "overs_limit" integer default 20,
    "status" text default 'draft'::text,
    "scorer_user_id" uuid,
    "created_at" timestamp with time zone default now(),
    "scheduled_at" timestamp with time zone,
    "match_format" text,
    "fixture_id" uuid,
    "wicket_cap" integer
      );


alter table "public"."matches" enable row level security;


  create table "public"."players" (
    "id" uuid not null default extensions.uuid_generate_v4(),
    "team_id" uuid,
    "name" text not null,
    "active" boolean default true
      );


alter table "public"."players" enable row level security;


  create table "public"."teams" (
    "id" uuid not null default extensions.uuid_generate_v4(),
    "name" text not null,
    "short_name" text not null,
    "captain_user_id" uuid
      );


alter table "public"."teams" enable row level security;

CREATE UNIQUE INDEX balls_pkey ON public.balls USING btree (id);

CREATE UNIQUE INDEX balls_source_event_id_key ON public.balls USING btree (source_event_id) WHERE (source_event_id IS NOT NULL);

CREATE UNIQUE INDEX balls_unique_position ON public.balls USING btree (innings_id, over_no, delivery_in_over);

CREATE INDEX idx_match_squads_fixture ON public.match_squads USING btree (fixture_id);

CREATE INDEX idx_match_squads_fixture_team ON public.match_squads USING btree (fixture_id, team_id);

CREATE UNIQUE INDEX innings_pkey ON public.innings USING btree (id);

CREATE UNIQUE INDEX innings_unique_match_inningsno ON public.innings USING btree (match_id, innings_no);

CREATE UNIQUE INDEX innings_unique_per_match ON public.innings USING btree (match_id, innings_no);

CREATE UNIQUE INDEX innings_unique_per_match_inningsno ON public.innings USING btree (match_id, innings_no);

CREATE INDEX match_scorer_sessions_client_session_idx ON public.match_scorer_sessions USING btree (client_session_id, created_at DESC);

CREATE INDEX match_scorer_sessions_match_id_idx ON public.match_scorer_sessions USING btree (match_id, created_at DESC);

CREATE UNIQUE INDEX match_scorer_sessions_one_active_per_match_idx ON public.match_scorer_sessions USING btree (match_id) WHERE (status = 'active'::text);

CREATE UNIQUE INDEX match_scorer_sessions_pkey ON public.match_scorer_sessions USING btree (id);

CREATE UNIQUE INDEX match_session_events_event_id_key ON public.match_session_events USING btree (event_id);

CREATE INDEX match_session_events_innings_id_idx ON public.match_session_events USING btree (innings_id, created_at DESC);

CREATE INDEX match_session_events_match_id_idx ON public.match_session_events USING btree (match_id, created_at DESC);

CREATE UNIQUE INDEX match_session_events_pkey ON public.match_session_events USING btree (id);

CREATE INDEX match_session_events_status_idx ON public.match_session_events USING btree (status);

CREATE UNIQUE INDEX match_squads_fixture_id_team_id_player_id_key ON public.match_squads USING btree (fixture_id, team_id, player_id);

CREATE UNIQUE INDEX match_squads_pkey ON public.match_squads USING btree (id);

CREATE UNIQUE INDEX matches_pkey ON public.matches USING btree (id);

CREATE UNIQUE INDEX players_pkey ON public.players USING btree (id);

CREATE UNIQUE INDEX teams_pkey ON public.teams USING btree (id);

alter table "public"."balls" add constraint "balls_pkey" PRIMARY KEY using index "balls_pkey";

alter table "public"."innings" add constraint "innings_pkey" PRIMARY KEY using index "innings_pkey";

alter table "public"."match_scorer_sessions" add constraint "match_scorer_sessions_pkey" PRIMARY KEY using index "match_scorer_sessions_pkey";

alter table "public"."match_session_events" add constraint "match_session_events_pkey" PRIMARY KEY using index "match_session_events_pkey";

alter table "public"."match_squads" add constraint "match_squads_pkey" PRIMARY KEY using index "match_squads_pkey";

alter table "public"."matches" add constraint "matches_pkey" PRIMARY KEY using index "matches_pkey";

alter table "public"."players" add constraint "players_pkey" PRIMARY KEY using index "players_pkey";

alter table "public"."teams" add constraint "teams_pkey" PRIMARY KEY using index "teams_pkey";

alter table "public"."balls" add constraint "balls_bowler_id_fkey" FOREIGN KEY (bowler_id) REFERENCES public.players(id) not valid;

alter table "public"."balls" validate constraint "balls_bowler_id_fkey";

alter table "public"."balls" add constraint "balls_delivery_in_over_check" CHECK (((delivery_in_over >= 1) AND (delivery_in_over <= 7))) not valid;

alter table "public"."balls" validate constraint "balls_delivery_in_over_check";

alter table "public"."balls" add constraint "balls_dismissed_player_id_fkey" FOREIGN KEY (dismissed_player_id) REFERENCES public.players(id) not valid;

alter table "public"."balls" validate constraint "balls_dismissed_player_id_fkey";

alter table "public"."balls" add constraint "balls_extra_type_check" CHECK ((extra_type = ANY (ARRAY['wide'::text, 'noball'::text, 'bye'::text, 'legbye'::text]))) not valid;

alter table "public"."balls" validate constraint "balls_extra_type_check";

alter table "public"."balls" add constraint "balls_fielder_player_id_fkey" FOREIGN KEY (fielder_player_id) REFERENCES public.players(id) not valid;

alter table "public"."balls" validate constraint "balls_fielder_player_id_fkey";

alter table "public"."balls" add constraint "balls_innings_id_fkey" FOREIGN KEY (innings_id) REFERENCES public.innings(id) ON DELETE CASCADE not valid;

alter table "public"."balls" validate constraint "balls_innings_id_fkey";

alter table "public"."balls" add constraint "balls_match_id_fkey" FOREIGN KEY (match_id) REFERENCES public.matches(id) ON DELETE CASCADE not valid;

alter table "public"."balls" validate constraint "balls_match_id_fkey";

alter table "public"."balls" add constraint "balls_non_striker_id_fkey" FOREIGN KEY (non_striker_id) REFERENCES public.players(id) not valid;

alter table "public"."balls" validate constraint "balls_non_striker_id_fkey";

alter table "public"."balls" add constraint "balls_striker_id_fkey" FOREIGN KEY (striker_id) REFERENCES public.players(id) not valid;

alter table "public"."balls" validate constraint "balls_striker_id_fkey";

alter table "public"."innings" add constraint "innings_batting_team_id_fkey" FOREIGN KEY (batting_team_id) REFERENCES public.teams(id) not valid;

alter table "public"."innings" validate constraint "innings_batting_team_id_fkey";

alter table "public"."innings" add constraint "innings_bowling_team_id_fkey" FOREIGN KEY (bowling_team_id) REFERENCES public.teams(id) not valid;

alter table "public"."innings" validate constraint "innings_bowling_team_id_fkey";

alter table "public"."innings" add constraint "innings_match_id_fkey" FOREIGN KEY (match_id) REFERENCES public.matches(id) ON DELETE CASCADE not valid;

alter table "public"."innings" validate constraint "innings_match_id_fkey";

alter table "public"."innings" add constraint "innings_unique_match_inningsno" UNIQUE using index "innings_unique_match_inningsno";

alter table "public"."innings" add constraint "innings_unique_per_match_inningsno" UNIQUE using index "innings_unique_per_match_inningsno";

alter table "public"."match_scorer_sessions" add constraint "match_scorer_sessions_match_id_fkey" FOREIGN KEY (match_id) REFERENCES public.matches(id) ON DELETE CASCADE not valid;

alter table "public"."match_scorer_sessions" validate constraint "match_scorer_sessions_match_id_fkey";

alter table "public"."match_scorer_sessions" add constraint "match_scorer_sessions_override_of_fkey" FOREIGN KEY (override_of) REFERENCES public.match_scorer_sessions(id) ON DELETE SET NULL not valid;

alter table "public"."match_scorer_sessions" validate constraint "match_scorer_sessions_override_of_fkey";

alter table "public"."match_scorer_sessions" add constraint "match_scorer_sessions_status_check" CHECK ((status = ANY (ARRAY['active'::text, 'released'::text, 'superseded'::text]))) not valid;

alter table "public"."match_scorer_sessions" validate constraint "match_scorer_sessions_status_check";

alter table "public"."match_session_events" add constraint "match_session_events_event_id_key" UNIQUE using index "match_session_events_event_id_key";

alter table "public"."match_session_events" add constraint "match_session_events_innings_id_fkey" FOREIGN KEY (innings_id) REFERENCES public.innings(id) ON DELETE CASCADE not valid;

alter table "public"."match_session_events" validate constraint "match_session_events_innings_id_fkey";

alter table "public"."match_session_events" add constraint "match_session_events_match_id_fkey" FOREIGN KEY (match_id) REFERENCES public.matches(id) ON DELETE CASCADE not valid;

alter table "public"."match_session_events" validate constraint "match_session_events_match_id_fkey";

alter table "public"."match_squads" add constraint "match_squads_fixture_id_team_id_player_id_key" UNIQUE using index "match_squads_fixture_id_team_id_player_id_key";

alter table "public"."matches" add constraint "matches_team_a_id_fkey" FOREIGN KEY (team_a_id) REFERENCES public.teams(id) not valid;

alter table "public"."matches" validate constraint "matches_team_a_id_fkey";

alter table "public"."matches" add constraint "matches_team_b_id_fkey" FOREIGN KEY (team_b_id) REFERENCES public.teams(id) not valid;

alter table "public"."matches" validate constraint "matches_team_b_id_fkey";

alter table "public"."players" add constraint "players_team_id_fkey" FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE CASCADE not valid;

alter table "public"."players" validate constraint "players_team_id_fkey";

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.acquire_match_scorer_lock(p_match_id uuid, p_client_session_id text, p_override boolean DEFAULT false, p_device_label text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_active public.match_scorer_sessions%rowtype;
  v_new public.match_scorer_sessions%rowtype;
begin
  if p_match_id is null then
    raise exception 'match_id is required';
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
$function$
;

CREATE OR REPLACE FUNCTION public.apply_match_session_event(p_event_id text, p_match_id uuid, p_innings_id uuid, p_client_session_id text DEFAULT NULL::text, p_event_type text DEFAULT 'add_ball'::text, p_payload jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_event public.match_session_events%rowtype;
  v_ball public.balls%rowtype;
  v_innings public.innings%rowtype;
  v_patch jsonb;
  v_target_ball_id uuid;
  v_target_source_event_id text;
  v_error_message text;
  v_active_lock record;
begin
  if coalesce(trim(p_event_id), '') = '' then
    raise exception 'event_id is required';
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
    on conflict (source_event_id) where source_event_id is not null do nothing
    returning * into v_ball;

    if v_ball.id is null then
      select * into v_ball
      from public.balls
      where source_event_id = p_event_id
      limit 1;
    end if;

    update public.match_session_events
    set status = 'applied',
        applied_at = clock_timestamp(),
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
      returning * into v_ball;
    end if;

    if v_ball.id is null then
      raise exception 'Target ball not found for edit event %', p_event_id;
    end if;

    update public.match_session_events
    set status = 'applied',
        applied_at = clock_timestamp(),
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
    returning * into v_innings;

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
    returning * into v_innings;

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
$function$
;

CREATE OR REPLACE FUNCTION public.ensure_fixture_squad(fix_id uuid, t_id uuid)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
begin
  if fix_id is null or t_id is null then
    return;
  end if;

  insert into public.match_squads (fixture_id, team_id, player_id, is_playing)
  select
    fix_id,
    p.team_id,
    p.id,
    true
  from public.players p
  where p.team_id = t_id
    and coalesce(p.active, true) = true
  on conflict (fixture_id, team_id, player_id)
  do nothing;
end;
$function$
;

create or replace view "public"."fixture_wicket_caps" as  SELECT fixture_id,
    (max(squad_count) - 1) AS wicket_cap
   FROM ( SELECT match_squads.fixture_id,
            match_squads.team_id,
            count(*) FILTER (WHERE (match_squads.is_playing = true)) AS squad_count
           FROM public.match_squads
          GROUP BY match_squads.fixture_id, match_squads.team_id) x
  GROUP BY fixture_id;


CREATE OR REPLACE FUNCTION public.heartbeat_match_scorer_lock(p_match_id uuid, p_client_session_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_active public.match_scorer_sessions%rowtype;
begin
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
$function$
;

create or replace view "public"."players_with_usage" as  SELECT id,
    team_id,
    name,
    active,
    (EXISTS ( SELECT 1
           FROM public.balls b
          WHERE ((b.striker_id = p.id) OR (b.non_striker_id = p.id) OR (b.bowler_id = p.id) OR (b.dismissed_player_id = p.id) OR (b.fielder_player_id = p.id)))) AS has_usage
   FROM public.players p;


CREATE OR REPLACE FUNCTION public.recalc_fixture_wicket_cap(fix_id uuid)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
declare
  cap integer;
begin
  select (max(squad_count) - 1)
  into cap
  from (
    select team_id, count(*) filter (where is_playing = true) as squad_count
    from public.match_squads
    where fixture_id = fix_id
    group by team_id
  ) s;

  -- If squads not set yet, do nothing
  if cap is null then
    return;
  end if;

  update public.matches
  set wicket_cap = cap
  where fixture_id = fix_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.release_match_scorer_lock(p_match_id uuid, p_client_session_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_active public.match_scorer_sessions%rowtype;
begin
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
$function$
;

CREATE OR REPLACE FUNCTION public.set_match_playing_on_first_ball()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  update public.matches
  set status = 'playing'
  where id = new.match_id
    and status = 'scheduled';
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.trg_match_squads_recalc_cap()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  perform public.recalc_fixture_wicket_cap(coalesce(new.fixture_id, old.fixture_id));
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.trg_matches_ensure_squads()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  perform public.ensure_fixture_squad(new.fixture_id, new.team_a_id);
  perform public.ensure_fixture_squad(new.fixture_id, new.team_b_id);
  return new;
end;
$function$
;

grant delete on table "public"."balls" to "anon";

grant insert on table "public"."balls" to "anon";

grant references on table "public"."balls" to "anon";

grant select on table "public"."balls" to "anon";

grant trigger on table "public"."balls" to "anon";

grant truncate on table "public"."balls" to "anon";

grant update on table "public"."balls" to "anon";

grant delete on table "public"."balls" to "authenticated";

grant insert on table "public"."balls" to "authenticated";

grant references on table "public"."balls" to "authenticated";

grant select on table "public"."balls" to "authenticated";

grant trigger on table "public"."balls" to "authenticated";

grant truncate on table "public"."balls" to "authenticated";

grant update on table "public"."balls" to "authenticated";

grant delete on table "public"."balls" to "service_role";

grant insert on table "public"."balls" to "service_role";

grant references on table "public"."balls" to "service_role";

grant select on table "public"."balls" to "service_role";

grant trigger on table "public"."balls" to "service_role";

grant truncate on table "public"."balls" to "service_role";

grant update on table "public"."balls" to "service_role";

grant delete on table "public"."innings" to "anon";

grant insert on table "public"."innings" to "anon";

grant references on table "public"."innings" to "anon";

grant select on table "public"."innings" to "anon";

grant trigger on table "public"."innings" to "anon";

grant truncate on table "public"."innings" to "anon";

grant update on table "public"."innings" to "anon";

grant delete on table "public"."innings" to "authenticated";

grant insert on table "public"."innings" to "authenticated";

grant references on table "public"."innings" to "authenticated";

grant select on table "public"."innings" to "authenticated";

grant trigger on table "public"."innings" to "authenticated";

grant truncate on table "public"."innings" to "authenticated";

grant update on table "public"."innings" to "authenticated";

grant delete on table "public"."innings" to "service_role";

grant insert on table "public"."innings" to "service_role";

grant references on table "public"."innings" to "service_role";

grant select on table "public"."innings" to "service_role";

grant trigger on table "public"."innings" to "service_role";

grant truncate on table "public"."innings" to "service_role";

grant update on table "public"."innings" to "service_role";

grant delete on table "public"."match_scorer_sessions" to "anon";

grant insert on table "public"."match_scorer_sessions" to "anon";

grant references on table "public"."match_scorer_sessions" to "anon";

grant select on table "public"."match_scorer_sessions" to "anon";

grant trigger on table "public"."match_scorer_sessions" to "anon";

grant truncate on table "public"."match_scorer_sessions" to "anon";

grant update on table "public"."match_scorer_sessions" to "anon";

grant delete on table "public"."match_scorer_sessions" to "authenticated";

grant insert on table "public"."match_scorer_sessions" to "authenticated";

grant references on table "public"."match_scorer_sessions" to "authenticated";

grant select on table "public"."match_scorer_sessions" to "authenticated";

grant trigger on table "public"."match_scorer_sessions" to "authenticated";

grant truncate on table "public"."match_scorer_sessions" to "authenticated";

grant update on table "public"."match_scorer_sessions" to "authenticated";

grant delete on table "public"."match_scorer_sessions" to "service_role";

grant insert on table "public"."match_scorer_sessions" to "service_role";

grant references on table "public"."match_scorer_sessions" to "service_role";

grant select on table "public"."match_scorer_sessions" to "service_role";

grant trigger on table "public"."match_scorer_sessions" to "service_role";

grant truncate on table "public"."match_scorer_sessions" to "service_role";

grant update on table "public"."match_scorer_sessions" to "service_role";

grant delete on table "public"."match_session_events" to "anon";

grant insert on table "public"."match_session_events" to "anon";

grant references on table "public"."match_session_events" to "anon";

grant select on table "public"."match_session_events" to "anon";

grant trigger on table "public"."match_session_events" to "anon";

grant truncate on table "public"."match_session_events" to "anon";

grant update on table "public"."match_session_events" to "anon";

grant delete on table "public"."match_session_events" to "authenticated";

grant insert on table "public"."match_session_events" to "authenticated";

grant references on table "public"."match_session_events" to "authenticated";

grant select on table "public"."match_session_events" to "authenticated";

grant trigger on table "public"."match_session_events" to "authenticated";

grant truncate on table "public"."match_session_events" to "authenticated";

grant update on table "public"."match_session_events" to "authenticated";

grant delete on table "public"."match_session_events" to "service_role";

grant insert on table "public"."match_session_events" to "service_role";

grant references on table "public"."match_session_events" to "service_role";

grant select on table "public"."match_session_events" to "service_role";

grant trigger on table "public"."match_session_events" to "service_role";

grant truncate on table "public"."match_session_events" to "service_role";

grant update on table "public"."match_session_events" to "service_role";

grant delete on table "public"."match_squads" to "anon";

grant insert on table "public"."match_squads" to "anon";

grant references on table "public"."match_squads" to "anon";

grant select on table "public"."match_squads" to "anon";

grant trigger on table "public"."match_squads" to "anon";

grant truncate on table "public"."match_squads" to "anon";

grant update on table "public"."match_squads" to "anon";

grant delete on table "public"."match_squads" to "authenticated";

grant insert on table "public"."match_squads" to "authenticated";

grant references on table "public"."match_squads" to "authenticated";

grant select on table "public"."match_squads" to "authenticated";

grant trigger on table "public"."match_squads" to "authenticated";

grant truncate on table "public"."match_squads" to "authenticated";

grant update on table "public"."match_squads" to "authenticated";

grant delete on table "public"."match_squads" to "service_role";

grant insert on table "public"."match_squads" to "service_role";

grant references on table "public"."match_squads" to "service_role";

grant select on table "public"."match_squads" to "service_role";

grant trigger on table "public"."match_squads" to "service_role";

grant truncate on table "public"."match_squads" to "service_role";

grant update on table "public"."match_squads" to "service_role";

grant delete on table "public"."matches" to "anon";

grant insert on table "public"."matches" to "anon";

grant references on table "public"."matches" to "anon";

grant select on table "public"."matches" to "anon";

grant trigger on table "public"."matches" to "anon";

grant truncate on table "public"."matches" to "anon";

grant update on table "public"."matches" to "anon";

grant delete on table "public"."matches" to "authenticated";

grant insert on table "public"."matches" to "authenticated";

grant references on table "public"."matches" to "authenticated";

grant select on table "public"."matches" to "authenticated";

grant trigger on table "public"."matches" to "authenticated";

grant truncate on table "public"."matches" to "authenticated";

grant update on table "public"."matches" to "authenticated";

grant delete on table "public"."matches" to "service_role";

grant insert on table "public"."matches" to "service_role";

grant references on table "public"."matches" to "service_role";

grant select on table "public"."matches" to "service_role";

grant trigger on table "public"."matches" to "service_role";

grant truncate on table "public"."matches" to "service_role";

grant update on table "public"."matches" to "service_role";

grant delete on table "public"."players" to "anon";

grant insert on table "public"."players" to "anon";

grant references on table "public"."players" to "anon";

grant select on table "public"."players" to "anon";

grant trigger on table "public"."players" to "anon";

grant truncate on table "public"."players" to "anon";

grant update on table "public"."players" to "anon";

grant delete on table "public"."players" to "authenticated";

grant insert on table "public"."players" to "authenticated";

grant references on table "public"."players" to "authenticated";

grant select on table "public"."players" to "authenticated";

grant trigger on table "public"."players" to "authenticated";

grant truncate on table "public"."players" to "authenticated";

grant update on table "public"."players" to "authenticated";

grant delete on table "public"."players" to "service_role";

grant insert on table "public"."players" to "service_role";

grant references on table "public"."players" to "service_role";

grant select on table "public"."players" to "service_role";

grant trigger on table "public"."players" to "service_role";

grant truncate on table "public"."players" to "service_role";

grant update on table "public"."players" to "service_role";

grant delete on table "public"."teams" to "anon";

grant insert on table "public"."teams" to "anon";

grant references on table "public"."teams" to "anon";

grant select on table "public"."teams" to "anon";

grant trigger on table "public"."teams" to "anon";

grant truncate on table "public"."teams" to "anon";

grant update on table "public"."teams" to "anon";

grant delete on table "public"."teams" to "authenticated";

grant insert on table "public"."teams" to "authenticated";

grant references on table "public"."teams" to "authenticated";

grant select on table "public"."teams" to "authenticated";

grant trigger on table "public"."teams" to "authenticated";

grant truncate on table "public"."teams" to "authenticated";

grant update on table "public"."teams" to "authenticated";

grant delete on table "public"."teams" to "service_role";

grant insert on table "public"."teams" to "service_role";

grant references on table "public"."teams" to "service_role";

grant select on table "public"."teams" to "service_role";

grant trigger on table "public"."teams" to "service_role";

grant truncate on table "public"."teams" to "service_role";

grant update on table "public"."teams" to "service_role";


  create policy "Public read access"
  on "public"."balls"
  as permissive
  for select
  to public
using (true);



  create policy "Scorer can delete balls for own match"
  on "public"."balls"
  as permissive
  for delete
  to public
using ((EXISTS ( SELECT 1
   FROM public.matches m
  WHERE ((m.id = balls.match_id) AND (m.scorer_user_id = auth.uid())))));



  create policy "Scorer can insert balls for own match"
  on "public"."balls"
  as permissive
  for insert
  to public
with check (((auth.uid() IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM public.matches m
  WHERE ((m.id = balls.match_id) AND (m.scorer_user_id = auth.uid()))))));



  create policy "balls_delete_auth"
  on "public"."balls"
  as permissive
  for delete
  to public
using ((auth.role() = 'authenticated'::text));



  create policy "balls_delete_scorer"
  on "public"."balls"
  as permissive
  for delete
  to authenticated
using ((EXISTS ( SELECT 1
   FROM public.matches m
  WHERE ((m.id = balls.match_id) AND (m.scorer_user_id = auth.uid())))));



  create policy "balls_insert_auth"
  on "public"."balls"
  as permissive
  for insert
  to public
with check ((auth.role() = 'authenticated'::text));



  create policy "balls_insert_scorer"
  on "public"."balls"
  as permissive
  for insert
  to authenticated
with check ((EXISTS ( SELECT 1
   FROM public.matches m
  WHERE ((m.id = balls.match_id) AND (m.scorer_user_id = auth.uid())))));



  create policy "balls_read_all"
  on "public"."balls"
  as permissive
  for select
  to public
using (true);



  create policy "balls_update_auth"
  on "public"."balls"
  as permissive
  for update
  to public
using ((auth.role() = 'authenticated'::text))
with check ((auth.role() = 'authenticated'::text));



  create policy "balls_update_scorer"
  on "public"."balls"
  as permissive
  for update
  to authenticated
using ((EXISTS ( SELECT 1
   FROM public.matches m
  WHERE ((m.id = balls.match_id) AND (m.scorer_user_id = auth.uid())))))
with check ((EXISTS ( SELECT 1
   FROM public.matches m
  WHERE ((m.id = balls.match_id) AND (m.scorer_user_id = auth.uid())))));



  create policy "Public read access"
  on "public"."innings"
  as permissive
  for select
  to public
using (true);



  create policy "Scorer can create innings for own match"
  on "public"."innings"
  as permissive
  for insert
  to public
with check (((auth.uid() IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM public.matches m
  WHERE ((m.id = innings.match_id) AND (m.scorer_user_id = auth.uid()))))));



  create policy "Scorer can update innings for own match"
  on "public"."innings"
  as permissive
  for update
  to public
using ((EXISTS ( SELECT 1
   FROM public.matches m
  WHERE ((m.id = innings.match_id) AND (m.scorer_user_id = auth.uid())))));



  create policy "innings_delete_auth"
  on "public"."innings"
  as permissive
  for delete
  to public
using ((auth.role() = 'authenticated'::text));



  create policy "innings_delete_scorer"
  on "public"."innings"
  as permissive
  for delete
  to authenticated
using ((EXISTS ( SELECT 1
   FROM public.matches m
  WHERE ((m.id = innings.match_id) AND (m.scorer_user_id = auth.uid())))));



  create policy "innings_insert_auth"
  on "public"."innings"
  as permissive
  for insert
  to public
with check ((auth.role() = 'authenticated'::text));



  create policy "innings_insert_scorer"
  on "public"."innings"
  as permissive
  for insert
  to authenticated
with check ((EXISTS ( SELECT 1
   FROM public.matches m
  WHERE ((m.id = innings.match_id) AND (m.scorer_user_id = auth.uid())))));



  create policy "innings_read_all"
  on "public"."innings"
  as permissive
  for select
  to public
using (true);



  create policy "innings_read_public"
  on "public"."innings"
  as permissive
  for select
  to public
using (true);



  create policy "innings_update_auth"
  on "public"."innings"
  as permissive
  for update
  to public
using ((auth.role() = 'authenticated'::text))
with check ((auth.role() = 'authenticated'::text));



  create policy "innings_update_scorer"
  on "public"."innings"
  as permissive
  for update
  to authenticated
using ((EXISTS ( SELECT 1
   FROM public.matches m
  WHERE ((m.id = innings.match_id) AND (m.scorer_user_id = auth.uid())))))
with check ((EXISTS ( SELECT 1
   FROM public.matches m
  WHERE ((m.id = innings.match_id) AND (m.scorer_user_id = auth.uid())))));



  create policy "match_squads_delete_scorer"
  on "public"."match_squads"
  as permissive
  for delete
  to authenticated
using ((EXISTS ( SELECT 1
   FROM public.matches m
  WHERE ((m.fixture_id = match_squads.fixture_id) AND (m.scorer_user_id = auth.uid())))));



  create policy "match_squads_insert_scorer"
  on "public"."match_squads"
  as permissive
  for insert
  to authenticated
with check ((EXISTS ( SELECT 1
   FROM public.matches m
  WHERE ((m.fixture_id = match_squads.fixture_id) AND (m.scorer_user_id = auth.uid())))));



  create policy "match_squads_read_all"
  on "public"."match_squads"
  as permissive
  for select
  to public
using (true);



  create policy "match_squads_update_scorer"
  on "public"."match_squads"
  as permissive
  for update
  to authenticated
using ((EXISTS ( SELECT 1
   FROM public.matches m
  WHERE ((m.fixture_id = match_squads.fixture_id) AND (m.scorer_user_id = auth.uid())))))
with check ((EXISTS ( SELECT 1
   FROM public.matches m
  WHERE ((m.fixture_id = match_squads.fixture_id) AND (m.scorer_user_id = auth.uid())))));



  create policy "match_squads_write_scorer"
  on "public"."match_squads"
  as permissive
  for insert
  to authenticated
with check ((EXISTS ( SELECT 1
   FROM public.matches m
  WHERE ((m.fixture_id = match_squads.fixture_id) AND (m.scorer_user_id = auth.uid())))));



  create policy "Authenticated users can create matches"
  on "public"."matches"
  as permissive
  for insert
  to public
with check (((auth.uid() IS NOT NULL) AND (scorer_user_id = auth.uid())));



  create policy "Public read access"
  on "public"."matches"
  as permissive
  for select
  to public
using (true);



  create policy "Scorer can update own matches"
  on "public"."matches"
  as permissive
  for update
  to public
using ((scorer_user_id = auth.uid()));



  create policy "matches_delete_scorer"
  on "public"."matches"
  as permissive
  for delete
  to authenticated
using ((scorer_user_id = auth.uid()));



  create policy "matches_insert_scorer"
  on "public"."matches"
  as permissive
  for insert
  to authenticated
with check ((scorer_user_id = auth.uid()));



  create policy "matches_read_all"
  on "public"."matches"
  as permissive
  for select
  to public
using (true);



  create policy "matches_read_public"
  on "public"."matches"
  as permissive
  for select
  to public
using (true);



  create policy "matches_update_scorer"
  on "public"."matches"
  as permissive
  for update
  to authenticated
using ((scorer_user_id = auth.uid()))
with check ((scorer_user_id = auth.uid()));



  create policy "Authenticated can delete players"
  on "public"."players"
  as permissive
  for delete
  to public
using ((auth.uid() IS NOT NULL));



  create policy "Authenticated can insert players"
  on "public"."players"
  as permissive
  for insert
  to public
with check ((auth.uid() IS NOT NULL));



  create policy "Authenticated can update players"
  on "public"."players"
  as permissive
  for update
  to public
using ((auth.uid() IS NOT NULL));



  create policy "Players are readable by everyone"
  on "public"."players"
  as permissive
  for select
  to public
using (true);



  create policy "Public read access"
  on "public"."players"
  as permissive
  for select
  to public
using (true);



  create policy "players_delete_anon"
  on "public"."players"
  as permissive
  for delete
  to anon
using (true);



  create policy "players_insert_anon"
  on "public"."players"
  as permissive
  for insert
  to anon
with check (true);



  create policy "players_select_anon"
  on "public"."players"
  as permissive
  for select
  to anon
using (true);



  create policy "players_select_authenticated"
  on "public"."players"
  as permissive
  for select
  to authenticated
using (true);



  create policy "players_update_anon"
  on "public"."players"
  as permissive
  for update
  to anon
using (true)
with check (true);



  create policy "Public read access"
  on "public"."teams"
  as permissive
  for select
  to public
using (true);


CREATE TRIGGER trg_set_match_playing_on_first_ball AFTER INSERT ON public.balls FOR EACH ROW EXECUTE FUNCTION public.set_match_playing_on_first_ball();

CREATE TRIGGER match_squads_recalc_cap AFTER INSERT OR DELETE OR UPDATE ON public.match_squads FOR EACH ROW EXECUTE FUNCTION public.trg_match_squads_recalc_cap();

CREATE TRIGGER matches_ensure_squads_ins AFTER INSERT ON public.matches FOR EACH ROW EXECUTE FUNCTION public.trg_matches_ensure_squads();

CREATE TRIGGER matches_ensure_squads_upd AFTER UPDATE OF fixture_id, team_a_id, team_b_id ON public.matches FOR EACH ROW EXECUTE FUNCTION public.trg_matches_ensure_squads();
