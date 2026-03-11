import { materializeAdministrativeStateBalls } from "../../src/lib/scoring.js";

function makeBall({
  id,
  matchId,
  inningsId,
  overNo,
  deliveryInOver,
  strikerId,
  nonStrikerId,
  bowlerId,
  battingTurn = 1,
  runsOffBat = 0,
  extraRuns = 0,
  extraType = null,
  wicket = false,
  dismissalKind = null,
  dismissedPlayerId = null,
  legalBall = true,
  createdAt,
}) {
  return {
    id,
    match_id: matchId,
    innings_id: inningsId,
    over_no: overNo,
    delivery_in_over: deliveryInOver,
    striker_id: strikerId,
    non_striker_id: nonStrikerId,
    bowler_id: bowlerId,
    batting_turn: battingTurn,
    runs_off_bat: runsOffBat,
    extra_runs: extraRuns,
    extra_type: extraType,
    wicket,
    dismissal_kind: dismissalKind,
    dismissed_player_id: dismissedPlayerId,
    legal_ball: legalBall,
    created_at: createdAt,
  };
}

export function createReadUiFixture({ includeSecondInnings = false } = {}) {
  const fixtureId = "fixture-1";
  const matchId = "match-1";
  const innings1Id = "inn-1";
  const innings2Id = "inn-2";

  const teamA = { id: "team-a", name: "Alpha CC", short_name: "ALP" };
  const teamB = { id: "team-b", name: "Bravo CC", short_name: "BRV" };

  const players = [
    { id: "a1", name: "Alice Alpha", team_id: "team-a", active: true },
    { id: "a2", name: "Beth Bravo", team_id: "team-a", active: true },
    { id: "a3", name: "Casey Charlie", team_id: "team-a", active: true },
    { id: "a4", name: "Archer Ace", team_id: "team-a", active: true },
    { id: "b1", name: "Blair Bowler", team_id: "team-b", active: true },
    { id: "b2", name: "Devon Dash", team_id: "team-b", active: true },
    { id: "b3", name: "Evan Entry", team_id: "team-b", active: true },
    { id: "b4", name: "Flynn Finisher", team_id: "team-b", active: true },
  ];
  const playersById = Object.fromEntries(players.map((player) => [player.id, player]));

  const match = {
    id: matchId,
    fixture_id: fixtureId,
    scheduled_at: "2026-03-11T10:00:00.000Z",
    status: "playing",
    overs_limit: 2,
    wicket_cap: 10,
    team_a_id: teamA.id,
    team_b_id: teamB.id,
    team_a: teamA,
    team_b: teamB,
  };

  const innings = [
    {
      id: innings1Id,
      match_id: matchId,
      innings_no: 1,
      batting_team_id: teamA.id,
      bowling_team_id: teamB.id,
      completed: false,
    },
  ];

  const balls = [
    makeBall({
      id: "inn1-ball-1",
      matchId,
      inningsId: innings1Id,
      overNo: 0,
      deliveryInOver: 1,
      strikerId: "a1",
      nonStrikerId: "a2",
      bowlerId: "b1",
      runsOffBat: 1,
      createdAt: "2026-03-11T10:00:00.000Z",
    }),
    makeBall({
      id: "inn1-ball-2",
      matchId,
      inningsId: innings1Id,
      overNo: 0,
      deliveryInOver: 2,
      strikerId: "a1",
      nonStrikerId: "a2",
      bowlerId: "b1",
      runsOffBat: 0,
      createdAt: "2026-03-11T10:00:10.000Z",
    }),
    makeBall({
      id: "inn1-ball-3",
      matchId,
      inningsId: innings1Id,
      overNo: 0,
      deliveryInOver: 3,
      strikerId: "a3",
      nonStrikerId: "a2",
      bowlerId: "b1",
      runsOffBat: 2,
      createdAt: "2026-03-11T10:00:30.000Z",
    }),
  ];

  if (includeSecondInnings) {
    innings.push({
      id: innings2Id,
      match_id: matchId,
      innings_no: 2,
      batting_team_id: teamB.id,
      bowling_team_id: teamA.id,
      completed: false,
    });

    balls.push(
      makeBall({
        id: "inn2-ball-1",
        matchId,
        inningsId: innings2Id,
        overNo: 0,
        deliveryInOver: 1,
        strikerId: "b2",
        nonStrikerId: "b3",
        bowlerId: "a4",
        runsOffBat: 4,
        createdAt: "2026-03-11T11:00:00.000Z",
      }),
      makeBall({
        id: "inn2-ball-2",
        matchId,
        inningsId: innings2Id,
        overNo: 0,
        deliveryInOver: 2,
        strikerId: "b2",
        nonStrikerId: "b3",
        bowlerId: "a4",
        wicket: true,
        dismissalKind: "bowled",
        dismissedPlayerId: "b2",
        createdAt: "2026-03-11T11:00:10.000Z",
      }),
      makeBall({
        id: "inn2-ball-3",
        matchId,
        inningsId: innings2Id,
        overNo: 0,
        deliveryInOver: 3,
        strikerId: "b4",
        nonStrikerId: "b3",
        bowlerId: "a4",
        runsOffBat: 1,
        createdAt: "2026-03-11T11:00:20.000Z",
      })
    );
  }

  const matchSessionEvents = [
    {
      event_id: "evt-retired-hurt",
      event_type: "administrative_state_changed",
      created_at: "2026-03-11T10:00:20.000Z",
      applied_at: "2026-03-11T10:00:21.000Z",
      status: "applied",
      match_id: matchId,
      innings_id: innings1Id,
      payload: {
        action_type: "retired_hurt",
        dismissed_player_id: "a1",
        replacement_player_id: "a3",
        post_state: {
          striker_id: "a3",
          non_striker_id: "a2",
          bowler_id: "b1",
          needs_next_bowler: false,
        },
      },
      result: {
        administrative_state: {
          action_type: "retired_hurt",
          dismissed_player_id: "a1",
          replacement_player_id: "a3",
        },
        post_state: {
          striker_id: "a3",
          non_striker_id: "a2",
          bowler_id: "b1",
          needs_next_bowler: false,
        },
      },
    },
  ];

  const ballsByInnings = {
    [innings1Id]: balls.filter((ball) => ball.innings_id === innings1Id),
    ...(includeSecondInnings ? { [innings2Id]: balls.filter((ball) => ball.innings_id === innings2Id) } : {}),
  };
  const sessionEventsByInnings = {
    [innings1Id]: matchSessionEvents,
    ...(includeSecondInnings ? { [innings2Id]: [] } : {}),
  };
  const displayBallsByInnings = Object.fromEntries(
    Object.entries(ballsByInnings).map(([inningsId, inningsBalls]) => [
      inningsId,
      materializeAdministrativeStateBalls({
        balls: inningsBalls,
        sessionEvents: sessionEventsByInnings[inningsId] || [],
      }),
    ])
  );

  return {
    fixtureId,
    matchId,
    match,
    players,
    playersById,
    innings,
    balls,
    matchSessionEvents,
    ballsByInnings,
    sessionEventsByInnings,
    displayBallsByInnings,
    tables: {
      players,
      matches: [match],
      fixture_wicket_caps: [{ fixture_id: fixtureId, wicket_cap: 10 }],
      innings,
      balls,
      match_session_events: matchSessionEvents,
    },
  };
}
