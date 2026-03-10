import assert from "node:assert/strict";
import { test } from "./test-helpers.js";

import {
  buildCompletedResultText,
  countLegalBallsBowledBy,
  deriveRosterWicketCap,
  deriveWicketPostState,
  didBatterFaceBall,
  isBattingSideWicket,
  isBowlerCreditedDismissalKind,
  isBowlerCreditedWicket,
  legalBallsCount,
  normalizeDeliveryOutcome,
  reconcileLatestBallEditSelectionState,
  resolveDisplayWicketCap,
  resolveWicketCap,
  runsConcededByBowler,
  selectInningsSummary,
  selectWormSeries,
  sortBallsByPosition,
  sumRuns,
  sumWkts,
  updateBallInList,
  validateWicketDeliveryInput,
  deriveMatchDisplayStatus,
} from "../src/lib/scoring.js";

test("editing the last delivery to a wide makes it the first illegal ball in the over", () => {
  const balls = [
    { id: "b1", over_no: 0, delivery_in_over: 1, legal_ball: true, extra_type: null, extra_runs: 0, runs_off_bat: 1 },
    { id: "b2", over_no: 0, delivery_in_over: 2, legal_ball: true, extra_type: null, extra_runs: 0, runs_off_bat: 0 },
  ];

  const updated = updateBallInList(balls, { id: "b2" }, { extra_type: "wide", extra_runs: 1, runs_off_bat: 4 });
  const lastBall = updated.find((ball) => ball.id === "b2");

  assert.equal(lastBall.legal_ball, false);
  assert.equal(lastBall.extra_runs, 2);
  assert.equal(lastBall.runs_off_bat, 0);
});

test("editing the last delivery to a second illegal ball keeps it legal under the 7-ball rule", () => {
  const balls = [
    { id: "b1", over_no: 0, delivery_in_over: 1, legal_ball: false, extra_type: "wide", extra_runs: 2, runs_off_bat: 0 },
    { id: "b2", over_no: 0, delivery_in_over: 2, legal_ball: true, extra_type: null, extra_runs: 0, runs_off_bat: 1 },
  ];

  const updated = updateBallInList(balls, { id: "b2" }, { extra_type: "wide", extra_runs: 3 });
  const lastBall = updated.find((ball) => ball.id === "b2");

  assert.equal(lastBall.legal_ball, true);
  assert.equal(lastBall.extra_runs, 3);
  assert.equal(lastBall.runs_off_bat, 0);
});

test("bowler runs and faced-ball rules treat byes and wides correctly", () => {
  assert.equal(runsConcededByBowler({ extra_type: "bye", extra_runs: 2, runs_off_bat: 0 }), 0);
  assert.equal(runsConcededByBowler({ extra_type: "legbye", extra_runs: 3, runs_off_bat: 0 }), 0);
  assert.equal(runsConcededByBowler({ extra_type: "wide", extra_runs: 2, runs_off_bat: 0 }), 2);
  assert.equal(runsConcededByBowler({ extra_type: "noball", extra_runs: 1, runs_off_bat: 2 }), 3);
  assert.equal(didBatterFaceBall({ extra_type: "wide", legal_ball: false }), false);
  assert.equal(didBatterFaceBall({ extra_type: "noball", legal_ball: false }), true);
});

test("bowling aggregates and economy exclude byes and leg-byes from bowler-conceded runs", () => {
  const balls = [
    { bowler_id: "bowler-1", extra_type: "bye", extra_runs: 2, runs_off_bat: 0, legal_ball: true },
    { bowler_id: "bowler-1", extra_type: "legbye", extra_runs: 1, runs_off_bat: 0, legal_ball: true },
    { bowler_id: "bowler-1", extra_type: "wide", extra_runs: 2, runs_off_bat: 0, legal_ball: false },
    { bowler_id: "bowler-1", extra_type: "noball", extra_runs: 1, runs_off_bat: 2, legal_ball: false },
    { bowler_id: "bowler-1", extra_type: null, extra_runs: 0, runs_off_bat: 1, legal_ball: true },
    { bowler_id: "bowler-1", extra_type: null, extra_runs: 0, runs_off_bat: 0, legal_ball: true },
  ];

  const runs = balls.reduce((total, ball) => total + runsConcededByBowler(ball), 0);
  const legalBalls = legalBallsCount(balls);
  const economy = legalBalls ? runs / (legalBalls / 6) : 0;

  assert.equal(runs, 6);
  assert.equal(legalBalls, 4);
  assert.equal(economy, 9);
});

test("completed chase results report wickets remaining", () => {
  const text = buildCompletedResultText({
    matchStatus: "completed",
    innings1Team: { name: "Team A" },
    innings2Team: { name: "Team B" },
    innings1: { runs: 100, wkts: 5, balls: [{}], completed: true },
    innings2: { runs: 101, wkts: 6, balls: [{}], completed: true },
    wicketCap: 8,
  });

  assert.equal(text, "Team B won by 2 wickets");
});

test("wicket cap resolution treats null as the default and non-positive values as at least one wicket", () => {
  assert.equal(resolveWicketCap(null, 10), 10);
  assert.equal(resolveWicketCap(undefined, 10), 10);
  assert.equal(resolveWicketCap("", 10), 10);
  assert.equal(resolveWicketCap(0, 10), 1);
  assert.equal(resolveWicketCap(-3, 10), 1);
  assert.equal(resolveWicketCap(8, 10), 8);
});

test("display wicket cap prefers fixture caps, then persisted match caps, then roster fallback", () => {
  const players = [
    { id: "a1", team_id: "team-a", active: true },
    { id: "a2", team_id: "team-a", active: true },
    { id: "a3", team_id: "team-a", active: true },
    { id: "a4", team_id: "team-a", active: true },
    { id: "a5", team_id: "team-a", active: true },
    { id: "a6", team_id: "team-a", active: true },
    { id: "a7", team_id: "team-a", active: true },
    { id: "a8", team_id: "team-a", active: true },
    { id: "a9", team_id: "team-a", active: true },
    { id: "a10", team_id: "team-a", active: true },
    { id: "a11", team_id: "team-a", active: true },
    { id: "a12", team_id: "team-a", active: true },
    { id: "a13", team_id: "team-a", active: true },
    { id: "a14", team_id: "team-a", active: true },
    { id: "a15", team_id: "team-a", active: true },
    { id: "b1", team_id: "team-b", active: true },
    { id: "b2", team_id: "team-b", active: true },
    { id: "b3", team_id: "team-b", active: true },
    { id: "b4", team_id: "team-b", active: true },
    { id: "b5", team_id: "team-b", active: true },
    { id: "b6", team_id: "team-b", active: true },
    { id: "b7", team_id: "team-b", active: true },
    { id: "b8", team_id: "team-b", active: true },
    { id: "b9", team_id: "team-b", active: true },
    { id: "b10", team_id: "team-b", active: true },
    { id: "b11", team_id: "team-b", active: true },
  ];

  const rosterWicketCap = deriveRosterWicketCap(players, ["team-a", "team-b"]);
  assert.equal(rosterWicketCap, 14);

  assert.equal(
    resolveDisplayWicketCap({ fixtureWicketCap: 14, matchWicketCap: 10, rosterWicketCap, fallback: 10 }),
    14
  );
  assert.equal(
    resolveDisplayWicketCap({ fixtureWicketCap: null, matchWicketCap: 12, rosterWicketCap, fallback: 10 }),
    12
  );
  assert.equal(
    resolveDisplayWicketCap({ fixtureWicketCap: null, matchWicketCap: null, rosterWicketCap, fallback: 10 }),
    14
  );
  assert.equal(
    resolveDisplayWicketCap({ fixtureWicketCap: null, matchWicketCap: null, rosterWicketCap: null, fallback: 10 }),
    10
  );
});

test("match completion heuristics do not treat a missing wicket cap as zero wickets", () => {
  const status = deriveMatchDisplayStatus({
    matchStatus: "playing",
    innings1Row: { completed: true },
    innings2Row: { completed: false },
    innings1Balls: [{ over_no: 0, delivery_in_over: 1, legal_ball: true, runs_off_bat: 1, extra_runs: 0, wicket: false }],
    innings2Balls: [{ over_no: 0, delivery_in_over: 1, legal_ball: true, runs_off_bat: 0, extra_runs: 0, wicket: false }],
    oversLimit: 20,
    wicketCap: null,
  });

  assert.equal(status, "live");
});

test("run out deliveries can include completed runs and extras", () => {
  const validated = validateWicketDeliveryInput({
    dismissalKind: "run out",
    runsOffBat: 1,
    extraType: "noball",
    extraRuns: 1,
  });

  assert.equal(validated.ok, true);

  const normalized = normalizeDeliveryOutcome({
    runsOffBat: validated.runsOffBat,
    extraType: validated.extraType,
    extraRuns: validated.extraRuns,
    priorOverBalls: [],
  });

  assert.equal(normalized.runsOffBat, 1);
  assert.equal(normalized.extraType, "noball");
  assert.equal(normalized.extraRuns, 1);
  assert.equal(normalized.legalBall, false);
});

test("unsupported wicket-plus-extra combinations fail closed", () => {
  const bowledWithBye = validateWicketDeliveryInput({
    dismissalKind: "bowled",
    runsOffBat: 0,
    extraType: "bye",
    extraRuns: 1,
  });
  assert.equal(bowledWithBye.ok, false);

  const stumpedWithExtraRuns = validateWicketDeliveryInput({
    dismissalKind: "stumped",
    runsOffBat: 0,
    extraType: "wide",
    extraRuns: 3,
  });
  assert.equal(stumpedWithExtraRuns.ok, false);
});

test("run out post-state follows completed runs before replacing the dismissed batter", () => {
  const postState = deriveWicketPostState({
    strikerId: "bat-1",
    nonStrikerId: "bat-2",
    incomingBatterId: "bat-3",
    dismissedPlayerId: "bat-1",
    dismissalKind: "run out",
    totalRunsOnBall: 1,
    overFinishedAfter: false,
    inningsComplete: false,
    bowlerId: "bowl-1",
    getTurnFor: () => 1,
  });

  assert.equal(postState.striker_id, "bat-2");
  assert.equal(postState.non_striker_id, "bat-3");
});

test("latest-ball edits preserve actor state when the updated outcome is fully deterministic", () => {
  const originalBall = {
    id: "ball-1",
    over_no: 0,
    delivery_in_over: 1,
    legal_ball: true,
    runs_off_bat: 1,
    extra_runs: 0,
    wicket: false,
    striker_id: "bat-1",
    non_striker_id: "bat-2",
    bowler_id: "bowl-1",
    batting_turn: 1,
  };

  const editedBall = {
    ...originalBall,
    runs_off_bat: 2,
  };

  const resolution = reconcileLatestBallEditSelectionState({
    originalBall,
    editedBall,
    ballsAfterEdit: [editedBall],
    preEditPostState: {
      striker_id: "bat-2",
      non_striker_id: "bat-1",
      bowler_id: "bowl-1",
      needs_next_bowler: false,
    },
    inningsCompleted: false,
  });

  assert.equal(resolution.battingAmbiguous, false);
  assert.equal(resolution.bowlerAmbiguous, false);
  assert.equal(resolution.strikerId, "bat-1");
  assert.equal(resolution.nonStrikerId, "bat-2");
  assert.equal(resolution.bowlerId, "bowl-1");
});

test("latest-ball edits only clear batting selections when a new wicket would need an unknown incoming batter", () => {
  const originalBall = {
    id: "ball-2",
    over_no: 0,
    delivery_in_over: 2,
    legal_ball: true,
    runs_off_bat: 0,
    extra_runs: 0,
    wicket: false,
    striker_id: "bat-1",
    non_striker_id: "bat-2",
    bowler_id: "bowl-1",
    batting_turn: 1,
  };

  const editedBall = {
    ...originalBall,
    wicket: true,
    dismissal_kind: "bowled",
    dismissed_player_id: "bat-1",
  };

  const resolution = reconcileLatestBallEditSelectionState({
    originalBall,
    editedBall,
    ballsAfterEdit: [editedBall],
    preEditPostState: {
      striker_id: "bat-1",
      non_striker_id: "bat-2",
      bowler_id: "bowl-1",
      needs_next_bowler: false,
    },
    inningsCompleted: false,
  });

  assert.equal(resolution.battingAmbiguous, true);
  assert.equal(resolution.bowlerAmbiguous, false);
  assert.equal(resolution.bowlerId, "bowl-1");
});

test("latest-ball edits can restore pre-ball batters when a wicket is edited away", () => {
  const originalBall = {
    id: "ball-3",
    over_no: 0,
    delivery_in_over: 3,
    legal_ball: true,
    runs_off_bat: 0,
    extra_runs: 0,
    wicket: true,
    dismissal_kind: "bowled",
    dismissed_player_id: "bat-1",
    striker_id: "bat-1",
    non_striker_id: "bat-2",
    bowler_id: "bowl-1",
    batting_turn: 1,
  };

  const editedBall = {
    ...originalBall,
    wicket: false,
    dismissal_kind: null,
    dismissed_player_id: null,
    runs_off_bat: 0,
  };

  const resolution = reconcileLatestBallEditSelectionState({
    originalBall,
    editedBall,
    ballsAfterEdit: [editedBall],
    preEditPostState: {
      striker_id: "bat-3",
      non_striker_id: "bat-2",
      bowler_id: "bowl-1",
      needs_next_bowler: false,
    },
    inningsCompleted: false,
  });

  assert.equal(resolution.battingAmbiguous, false);
  assert.equal(resolution.strikerId, "bat-1");
  assert.equal(resolution.nonStrikerId, "bat-2");
  assert.equal(resolution.bowlerId, "bowl-1");
});

test("shared scorer totals and bowler legal-ball counts ignore administrative balls", () => {
  const balls = [
    {
      id: "admin-rh",
      bowler_id: "bowler-1",
      extra_type: "retiredhurt",
      dismissal_kind: "retired hurt",
      legal_ball: true,
      runs_off_bat: 0,
      extra_runs: 0,
      wicket: true,
    },
    {
      id: "legal-1",
      bowler_id: "bowler-1",
      extra_type: null,
      dismissal_kind: null,
      legal_ball: true,
      runs_off_bat: 2,
      extra_runs: 0,
      wicket: false,
    },
    {
      id: "illegal-1",
      bowler_id: "bowler-1",
      extra_type: "wide",
      dismissal_kind: null,
      legal_ball: false,
      runs_off_bat: 0,
      extra_runs: 2,
      wicket: false,
    },
  ];

  assert.equal(sumRuns(balls), 4);
  assert.equal(sumWkts(balls), 0);
  assert.equal(legalBallsCount(balls), 1);
  assert.equal(countLegalBallsBowledBy(balls, "bowler-1"), 1);
});

test("batting-side wicket and bowler-credit semantics distinguish run out, stumped, and retired hurt", () => {
  const runOut = {
    wicket: true,
    dismissal_kind: "run out",
    dismissed_player_id: "bat-1",
    extra_type: null,
  };
  const stumped = {
    wicket: true,
    dismissal_kind: "stumped",
    dismissed_player_id: "bat-2",
    extra_type: "wide",
    extra_runs: 2,
    legal_ball: false,
  };
  const retiredHurt = {
    wicket: true,
    dismissal_kind: "retired hurt",
    dismissed_player_id: "bat-3",
    extra_type: "retiredhurt",
  };

  assert.equal(isBattingSideWicket(runOut), true);
  assert.equal(isBowlerCreditedDismissalKind("run out"), false);
  assert.equal(isBowlerCreditedWicket(runOut), false);

  assert.equal(isBattingSideWicket(stumped), true);
  assert.equal(isBowlerCreditedDismissalKind("stumped"), true);
  assert.equal(isBowlerCreditedWicket(stumped), true);

  assert.equal(isBattingSideWicket(retiredHurt), false);
  assert.equal(isBowlerCreditedDismissalKind("retired hurt"), false);
  assert.equal(isBowlerCreditedWicket(retiredHurt), false);

  assert.equal(sumWkts([runOut]), 1);
  assert.equal(sumWkts([stumped]), 1);
  assert.equal(sumWkts([retiredHurt]), 0);
});

test("shared innings summary returns totals, wickets, legal balls, and overs text without counting administrative rows", () => {
  const summary = selectInningsSummary([
    {
      id: "admin-rh",
      extra_type: "retiredhurt",
      dismissal_kind: "retired hurt",
      legal_ball: true,
      runs_off_bat: 0,
      extra_runs: 0,
      wicket: true,
    },
    {
      id: "legal-1",
      extra_type: null,
      dismissal_kind: null,
      legal_ball: true,
      runs_off_bat: 3,
      extra_runs: 0,
      wicket: false,
    },
    {
      id: "illegal-1",
      extra_type: "wide",
      dismissal_kind: null,
      legal_ball: false,
      runs_off_bat: 0,
      extra_runs: 2,
      wicket: false,
    },
  ]);

  assert.deepEqual(summary, {
    runs: 5,
    wkts: 0,
    legalBalls: 1,
    oversText: "0.1",
  });
});

test("shared worm series uses deterministic ordering and ignores administrative rows for runs and legal-ball progression", () => {
  const series = selectWormSeries([
    {
      id: "delivery-2",
      over_no: 0,
      delivery_in_over: 2,
      extra_type: null,
      dismissal_kind: null,
      legal_ball: true,
      runs_off_bat: 4,
      extra_runs: 0,
      created_at: "2026-03-10T12:05:00.000Z",
    },
    {
      id: "admin-rh",
      over_no: 0,
      delivery_in_over: 2,
      extra_type: "retiredhurt",
      dismissal_kind: "retired hurt",
      legal_ball: true,
      runs_off_bat: 0,
      extra_runs: 0,
      created_at: "2026-03-10T12:00:00.000Z",
    },
    {
      id: "delivery-1",
      over_no: "0",
      delivery_in_over: "1",
      extra_type: null,
      dismissal_kind: null,
      legal_ball: true,
      runs_off_bat: 1,
      extra_runs: 0,
      created_at: "2026-03-10T11:55:00.000Z",
    },
    {
      id: "illegal-1",
      over_no: 0,
      delivery_in_over: 3,
      extra_type: "wide",
      dismissal_kind: null,
      legal_ball: false,
      runs_off_bat: 0,
      extra_runs: 2,
      created_at: "2026-03-10T12:10:00.000Z",
    },
  ]);

  assert.deepEqual(series, [
    { x: 0, y: 0 },
    { x: 1, y: 1 },
    { x: 2, y: 5 },
    { x: 2, y: 5 },
    { x: 2, y: 7 },
  ]);
});

test("shared scorer sorting uses source_event_id as a deterministic same-position tie-breaker", () => {
  const sorted = sortBallsByPosition([
    {
      id: null,
      source_event_id: "evt-b",
      local_temp_id: null,
      over_no: 0,
      delivery_in_over: 1,
      extra_type: null,
      created_at: "2026-03-10T12:00:00.000Z",
    },
    {
      id: null,
      source_event_id: "evt-a",
      local_temp_id: null,
      over_no: 0,
      delivery_in_over: 1,
      extra_type: null,
      created_at: "2026-03-10T12:00:00.000Z",
    },
  ]);

  assert.deepEqual(
    sorted.map((ball) => ball.source_event_id),
    ["evt-a", "evt-b"]
  );
});

test("shared scorer sorting keeps administrative balls behind competitive deliveries at the same position", () => {
  const sorted = sortBallsByPosition([
    {
      id: "admin-rh",
      over_no: "0",
      delivery_in_over: "2",
      extra_type: "retiredhurt",
      dismissal_kind: "retired hurt",
      legal_ball: true,
      created_at: "2026-03-10T12:00:00.000Z",
    },
    {
      id: "delivery-2",
      over_no: 0,
      delivery_in_over: 2,
      extra_type: null,
      dismissal_kind: null,
      legal_ball: true,
      created_at: "2026-03-10T12:05:00.000Z",
    },
  ]);

  assert.deepEqual(
    sorted.map((ball) => ball.id),
    ["delivery-2", "admin-rh"]
  );
});
