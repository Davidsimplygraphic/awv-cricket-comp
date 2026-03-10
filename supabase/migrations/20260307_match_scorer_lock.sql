create table if not exists public.match_scorer_sessions (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null references public.matches(id) on delete cascade,
  client_session_id text not null,
  device_label text,
  status text not null default 'active',
  override_of uuid references public.match_scorer_sessions(id) on delete set null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  released_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  constraint match_scorer_sessions_status_check check (status in ('active', 'released', 'superseded'))
);

create index if not exists match_scorer_sessions_match_id_idx
  on public.match_scorer_sessions (match_id, created_at desc);

create index if not exists match_scorer_sessions_client_session_idx
  on public.match_scorer_sessions (client_session_id, created_at desc);

create unique index if not exists match_scorer_sessions_one_active_per_match_idx
  on public.match_scorer_sessions (match_id)
  where status = 'active';

create or replace function public.acquire_match_scorer_lock(
  p_match_id uuid,
  p_client_session_id text,
  p_override boolean default false,
  p_device_label text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
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
$$;

create or replace function public.heartbeat_match_scorer_lock(
  p_match_id uuid,
  p_client_session_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
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
$$;

create or replace function public.release_match_scorer_lock(
  p_match_id uuid,
  p_client_session_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
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
$$;

grant execute on function public.acquire_match_scorer_lock(uuid, text, boolean, text) to anon, authenticated, service_role;
grant execute on function public.heartbeat_match_scorer_lock(uuid, text) to anon, authenticated, service_role;
grant execute on function public.release_match_scorer_lock(uuid, text) to anon, authenticated, service_role;
