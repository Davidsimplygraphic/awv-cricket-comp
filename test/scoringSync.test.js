import assert from "node:assert/strict";
import { test } from "./test-helpers.js";

import {
  applyRpcResultToState,
  enqueuePendingEvent,
  replayPendingEventsOnState,
} from "../src/lib/scoringSync.js";

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
