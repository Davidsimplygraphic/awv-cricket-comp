import assert from "node:assert/strict";

import { test } from "./test-helpers.js";
import {
  selectOverBoundaryTicks,
  selectWormWicketPoints,
} from "../src/lib/scoring.js";

function deliveryBall({
  id,
  overNo,
  deliveryInOver,
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
    over_no: overNo,
    delivery_in_over: deliveryInOver,
    runs_off_bat: runsOffBat,
    extra_runs: extraRuns,
    extra_type: extraType,
    wicket,
    dismissal_kind: dismissalKind,
    dismissed_player_id: dismissedPlayerId,
    legal_ball: legalBall,
    created_at: createdAt || `2026-03-11T10:00:0${deliveryInOver}.000Z`,
  };
}

test("worm wicket points return no markers when an innings has no wickets", () => {
  const points = selectWormWicketPoints([
    deliveryBall({ id: "ball-1", overNo: 0, deliveryInOver: 1, runsOffBat: 1 }),
    deliveryBall({ id: "ball-2", overNo: 0, deliveryInOver: 2, runsOffBat: 4 }),
    deliveryBall({ id: "ball-3", overNo: 0, deliveryInOver: 3, extraType: "wide", extraRuns: 2, legalBall: false }),
  ]);

  assert.deepEqual(points, []);
});

test("worm wicket points place standard and illegal-ball wickets on the cumulative run line", () => {
  const points = selectWormWicketPoints([
    deliveryBall({ id: "ball-1", overNo: 0, deliveryInOver: 1, runsOffBat: 1 }),
    deliveryBall({
      id: "ball-2",
      overNo: 0,
      deliveryInOver: 2,
      wicket: true,
      dismissalKind: "bowled",
      dismissedPlayerId: "bat-a",
    }),
    deliveryBall({
      id: "ball-3",
      overNo: 0,
      deliveryInOver: 3,
      extraType: "wide",
      extraRuns: 2,
      legalBall: false,
    }),
    deliveryBall({
      id: "ball-4",
      overNo: 0,
      deliveryInOver: 4,
      extraType: "wide",
      extraRuns: 2,
      legalBall: false,
      wicket: true,
      dismissalKind: "stumped",
      dismissedPlayerId: "bat-b",
    }),
    deliveryBall({
      id: "ball-5",
      overNo: 0,
      deliveryInOver: 5,
      extraType: "retiredhurt",
      extraRuns: 0,
      legalBall: false,
      wicket: true,
      dismissalKind: "retired hurt",
      dismissedPlayerId: "bat-c",
    }),
  ]);

  assert.equal(points.length, 2);
  assert.deepEqual(
    points.map((point) => ({
      x: point.x,
      y: point.y,
      dismissedPlayerId: point.dismissedPlayerId,
      dismissalKind: point.dismissalKind,
    })),
    [
      { x: 2, y: 1, dismissedPlayerId: "bat-a", dismissalKind: "bowled" },
      { x: 2, y: 5, dismissedPlayerId: "bat-b", dismissalKind: "stumped" },
    ]
  );
});

test("worm wicket points support multiple wickets across overs without crashing", () => {
  const points = selectWormWicketPoints([
    deliveryBall({ id: "ball-1", overNo: 0, deliveryInOver: 1, runsOffBat: 2 }),
    deliveryBall({
      id: "ball-2",
      overNo: 0,
      deliveryInOver: 2,
      wicket: true,
      dismissalKind: "caught",
      dismissedPlayerId: "bat-a",
    }),
    deliveryBall({ id: "ball-3", overNo: 1, deliveryInOver: 1, runsOffBat: 4 }),
    deliveryBall({
      id: "ball-4",
      overNo: 1,
      deliveryInOver: 2,
      wicket: true,
      dismissalKind: "run out",
      dismissedPlayerId: "bat-b",
    }),
  ]);

  assert.equal(points.length, 2);
  assert.deepEqual(
    points.map((point) => [point.overNo, point.deliveryInOver, point.x, point.y]),
    [
      [0, 2, 2, 2],
      [1, 2, 4, 6],
    ]
  );
});

test("over boundary ticks scale from innings data and configured match length", () => {
  const balls = [
    deliveryBall({ id: "ball-1", overNo: 0, deliveryInOver: 1 }),
    deliveryBall({ id: "ball-2", overNo: 3, deliveryInOver: 1 }),
  ];

  assert.deepEqual(selectOverBoundaryTicks({ balls }), [1, 2, 3, 4]);
  assert.deepEqual(selectOverBoundaryTicks({ balls, maxOvers: 2 }), [1, 2, 3, 4]);
  assert.deepEqual(selectOverBoundaryTicks({ balls, maxOvers: 6 }), [1, 2, 3, 4, 5, 6]);
});
