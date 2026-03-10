create or replace function public.claim_match_scorer_ownership(
  p_match_id uuid,
  p_force boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = 'public'
as $function$
declare
  v_match public.matches%rowtype;
  v_previous_scorer_user_id uuid;
begin
  if auth.uid() is null then
    raise exception 'authenticated scorer session required';
  end if;

  select *
    into v_match
  from public.matches
  where id = p_match_id
  for update;

  if v_match.id is null then
    raise exception 'match_id is required';
  end if;

  v_previous_scorer_user_id := v_match.scorer_user_id;

  if v_previous_scorer_user_id is null then
    update public.matches
    set scorer_user_id = auth.uid()
    where id = p_match_id
    returning * into v_match;

    return jsonb_build_object(
      'ok', true,
      'action', 'assigned_self',
      'previous_scorer_user_id', null,
      'match', to_jsonb(v_match)
    );
  end if;

  if v_previous_scorer_user_id = auth.uid() then
    return jsonb_build_object(
      'ok', true,
      'action', 'already_assigned',
      'previous_scorer_user_id', v_previous_scorer_user_id,
      'match', to_jsonb(v_match)
    );
  end if;

  if not coalesce(p_force, false) then
    raise exception 'This match is assigned to another scorer. Use explicit take-over to claim it.';
  end if;

  update public.matches
  set scorer_user_id = auth.uid()
  where id = p_match_id
  returning * into v_match;

  return jsonb_build_object(
    'ok', true,
    'action', 'took_over',
    'previous_scorer_user_id', v_previous_scorer_user_id,
    'match', to_jsonb(v_match)
  );
end;
$function$;

revoke execute on function public.claim_match_scorer_ownership(uuid, boolean) from public;
grant execute on function public.claim_match_scorer_ownership(uuid, boolean) to authenticated;
