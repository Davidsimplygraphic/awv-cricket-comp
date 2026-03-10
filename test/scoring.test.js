import assert from "node:assert/strict";
import { test } from "./test-helpers.js";

import {
  buildCompletedResultText,
  didBatterFaceBall,
  runsConcededByBowler,
  updateBallInList,
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
  assert.equal(runsConcededByBowler({ extra_type: "noball", extra_runs: 1, runs_off_bat: 2 }), 3);
  assert.equal(didBatterFaceBall({ extra_type: "wide", legal_ball: false }), false);
  assert.equal(didBatterFaceBall({ extra_type: "noball", legal_ball: false }), true);
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
