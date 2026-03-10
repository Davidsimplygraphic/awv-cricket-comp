import assert from "node:assert/strict";
import { test } from "./test-helpers.js";

import {
  clearPendingEvents,
  clearLegacyPendingBallQueues,
  clearScorerState,
  clearScoringSnapshot,
  readLegacyPendingBallQueues,
  readPendingEvents,
  readScorerState,
  readScoringSnapshot,
  writePendingEvents,
  writeScorerState,
  writeScoringSnapshot,
} from "../src/lib/scoringPersistence.js";

function createStorage() {
  const store = new Map();
  return {
    get length() {
      return store.size;
    },
    key(index) {
      return Array.from(store.keys())[index] ?? null;
    },
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(key, String(value));
    },
    removeItem(key) {
      store.delete(key);
    },
  };
}

function withWindow(fn) {
  const previousWindow = global.window;
  const localStorage = createStorage();
  const sessionStorage = createStorage();
  global.window = { localStorage, sessionStorage };

  try {
    fn({ localStorage, sessionStorage });
  } finally {
    if (previousWindow === undefined) {
      delete global.window;
    } else {
      global.window = previousWindow;
    }
  }
}

test("pending event persistence is isolated per scorer session and migrates legacy keys", () => {
  withWindow(({ localStorage }) => {
    localStorage.setItem(
      "awv_pending_events_match-1",
      JSON.stringify([{ event_id: "legacy", event_type: "add_ball", innings_id: "inn-1" }])
    );

    const fallback = readPendingEvents("match-1", "session-a");
    assert.equal(fallback.length, 1);
    assert.equal(fallback[0].event_id, "legacy");

    writePendingEvents("match-1", [{ event_id: "session-a", event_type: "add_ball", innings_id: "inn-1" }], "session-a");
    writePendingEvents("match-1", [{ event_id: "session-b", event_type: "add_ball", innings_id: "inn-1" }], "session-b");

    assert.deepEqual(readPendingEvents("match-1", "session-a").map((event) => event.event_id), ["session-a"]);
    assert.deepEqual(readPendingEvents("match-1", "session-b").map((event) => event.event_id), ["session-b"]);
    assert.equal(localStorage.getItem("awv_pending_events_match-1"), null);

    clearPendingEvents("match-1", "session-a");
    assert.deepEqual(readPendingEvents("match-1", "session-a"), []);
    assert.deepEqual(readPendingEvents("match-1", "session-b").map((event) => event.event_id), ["session-b"]);
  });
});

test("legacy pending ball queues migrate into delivery_recorded events", () => {
  withWindow(({ localStorage }) => {
    localStorage.setItem(
      "awv_pending_balls_match-1_inn-1",
      JSON.stringify([
        {
          local_temp_id: "legacy-ball-1",
          created_at: "2026-03-10T12:00:00.000Z",
          payload: {
            over_no: 0,
            delivery_in_over: 1,
            runs_off_bat: 1,
          },
        },
      ])
    );

    const migrated = readLegacyPendingBallQueues("match-1");
    assert.equal(migrated.length, 1);
    assert.equal(migrated[0].event_type, "delivery_recorded");
    assert.equal(migrated[0].payload.delivery.over_no, 0);

    clearLegacyPendingBallQueues("match-1");
    assert.equal(localStorage.getItem("awv_pending_balls_match-1_inn-1"), null);
  });
});

test("scorer state and offline snapshots are isolated per scorer session", () => {
  withWindow(({ localStorage }) => {
    localStorage.setItem(
      "awv_scorer_state_match-1_inn-1",
      JSON.stringify({ strikerId: "legacy-bat", bowlerId: "legacy-bowl" })
    );
    localStorage.setItem(
      "awv_score_snapshot_match-1",
      JSON.stringify({ matchId: "match-1", inningsNo: 1 })
    );

    assert.equal(readScorerState("match-1", "inn-1", "session-a").strikerId, "legacy-bat");
    assert.equal(readScoringSnapshot("match-1", "session-a").matchId, "match-1");

    writeScorerState("match-1", "inn-1", { strikerId: "a-bat", bowlerId: "a-bowl" }, "session-a");
    writeScorerState("match-1", "inn-1", { strikerId: "b-bat", bowlerId: "b-bowl" }, "session-b");
    writeScoringSnapshot("match-1", { matchId: "match-1", inningsNo: 1, label: "a" }, "session-a");
    writeScoringSnapshot("match-1", { matchId: "match-1", inningsNo: 2, label: "b" }, "session-b");

    assert.equal(readScorerState("match-1", "inn-1", "session-a").strikerId, "a-bat");
    assert.equal(readScorerState("match-1", "inn-1", "session-b").strikerId, "b-bat");
    assert.equal(readScoringSnapshot("match-1", "session-a").label, "a");
    assert.equal(readScoringSnapshot("match-1", "session-b").label, "b");
    assert.equal(localStorage.getItem("awv_scorer_state_match-1_inn-1"), null);
    assert.equal(localStorage.getItem("awv_score_snapshot_match-1"), null);

    clearScorerState("match-1", "inn-1", "session-a");
    clearScoringSnapshot("match-1", "session-a");
    assert.equal(readScorerState("match-1", "inn-1", "session-a"), null);
    assert.equal(readScoringSnapshot("match-1", "session-a"), null);
    assert.equal(readScorerState("match-1", "inn-1", "session-b").strikerId, "b-bat");
    assert.equal(readScoringSnapshot("match-1", "session-b").label, "b");
  });
});
