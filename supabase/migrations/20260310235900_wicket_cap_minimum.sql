create or replace view "public"."fixture_wicket_caps" as
  select
    fixture_id,
    greatest(1, max(squad_count) - 1) as wicket_cap
  from (
    select
      match_squads.fixture_id,
      match_squads.team_id,
      count(*) filter (where match_squads.is_playing = true) as squad_count
    from public.match_squads
    group by match_squads.fixture_id, match_squads.team_id
  ) x
  group by fixture_id;

create or replace function public.recalc_fixture_wicket_cap(fix_id uuid)
returns void
language plpgsql
as $function$
declare
  cap integer;
begin
  select greatest(1, max(squad_count) - 1)
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
$function$;

update public.matches
set wicket_cap = greatest(1, wicket_cap)
where wicket_cap is not null
  and wicket_cap < 1;

alter table public.matches
  drop constraint if exists matches_wicket_cap_positive_check;

alter table public.matches
  add constraint matches_wicket_cap_positive_check
  check (wicket_cap is null or wicket_cap >= 1);
