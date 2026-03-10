import assert from "node:assert/strict";
import { test } from "./test-helpers.js";

import {
  applyRpcResultToState,
  deriveQueuedScorerState,
  enqueuePendingEvent,
  isAuthoritativeScoringRejection,
  removePendingEventsForInnings,
  replayPendingEventsOnState,
} from "../src/lib/scoringSync.js";
import {
  ADMINISTRATIVE_STATE_CHANGED_EVENT_TYPE,
  DELIVERY_RECORDED_EVENT_TYPE,
} from "../src/lib/scoring.js";

test("pending events keep insertion order when timestamps collide", () => {
  const createdAt = "2026-03-10T12:00:00.000Z";

  let queue = enqueuePendingEvent([], {
    event_id: "z-end",
    event_type: "end_innings",
    innings_id: "inn-1",
    created_at: createdAt,
  });

  queue = enqueuePendingEvent(queue, {
    event_id: "a-reopen",
    event_type: "reopen_innings",
    innings_id: "inn-1",
    created_at: createdAt,
  });

  assert.deepEqual(
    queue.map((event) => event.event_id),
    ["z-end", "a-reopen"]
  );

  const replayed = replayPendingEventsOnState({
    balls: [],
    innings: { id: "inn-1", completed: false },
    queue,
    inningsId: "inn-1",
  });

  assert.equal(replayed.innings.completed, false);
});

test("duplicate RPC results reuse the stored canonical ball payload", () => {
  const event = {
    event_id: "evt-1",
    event_type: "add_ball",
    innings_id: "inn-1",
    created_at: "2026-03-10T12:00:00.000Z",
    payload: {
      ball: {
        over_no: 0,
        delivery_in_over: 1,
        striker_id: "bat-1",
        non_striker_id: "bat-2",
        bowler_id: "bowl-1",
      },
    },
  };

  const state = applyRpcResultToState({
    balls: [
      {
        local_temp_id: "evt-1",
        source_event_id: "evt-1",
        over_no: 0,
        delivery_in_over: 1,
      },
    ],
    innings: { id: "inn-1", completed: false },
    event,
    result: {
      duplicate: true,
      result: {
        ball: {
          id: "server-ball-1",
          source_event_id: "evt-1",
          over_no: 0,
          delivery_in_over: 1,
        },
      },
    },
  });

  assert.equal(state.balls.length, 1);
  assert.equal(state.balls[0].id, "server-ball-1");
  assert.equal(state.balls[0].source_event_id, "evt-1");
});

test("queued scorer state overrides stale server recovery state after refresh", () => {
  const derived = deriveQueuedScorerState({
    inningsId: "inn-1",
    basePostState: {
      striker_id: "bat-1",
      non_striker_id: "bat-2",
      bowler_id: "bowl-1",
      needs_next_bowler: false,
    },
    queue: [
      {
        event_id: "evt-queued",
        event_type: "add_ball",
        innings_id: "inn-1",
        created_at: "2026-03-10T12:00:01.000Z",
        payload: {
          post_state: {
            striker_id: "bat-2",
            non_striker_id: "bat-1",
            bowler_id: "bowl-1",
            needs_next_bowler: false,
          },
        },
      },
    ],
  });

  assert.equal(derived.invalidatesPostState, false);
  assert.equal(derived.postState.striker_id, "bat-2");
  assert.equal(derived.postState.non_striker_id, "bat-1");
});

test("legacy queued balls and queued edits fail closed for scorer state recovery", () => {
  const legacyQueuedState = deriveQueuedScorerState({
    inningsId: "inn-1",
    basePostState: {
      striker_id: "bat-1",
      non_striker_id: "bat-2",
      bowler_id: "bowl-1",
      needs_next_bowler: false,
    },
    queue: [
      {
        event_id: "evt-legacy",
        event_type: "add_ball",
        innings_id: "inn-1",
        created_at: "2026-03-10T12:00:01.000Z",
        payload: { ball: { over_no: 0, delivery_in_over: 2 } },
      },
    ],
  });

  assert.equal(legacyQueuedState.invalidatesPostState, true);
  assert.equal(legacyQueuedState.postState, null);

  const editedQueuedState = deriveQueuedScorerState({
    inningsId: "inn-1",
    queue: [
      {
        event_id: "evt-add",
        event_type: "add_ball",
        innings_id: "inn-1",
        created_at: "2026-03-10T12:00:01.000Z",
        payload: {
          post_state: {
            striker_id: "bat-2",
            non_striker_id: "bat-1",
            bowler_id: "bowl-1",
            needs_next_bowler: false,
          },
        },
      },
      {
        event_id: "evt-edit",
        event_type: "edit_ball",
        innings_id: "inn-1",
        created_at: "2026-03-10T12:00:02.000Z",
        payload: {},
      },
    ],
  });

  assert.equal(editedQueuedState.invalidatesPostState, true);
  assert.equal(editedQueuedState.postState, null);
});

test("authoritative replay failures are detected and can discard the affected innings queue slice", () => {
  const queue = [
    {
      event_id: "evt-inn-1-a",
      event_type: "add_ball",
      innings_id: "inn-1",
      created_at: "2026-03-10T12:00:00.000Z",
      client_order: 1,
    },
    {
      event_id: "evt-inn-2-a",
      event_type: "add_ball",
      innings_id: "inn-2",
      created_at: "2026-03-10T12:00:01.000Z",
      client_order: 2,
    },
    {
      event_id: "evt-inn-1-b",
      event_type: "edit_ball",
      innings_id: "inn-1",
      created_at: "2026-03-10T12:00:02.000Z",
      client_order: 3,
    },
  ];

  const filtered = removePendingEventsForInnings(queue, "inn-1");
  assert.deepEqual(filtered.map((event) => event.event_id), ["evt-inn-2-a"]);

  assert.equal(isAuthoritativeScoringRejection(new Error("Cannot add a ball to a completed innings")), true);
  assert.equal(isAuthoritativeScoringRejection(new Error("Only the latest ball in an innings can be edited safely")), true);
  assert.equal(isAuthoritativeScoringRejection(new Error("duplicate key value violates unique constraint \"balls_unique_position\"")), true);
  assert.equal(isAuthoritativeScoringRejection(new Error("Match is locked by another scorer session")), false);
});

test("delivery_recorded events replay like legacy add_ball events", () => {
  const replayed = replayPendingEventsOnState({
    balls: [],
    innings: { id: "inn-1", completed: false },
    queue: [
      {
        event_id: "evt-delivery",
        event_type: DELIVERY_RECORDED_EVENT_TYPE,
        innings_id: "inn-1",
        created_at: "2026-03-10T12:00:00.000Z",
        payload: {
          delivery: {
            over_no: 0,
            delivery_in_over: 1,
            runs_off_bat: 2,
            extra_runs: 0,
          },
        },
      },
    ],
    inningsId: "inn-1",
  });

  assert.equal(replayed.balls.length, 1);
  assert.equal(replayed.balls[0].runs_off_bat, 2);
});

test("administrative_state_changed updates queued scorer recovery without creating a delivery", () => {
  const derived = deriveQueuedScorerState({
    inningsId: "inn-1",
    basePostState: {
      striker_id: "bat-1",
      non_striker_id: "bat-2",
      bowler_id: "bowl-1",
      needs_next_bowler: false,
    },
    queue: [
      {
        event_id: "evt-admin",
        event_type: ADMINISTRATIVE_STATE_CHANGED_EVENT_TYPE,
        innings_id: "inn-1",
        created_at: "2026-03-10T12:00:01.000Z",
        payload: {
          action_type: "retired_hurt",
          post_state: {
            striker_id: "bat-3",
            non_striker_id: "bat-2",
            bowler_id: "bowl-1",
            needs_next_bowler: false,
          },
        },
      },
    ],
  });

  assert.equal(derived.invalidatesPostState, false);
  assert.equal(derived.postState.striker_id, "bat-3");

  const applied = applyRpcResultToState({
    balls: [{ id: "ball-1", over_no: 0, delivery_in_over: 1 }],
    innings: { id: "inn-1", completed: false },
    event: {
      event_id: "evt-admin",
      event_type: ADMINISTRATIVE_STATE_CHANGED_EVENT_TYPE,
      innings_id: "inn-1",
      payload: {},
    },
    result: {
      administrative_state: { action_type: "retired_hurt" },
      post_state: {
        striker_id: "bat-3",
        non_striker_id: "bat-2",
        bowler_id: "bowl-1",
        needs_next_bowler: false,
      },
    },
  });

  assert.equal(applied.balls.length, 1);
  assert.equal(applied.postState.striker_id, "bat-3");
});
