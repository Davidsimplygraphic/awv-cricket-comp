BEGIN;
SELECT plan(10);

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
    'add_ball',
    jsonb_build_object(
      'ball',
      jsonb_build_object(
        'over_no', 0,
        'delivery_in_over', 1,
        'legal_ball', true,
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
  'first add_ball event applies canonically'
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
    'add_ball',
    jsonb_build_object(
      'ball',
      jsonb_build_object(
        'over_no', 0,
        'delivery_in_over', 1,
        'legal_ball', true,
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
  'true',
  'replaying the same event id is idempotent'
);

SELECT is(
  public.apply_match_session_event(
    'evt-add-1',
    '00000000-0000-0000-0000-000000000401',
    '00000000-0000-0000-0000-000000000501',
    'session-main',
    'add_ball',
    '{}'::jsonb
  ) -> 'ball' ->> 'id',
  (SELECT id::text FROM public.balls WHERE source_event_id = 'evt-add-1'),
  'duplicate replay returns the stored canonical ball payload'
);

SELECT is(
  public.get_innings_recovery_state(
    '00000000-0000-0000-0000-000000000401',
    '00000000-0000-0000-0000-000000000501'
  ) -> 'recovery_state' ->> 'striker_id',
  '00000000-0000-0000-0000-000000000302',
  'recovery state returns the latest persisted post_state'
);

SELECT is(
  public.apply_match_session_event(
    'evt-edit-1',
    '00000000-0000-0000-0000-000000000401',
    '00000000-0000-0000-0000-000000000501',
    'session-main',
    'edit_ball',
    jsonb_build_object(
      'target_source_event_id', 'evt-add-1',
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
      'add_ball',
      jsonb_build_object(
        'ball',
        jsonb_build_object(
          'over_no', 0,
          'delivery_in_over', 1,
          'legal_ball', true,
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
  'completed innings reject further deliveries at the database boundary'
);

SELECT * FROM finish();
ROLLBACK;
