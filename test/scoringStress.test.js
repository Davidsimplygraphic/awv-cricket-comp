import assert from "node:assert/strict";
import fs from "node:fs";

import { test } from "./test-helpers.js";
import { buildInningsTotals, computeNextPosition } from "../src/lib/scoring.js";
import { applyRpcResultToState, replayPendingEventsOnState } from "../src/lib/scoringSync.js";
import { createLongOfflineActions, simulateScenario } from "./scoringAuditHarness.js";

const integritySql = fs.readFileSync(
  new URL("../supabase/migrations/20260310114500_integrity_hardening.sql", import.meta.url),
  "utf8"
);

test("Scenario 1: 50-ball offline session replays deterministically on reconnect", () => {
  const simulation = simulateScenario({
    innings1Actions: [],
    innings2Actions: createLongOfflineActions(50),
    oversLimit: 20,
    wicketCap: 8,
    offlineInnings2Range: [0, 49],
  });

  assert.equal(simulation.innings2State.balls.length, 50);
  assert.equal(simulation.innings2State.balls.length, simulation.rebuilt2.balls.length);
  assert.equal(simulation.innings2State.balls.length, new Set(simulation.innings2State.balls.map((ball) => ball.source_event_id)).size);
});

test("Scenario 2: earlier-ball edits are blocked at the database boundary", () => {
  assert.match(integritySql, /Only the latest ball in an innings can be edited safely/);
});

test("Scenario 3: refresh recovery uses post_state and fails closed after invalidation", () => {
  const addBallState = applyRpcResultToState({
    balls: [],
    innings: { id: "inn-1", completed: false },
    event: {
      event_id: "evt-add",
      event_type: "add_ball",
      innings_id: "inn-1",
      payload: {},
    },
    result: {
      ball: { id: "ball-1", over_no: 0, delivery_in_over: 1, source_event_id: "evt-add" },
      post_state: {
        striker_id: "bat-2",
        non_striker_id: "bat-1",
        bowler_id: "bowl-1",
        needs_next_bowler: false,
      },
    },
  });

  assert.equal(addBallState.postState.striker_id, "bat-2");

  const editedState = applyRpcResultToState({
    balls: addBallState.balls,
    innings: { id: "inn-1", completed: false },
    event: {
      event_id: "evt-edit",
      event_type: "edit_ball",
      innings_id: "inn-1",
      payload: {},
    },
    result: {
      ball: { id: "ball-1", over_no: 0, delivery_in_over: 1, source_event_id: "evt-add" },
      invalidate_post_state: true,
    },
  });

  assert.equal(editedState.invalidatesPostState, true);
  assert.equal(editedState.postState, null);
});

test("Scenario 4: the server contract prevents extra balls after innings completion", () => {
  assert.match(integritySql, /if p_event_type = 'add_ball' then[\s\S]*raise exception 'Cannot add a ball to a completed innings'/);
  assert.match(integritySql, /v_should_complete := \(/);
});

test("Scenario 5: wides and no-balls preserve deterministic over progression", () => {
  const balls = [
    { over_no: 0, delivery_in_over: 1, legal_ball: false, extra_type: "wide" },
    { over_no: 0, delivery_in_over: 2, legal_ball: true, extra_type: "noball" },
    { over_no: 0, delivery_in_over: 3, legal_ball: true, extra_type: null },
    { over_no: 0, delivery_in_over: 4, legal_ball: true, extra_type: null },
    { over_no: 0, delivery_in_over: 5, legal_ball: true, extra_type: null },
    { over_no: 0, delivery_in_over: 6, legal_ball: true, extra_type: null },
    { over_no: 0, delivery_in_over: 7, legal_ball: true, extra_type: null },
  ];

  const next = computeNextPosition(balls);
  assert.equal(next.over_no, 1);
  assert.equal(next.delivery_in_over, 1);
});

test("Invariant: every persisted ball is tied to a persisted session event in the schema contract", () => {
  assert.match(integritySql, /balls_source_event_id_fkey/);
  assert.match(integritySql, /balls_source_event_id_required_check/);
  assert.match(
    integritySql,
    /foreign key \(source_event_id\)[\s\S]*references public\.match_session_events\(event_id\)[\s\S]*on delete cascade/i
  );
  assert.match(integritySql, /check \(source_event_id is not null\)/i);
});

test("Scenario 6: every snapshot rebuilds deterministically from the event log alone", () => {
  const simulation = simulateScenario({
    innings1Actions: [
      { type: "run", runs: 1 },
      { type: "run", runs: 4 },
      { type: "wide", total: 2 },
      { type: "run", runs: 2 },
      { type: "wicket", out: "striker", crossed: false },
      { type: "run", runs: 1 },
      { type: "bye", runs: 1 },
      { type: "run", runs: 0 },
      { type: "run", runs: 6 },
      { type: "run", runs: 1 },
      { type: "legbye", runs: 1 },
      { type: "run", runs: 2 },
    ],
    innings2Actions: createLongOfflineActions(24),
    oversLimit: 20,
    wicketCap: 8,
    offlineInnings2Range: [5, 14],
  });

  for (const snapshot of simulation.snapshots) {
    const rebuilt = replayPendingEventsOnState({
      balls: [],
      innings: { id: snapshot.inningsId, innings_no: snapshot.inningsNo, completed: false },
      queue: snapshot.eventLog.filter((event) => event.innings_id === snapshot.inningsId),
      inningsId: snapshot.inningsId,
    });
    const rebuiltTotals = buildInningsTotals(rebuilt.innings, rebuilt.balls);

    assert.equal(rebuiltTotals.runs, snapshot.totals.runs, `${snapshot.label}: runs mismatch`);
    assert.equal(rebuiltTotals.wkts, snapshot.totals.wkts, `${snapshot.label}: wickets mismatch`);
    assert.equal(rebuiltTotals.legalBalls, snapshot.totals.legalBalls, `${snapshot.label}: legal balls mismatch`);
    assert.equal(rebuiltTotals.overs, snapshot.totals.overs, `${snapshot.label}: overs mismatch`);
    assert.equal(rebuiltTotals.completed, snapshot.totals.completed, `${snapshot.label}: completion mismatch`);
  }
});
