BEGIN;
SELECT plan(16);

SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000111', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);

INSERT INTO public.teams (id, name, short_name)
VALUES
  ('00000000-0000-0000-0000-000000000201', 'Alpha', 'ALP'),
  ('00000000-0000-0000-0000-000000000202', 'Beta', 'BET');

INSERT INTO public.players (id, team_id, name, active)
VALUES
  ('00000000-0000-0000-0000-000000000301', '00000000-0000-0000-0000-000000000201', 'Alpha Batter 1', true),
  ('00000000-0000-0000-0000-000000000302', '00000000-0000-0000-0000-000000000201', 'Alpha Batter 2', true),
  ('00000000-0000-0000-0000-000000000304', '00000000-0000-0000-0000-000000000201', 'Alpha Batter 3', true),
  ('00000000-0000-0000-0000-000000000305', '00000000-0000-0000-0000-000000000201', 'Alpha Batter 4', true),
  ('00000000-0000-0000-0000-000000000303', '00000000-0000-0000-0000-000000000202', 'Beta Bowler 1', true);

INSERT INTO public.matches (
  id,
  fixture_id,
  team_a_id,
  team_b_id,
  overs_limit,
  wicket_cap,
  status,
  scorer_user_id
)
VALUES (
  '00000000-0000-0000-0000-000000000401',
  '00000000-0000-0000-0000-000000000402',
  '00000000-0000-0000-0000-000000000201',
  '00000000-0000-0000-0000-000000000202',
  2,
  10,
  'scheduled',
  '00000000-0000-0000-0000-000000000111'
);

INSERT INTO public.innings (
  id,
  match_id,
  innings_no,
  batting_team_id,
  bowling_team_id,
  completed
)
VALUES
  (
    '00000000-0000-0000-0000-000000000501',
    '00000000-0000-0000-0000-000000000401',
    1,
    '00000000-0000-0000-0000-000000000201',
    '00000000-0000-0000-0000-000000000202',
    false
  ),
  (
    '00000000-0000-0000-0000-000000000502',
    '00000000-0000-0000-0000-000000000401',
    2,
    '00000000-0000-0000-0000-000000000202',
    '00000000-0000-0000-0000-000000000201',
    false
  );

SELECT is(
  auth.uid()::text,
  '00000000-0000-0000-0000-000000000111',
  'db tests run with a seeded authenticated scorer id'
);

SELECT is(
  public.apply_match_session_event(
    'evt-add-1',
    '00000000-0000-0000-0000-000000000401',
    '00000000-0000-0000-0000-000000000501',
    'session-main',
    'delivery_recorded',
    jsonb_build_object(
      'delivery',
      jsonb_build_object(
        'over_no', 0,
        'delivery_in_over', 1,
        'runs_off_bat', 1,
        'extra_type', null,
        'extra_runs', 0,
        'wicket', false,
        'striker_id', '00000000-0000-0000-0000-000000000301',
        'non_striker_id', '00000000-0000-0000-0000-000000000302',
        'bowler_id', '00000000-0000-0000-0000-000000000303',
        'batting_turn', 1
      ),
      'post_state',
      jsonb_build_object(
        'striker_id', '00000000-0000-0000-0000-000000000302',
        'non_striker_id', '00000000-0000-0000-0000-000000000301',
        'striker_turn', 1,
        'non_striker_turn', 1,
        'bowler_id', '00000000-0000-0000-0000-000000000303',
        'needs_next_bowler', false
      )
    )
  ) ->> 'duplicate',
  'false',
  'first delivery_recorded event applies canonically'
);

SELECT is(
  (SELECT count(*)::integer FROM public.balls WHERE source_event_id = 'evt-add-1'),
  1,
  'only one ball row exists for the source event'
);

SELECT is(
  public.apply_match_session_event(
    'evt-add-1',
    '00000000-0000-0000-0000-000000000401',
    '00000000-0000-0000-0000-000000000501',
    'session-main',
    'delivery_recorded',
    '{}'::jsonb
  ) ->> 'duplicate',
  'true',
  'replaying the same delivery event id is idempotent'
);

SELECT is(
  public.apply_match_session_event(
    'evt-add-1',
    '00000000-0000-0000-0000-000000000401',
    '00000000-0000-0000-0000-000000000501',
    'session-main',
    'delivery_recorded',
    '{}'::jsonb
  ) -> 'ball' ->> 'id',
  (SELECT id::text FROM public.balls WHERE source_event_id = 'evt-add-1'),
  'duplicate replay returns the stored canonical ball payload'
);

SELECT is(
  public.apply_match_session_event(
    'evt-runout-1',
    '00000000-0000-0000-0000-000000000401',
    '00000000-0000-0000-0000-000000000501',
    'session-main',
    'delivery_recorded',
    jsonb_build_object(
      'delivery',
      jsonb_build_object(
        'over_no', 0,
        'delivery_in_over', 2,
        'runs_off_bat', 1,
        'extra_type', 'noball',
        'extra_runs', 1,
        'wicket', true,
        'dismissal_kind', 'run out',
        'dismissed_player_id', '00000000-0000-0000-0000-000000000302',
        'striker_id', '00000000-0000-0000-0000-000000000302',
        'non_striker_id', '00000000-0000-0000-0000-000000000301',
        'bowler_id', '00000000-0000-0000-0000-000000000303',
        'batting_turn', 1
      ),
      'post_state',
      jsonb_build_object(
        'striker_id', '00000000-0000-0000-0000-000000000304',
        'non_striker_id', '00000000-0000-0000-0000-000000000301',
        'striker_turn', 1,
        'non_striker_turn', 1,
        'bowler_id', '00000000-0000-0000-0000-000000000303',
        'needs_next_bowler', false
      )
    )
  ) -> 'ball' ->> 'dismissal_kind',
  'run out',
  'run-out delivery with completed runs and extras is accepted'
);

SELECT is(
  public.get_innings_recovery_state(
    '00000000-0000-0000-0000-000000000401',
    '00000000-0000-0000-0000-000000000501'
  ) -> 'recovery_state' ->> 'striker_id',
  '00000000-0000-0000-0000-000000000304',
  'recovery state advances to the replacement batter after the run-out delivery'
);

SELECT is(
  public.apply_match_session_event(
    'evt-retired-hurt-1',
    '00000000-0000-0000-0000-000000000401',
    '00000000-0000-0000-0000-000000000501',
    'session-main',
    'administrative_state_changed',
    jsonb_build_object(
      'action_type', 'retired_hurt',
      'dismissed_player_id', '00000000-0000-0000-0000-000000000301',
      'replacement_player_id', '00000000-0000-0000-0000-000000000305',
      'post_state', jsonb_build_object(
        'striker_id', '00000000-0000-0000-0000-000000000304',
        'non_striker_id', '00000000-0000-0000-0000-000000000305',
        'striker_turn', 1,
        'non_striker_turn', 1,
        'bowler_id', '00000000-0000-0000-0000-000000000303',
        'needs_next_bowler', false
      )
    )
  ) ->> 'event_type',
  'administrative_state_changed',
  'retired hurt is stored as an administrative state change'
);

SELECT is(
  (SELECT count(*)::integer FROM public.balls WHERE innings_id = '00000000-0000-0000-0000-000000000501'),
  2,
  'administrative state changes do not create projected ball rows'
);

SELECT is(
  public.get_innings_recovery_state(
    '00000000-0000-0000-0000-000000000401',
    '00000000-0000-0000-0000-000000000501'
  ) -> 'recovery_state' ->> 'non_striker_id',
  '00000000-0000-0000-0000-000000000305',
  'recovery state follows the administrative retired-hurt replacement'
);

SELECT throws_ok(
  $$
    SELECT public.apply_match_session_event(
      'evt-bad-retired-ball',
      '00000000-0000-0000-0000-000000000401',
      '00000000-0000-0000-0000-000000000501',
      'session-main',
      'delivery_recorded',
      jsonb_build_object(
        'delivery',
        jsonb_build_object(
          'over_no', 0,
          'delivery_in_over', 3,
          'runs_off_bat', 0,
          'extra_type', null,
          'extra_runs', 0,
          'wicket', true,
          'dismissal_kind', 'retired hurt',
          'dismissed_player_id', '00000000-0000-0000-0000-000000000304',
          'striker_id', '00000000-0000-0000-0000-000000000304',
          'non_striker_id', '00000000-0000-0000-0000-000000000305',
          'bowler_id', '00000000-0000-0000-0000-000000000303',
          'batting_turn', 1
        )
      )
    );
  $$,
  'Use administrative_state_changed for retired hurt events',
  'retired hurt cannot be smuggled through the delivery event type'
);

SELECT throws_ok(
  $$
    SELECT public.apply_match_session_event(
      'evt-bad-bowled-bye',
      '00000000-0000-0000-0000-000000000401',
      '00000000-0000-0000-0000-000000000501',
      'session-main',
      'delivery_recorded',
      jsonb_build_object(
        'delivery',
        jsonb_build_object(
          'over_no', 0,
          'delivery_in_over', 3,
          'runs_off_bat', 0,
          'extra_type', 'bye',
          'extra_runs', 1,
          'wicket', true,
          'dismissal_kind', 'bowled',
          'dismissed_player_id', '00000000-0000-0000-0000-000000000304',
          'striker_id', '00000000-0000-0000-0000-000000000304',
          'non_striker_id', '00000000-0000-0000-0000-000000000305',
          'bowler_id', '00000000-0000-0000-0000-000000000303',
          'batting_turn', 1
        )
      )
    );
  $$,
  'Only run out deliveries can record wicket-plus-extras',
  'unsupported wicket-plus-extra combinations fail closed in SQL'
);

SELECT is(
  public.apply_match_session_event(
    'evt-edit-1',
    '00000000-0000-0000-0000-000000000401',
    '00000000-0000-0000-0000-000000000501',
    'session-main',
    'edit_ball',
    jsonb_build_object(
      'target_source_event_id', 'evt-runout-1',
      'patch', jsonb_build_object('runs_off_bat', 4)
    )
  ) ->> 'invalidate_post_state',
  'true',
  'editing the latest delivery invalidates scorer post_state'
);

SELECT is(
  public.get_innings_recovery_state(
    '00000000-0000-0000-0000-000000000401',
    '00000000-0000-0000-0000-000000000501'
  ) ->> 'state_invalidated',
  'true',
  'recovery state reports invalidation after a latest-ball edit'
);

SELECT is(
  public.apply_match_session_event(
    'evt-end-2',
    '00000000-0000-0000-0000-000000000401',
    '00000000-0000-0000-0000-000000000502',
    'session-main',
    'end_innings',
    '{}'::jsonb
  ) ->> 'event_type',
  'end_innings',
  'innings can be explicitly completed through the hardened RPC'
);

SELECT throws_ok(
  $$
    SELECT public.apply_match_session_event(
      'evt-after-end',
      '00000000-0000-0000-0000-000000000401',
      '00000000-0000-0000-0000-000000000502',
      'session-main',
      'delivery_recorded',
      jsonb_build_object(
        'delivery',
        jsonb_build_object(
          'over_no', 0,
          'delivery_in_over', 1,
          'runs_off_bat', 0,
          'extra_type', null,
          'extra_runs', 0,
          'wicket', false,
          'striker_id', '00000000-0000-0000-0000-000000000301',
          'non_striker_id', '00000000-0000-0000-0000-000000000302',
          'bowler_id', '00000000-0000-0000-0000-000000000303',
          'batting_turn', 1
        )
      )
    );
  $$,
  'Cannot add a ball to a completed innings',
  'completed innings reject further delivery_recorded events at the database boundary'
);

SELECT * FROM finish();
ROLLBACK;
