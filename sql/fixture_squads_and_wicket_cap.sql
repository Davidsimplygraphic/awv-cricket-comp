-- AWV Cricket Comp
-- Fixture-level squads + automatic wicket cap (max squad size - 1)

-- 1) Teams: who can manage squads for a team
alter table public.teams
add column if not exists captain_user_id uuid;

-- 2) Matches: fixture grouping and persisted wicket cap
alter table public.matches
add column if not exists fixture_id uuid;

alter table public.matches
add column if not exists wicket_cap integer;

-- 3) Match squads (fixture-scoped)
create table if not exists public.match_squads (
  id uuid primary key default gen_random_uuid(),
  fixture_id uuid not null,
  team_id uuid not null,
  player_id uuid not null,
  is_playing boolean not null default true,
  created_at timestamptz not null default now(),
  unique (fixture_id, team_id, player_id)
);

create index if not exists idx_match_squads_fixture_team on public.match_squads (fixture_id, team_id);
create index if not exists idx_match_squads_fixture on public.match_squads (fixture_id);

-- 4) Helper: ensure squads exist for a given fixture+team
create or replace function public.ensure_fixture_squad(fix_id uuid, t_id uuid)
returns void
language plpgsql
as $$
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
$$;

-- 5) Helper: recompute and persist wicket cap for a fixture
create or replace function public.recompute_fixture_wicket_cap(fix_id uuid)
returns void
language plpgsql
as $$
declare
  cap integer;
begin
  if fix_id is null then
    return;
  end if;

  select (max(cnt) - 1)
  into cap
  from (
    select team_id, count(*) filter (where is_playing = true) as cnt
    from public.match_squads
    where fixture_id = fix_id
    group by team_id
  ) x;

  -- If squads are missing / empty, don't overwrite with null
  if cap is null then
    return;
  end if;

  update public.matches
  set wicket_cap = cap
  where fixture_id = fix_id;
end;
$$;

-- 6) Trigger: when a match is inserted/updated, ensure squads exist (fixture-level)
create or replace function public.trg_matches_ensure_squads()
returns trigger
language plpgsql
as $$
begin
  perform public.ensure_fixture_squad(new.fixture_id, new.team_a_id);
  perform public.ensure_fixture_squad(new.fixture_id, new.team_b_id);
  perform public.recompute_fixture_wicket_cap(new.fixture_id);
  return new;
end;
$$;

drop trigger if exists matches_ensure_squads_ins on public.matches;
create trigger matches_ensure_squads_ins
after insert on public.matches
for each row
execute function public.trg_matches_ensure_squads();

drop trigger if exists matches_ensure_squads_upd on public.matches;
create trigger matches_ensure_squads_upd
after update of fixture_id, team_a_id, team_b_id on public.matches
for each row
execute function public.trg_matches_ensure_squads();

-- 7) Trigger: when squads change, recompute wicket cap
create or replace function public.trg_match_squads_recompute_cap()
returns trigger
language plpgsql
as $$
declare
  fix_id uuid;
begin
  fix_id := coalesce(new.fixture_id, old.fixture_id);
  perform public.recompute_fixture_wicket_cap(fix_id);
  return coalesce(new, old);
end;
$$;

drop trigger if exists match_squads_recompute_cap_ins on public.match_squads;
create trigger match_squads_recompute_cap_ins
after insert on public.match_squads
for each row
execute function public.trg_match_squads_recompute_cap();

drop trigger if exists match_squads_recompute_cap_upd on public.match_squads;
create trigger match_squads_recompute_cap_upd
after update of is_playing on public.match_squads
for each row
execute function public.trg_match_squads_recompute_cap();

drop trigger if exists match_squads_recompute_cap_del on public.match_squads;
create trigger match_squads_recompute_cap_del
after delete on public.match_squads
for each row
execute function public.trg_match_squads_recompute_cap();

-- 8) One-time backfill: create squads + compute wicket cap for existing fixtures
insert into public.match_squads (fixture_id, team_id, player_id, is_playing)
select distinct
  m.fixture_id,
  p.team_id,
  p.id,
  true
from public.matches m
join public.players p on p.team_id in (m.team_a_id, m.team_b_id)
where m.fixture_id is not null
  and coalesce(p.active, true) = true
on conflict (fixture_id, team_id, player_id) do nothing;

-- Persist wicket caps for all fixtures
do $$
declare
  r record;
begin
  for r in (select distinct fixture_id from public.matches where fixture_id is not null) loop
    perform public.recompute_fixture_wicket_cap(r.fixture_id);
  end loop;
end;
$$;
