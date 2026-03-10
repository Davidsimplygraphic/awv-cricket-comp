import assert from "node:assert/strict";
import { test } from "./test-helpers.js";

import {
  buildInningsTotals,
  buildScorerPostState,
  computeNextPosition,
  deriveLegalBallForExtraType,
  legalBallsCount,
  mergeBallIntoList,
  sumRuns,
  sumWkts,
} from "../src/lib/scoring.js";
import {
  applyEventOptimistically,
  applyRpcResultToState,
  enqueuePendingEvent,
} from "../src/lib/scoringSync.js";

test("mergeBallIntoList ignores stale realtime echoes when a newer edit already exists", () => {
  const merged = mergeBallIntoList(
    [
      {
        id: "ball-1",
        source_event_id: "evt-1",
        over_no: 0,
        delivery_in_over: 1,
        runs_off_bat: 4,
        updated_at: "2026-03-10T12:01:00.000Z",
      },
    ],
    {
      id: "ball-1",
      source_event_id: "evt-1",
      over_no: 0,
      delivery_in_over: 1,
      runs_off_bat: 1,
      updated_at: "2026-03-10T12:00:00.000Z",
    }
  );

  assert.equal(merged.length, 1);
  assert.equal(merged[0].runs_off_bat, 4);
});

test("long scoring session stays rebuildable across innings and offline replay", () => {
  let clock = 0;
  let serverBallSeq = 0;
  const stamp = () => `2026-03-10T12:${String(Math.floor(clock / 60)).padStart(2, "0")}:${String(clock++ % 60).padStart(2, "0")}.000Z`;

  const makeInitialState = (inningsId, inningsNo, batters, bowlers) => ({
    innings: { id: inningsId, innings_no: inningsNo, completed: false },
    balls: [],
    strikerId: batters[0],
    nonStrikerId: batters[1],
    bowlerId: bowlers[0],
    needsNextBowler: false,
    nextBatterIndex: 2,
    nextBowlerIndex: 1,
    batters,
    bowlers,
  });

  const chooseNextBowler = (state) => {
    if (state.bowlerId) return state;
    const lastBowlerId = state.balls[state.balls.length - 1]?.bowler_id || "";
    let candidate = state.bowlers[state.nextBowlerIndex % state.bowlers.length];
    while (candidate === lastBowlerId && state.bowlers.length > 1) {
      state.nextBowlerIndex += 1;
      candidate = state.bowlers[state.nextBowlerIndex % state.bowlers.length];
    }
    state.nextBowlerIndex += 1;
    return {
      ...state,
      bowlerId: candidate,
      needsNextBowler: false,
    };
  };

  const createBallEvent = (state, innings1Runs, action, inningsComplete = false) => {
    const readyState = chooseNextBowler(state);
    const position = computeNextPosition(readyState.balls);
    const priorOverBalls = readyState.balls.filter(
      (ball) => Number(ball.over_no || 0) === position.over_no && Number(ball.delivery_in_over || 0) < position.delivery_in_over
    );
    const extraType = action.type === "run" || action.type === "wicket" ? null : action.type;
    const rawBatRuns =
      action.type === "run" ? action.runs
        : action.type === "noball" ? action.bat
          : 0;
    const rawExtraRuns =
      action.type === "wide" ? action.total
        : action.type === "noball" ? 1
          : action.type === "bye" || action.type === "legbye" ? action.runs
            : 0;
    const legalBall = deriveLegalBallForExtraType(extraType, priorOverBalls);
    const payloadBall = {
      innings_id: readyState.innings.id,
      match_id: "match-1",
      over_no: position.over_no,
      delivery_in_over: position.delivery_in_over,
      legal_ball: legalBall,
      runs_off_bat: rawBatRuns,
      extra_type: extraType,
      extra_runs: rawExtraRuns,
      wicket: action.type === "wicket",
      dismissal_kind: action.type === "wicket" ? "bowled" : null,
      dismissed_player_id: null,
      striker_id: readyState.strikerId,
      non_striker_id: readyState.nonStrikerId,
      bowler_id: readyState.bowlerId,
      batting_turn: 1,
    };

    let nextStrikerId = readyState.strikerId;
    let nextNonStrikerId = readyState.nonStrikerId;
    let nextBatterIndex = readyState.nextBatterIndex;

    if (action.type === "wicket") {
      const outgoingIsStriker = action.out !== "non";
      const survivor = outgoingIsStriker ? readyState.nonStrikerId : readyState.strikerId;
      const incoming = readyState.batters[nextBatterIndex] || `replacement-${nextBatterIndex}`;
      nextBatterIndex += 1;
      payloadBall.dismissed_player_id = outgoingIsStriker ? readyState.strikerId : readyState.nonStrikerId;

      if (outgoingIsStriker) {
        if (action.crossed) {
          nextStrikerId = survivor;
          nextNonStrikerId = incoming;
        } else {
          nextStrikerId = incoming;
          nextNonStrikerId = survivor;
        }
      } else {
        nextStrikerId = readyState.strikerId;
        nextNonStrikerId = incoming;
      }
    } else if (((payloadBall.runs_off_bat || 0) + (payloadBall.extra_runs || 0)) % 2 === 1) {
      [nextStrikerId, nextNonStrikerId] = [nextNonStrikerId, nextStrikerId];
    }

    const previewEvent = {
      created_at: stamp(),
      event_id: `preview-${readyState.innings.id}-${clock}`,
      event_type: "add_ball",
      innings_id: readyState.innings.id,
      match_id: "match-1",
      payload: { ball: payloadBall },
    };
    const nextBalls = applyEventOptimistically({
      balls: readyState.balls,
      innings: readyState.innings,
      event: previewEvent,
    }).balls;
    const overBalls = nextBalls.filter((ball) => Number(ball.over_no || 0) === position.over_no);
    const overFinishedAfter = overBalls.some((ball) => ball.legal_ball === false)
      ? overBalls.length >= 7
      : overBalls.filter((ball) => ball.legal_ball !== false).length >= 6;
    const projectedChaseComplete =
      readyState.innings.innings_no === 2 &&
      sumRuns(nextBalls) >= (innings1Runs + 1);
    const projectedInningsComplete =
      legalBallsCount(nextBalls) >= 18
      || sumWkts(nextBalls) >= 8
      || projectedChaseComplete
      || inningsComplete;

    let nextBowlerId = readyState.bowlerId;
    let needsNextBowler = false;
    if (overFinishedAfter && !projectedInningsComplete) {
      [nextStrikerId, nextNonStrikerId] = [nextNonStrikerId, nextStrikerId];
      nextBowlerId = "";
      needsNextBowler = true;
    }

    const postState = buildScorerPostState({
      strikerId: nextStrikerId,
      nonStrikerId: nextNonStrikerId,
      strikerTurn: 1,
      nonStrikerTurn: 1,
      bowlerId: nextBowlerId,
      needsNextBowler,
    });

    const event = {
      created_at: stamp(),
      event_id: `evt-${readyState.innings.id}-${clock}`,
      event_type: "add_ball",
      innings_id: readyState.innings.id,
      match_id: "match-1",
      payload: {
        ball: payloadBall,
        post_state: postState,
      },
    };

    return {
      event,
      nextState: {
        ...readyState,
        strikerId: postState.striker_id,
        nonStrikerId: postState.non_striker_id,
        bowlerId: postState.bowler_id,
        needsNextBowler: postState.needs_next_bowler,
        nextBatterIndex,
      },
    };
  };

  const applyOnlineBall = (state, event) => {
    const result = {
      ball: {
        id: `server-ball-${++serverBallSeq}`,
        updated_at: stamp(),
        created_at: event.created_at,
        source_event_id: event.event_id,
        ...event.payload.ball,
      },
    };
    const applied = applyRpcResultToState({
      balls: state.balls,
      innings: state.innings,
      event,
      result,
    });
    return {
      ...state,
      balls: applied.balls,
      innings: applied.innings || state.innings,
    };
  };

  const applyOfflineBall = (state, queue, event) => ({
    state: {
      ...state,
      ...applyEventOptimistically({
        balls: state.balls,
        innings: state.innings,
        event,
      }),
    },
    queue: enqueuePendingEvent(queue, event),
  });

  const inning1Actions = [
    { type: "run", runs: 1 },
    { type: "run", runs: 0 },
    { type: "run", runs: 4 },
    { type: "wide", total: 2 },
    { type: "run", runs: 2 },
    { type: "wicket", out: "striker", crossed: false },
    { type: "run", runs: 1 },
    { type: "noball", bat: 2 },
    { type: "run", runs: 0 },
    { type: "run", runs: 4 },
    { type: "run", runs: 1 },
    { type: "bye", runs: 1 },
    { type: "run", runs: 2 },
    { type: "run", runs: 0 },
    { type: "run", runs: 6 },
    { type: "run", runs: 1 },
    { type: "legbye", runs: 1 },
    { type: "wicket", out: "non", crossed: false },
    { type: "run", runs: 0 },
    { type: "run", runs: 1 },
  ];

  const inning2Actions = [
    { type: "run", runs: 1 },
    { type: "run", runs: 1 },
    { type: "run", runs: 4 },
    { type: "wide", total: 2 },
    { type: "run", runs: 0 },
    { type: "wicket", out: "non", crossed: false },
    { type: "run", runs: 2 },
    { type: "noball", bat: 1 },
    { type: "run", runs: 6 },
    { type: "run", runs: 1 },
    { type: "bye", runs: 1 },
    { type: "run", runs: 0 },
    { type: "run", runs: 4 },
    { type: "run", runs: 1 },
  ];

  const innings1Events = [];
  const innings2Events = [];
  let innings1State = makeInitialState("inn-1", 1, ["a1", "a2", "a3", "a4", "a5", "a6"], ["x1", "x2", "x3"]);
  let innings2State = makeInitialState("inn-2", 2, ["b1", "b2", "b3", "b4", "b5", "b6"], ["y1", "y2", "y3"]);
  let queue = [];

  for (const action of inning1Actions) {
    const { event, nextState } = createBallEvent(innings1State, 0, action);
    innings1Events.push(event);
    innings1State = applyOnlineBall(nextState, event);
  }

  const innings1EndEvent = {
    created_at: stamp(),
    event_id: "evt-end-inn-1",
    event_type: "end_innings",
    innings_id: "inn-1",
    match_id: "match-1",
    payload: {},
  };
  innings1Events.push(innings1EndEvent);
  innings1State = {
    ...applyRpcResultToState({
      balls: innings1State.balls,
      innings: innings1State.innings,
      event: innings1EndEvent,
      result: { innings: { ...innings1State.innings, completed: true } },
    }),
    strikerId: innings1State.strikerId,
    nonStrikerId: innings1State.nonStrikerId,
    bowlerId: innings1State.bowlerId,
    needsNextBowler: innings1State.needsNextBowler,
    nextBatterIndex: innings1State.nextBatterIndex,
    nextBowlerIndex: innings1State.nextBowlerIndex,
    batters: innings1State.batters,
    bowlers: innings1State.bowlers,
  };

  const innings1Runs = sumRuns(innings1State.balls);
  inning2Actions.forEach((action, index) => {
    const { event, nextState } = createBallEvent(innings2State, innings1Runs, action);
    innings2Events.push(event);
    innings2State = nextState;

    if (index < 4 || index > 10) {
      innings2State = applyOnlineBall(innings2State, event);
      return;
    }

    const offline = applyOfflineBall(innings2State, queue, event);
    innings2State = offline.state;
    queue = offline.queue;
  });

  for (const queuedEvent of queue) {
    innings2State = applyOnlineBall(innings2State, queuedEvent);
  }

  const rebuildInnings = (innings, events) => events.reduce(
    (state, event) => applyEventOptimistically({
      balls: state.balls,
      innings: state.innings,
      event,
    }),
    { balls: [], innings: { ...innings, completed: false } }
  );

  const rebuilt1 = rebuildInnings({ id: "inn-1", innings_no: 1 }, innings1Events);
  const rebuilt2 = rebuildInnings({ id: "inn-2", innings_no: 2 }, innings2Events);
  const live1 = buildInningsTotals(innings1State.innings, innings1State.balls);
  const live2 = buildInningsTotals(innings2State.innings, innings2State.balls);
  const replay1 = buildInningsTotals(rebuilt1.innings, rebuilt1.balls);
  const replay2 = buildInningsTotals(rebuilt2.innings, rebuilt2.balls);

  assert.equal(innings1Events.filter((event) => event.event_type === "add_ball").length, live1.balls.length);
  assert.equal(innings2Events.filter((event) => event.event_type === "add_ball").length, live2.balls.length);
  assert.equal(live1.runs, replay1.runs);
  assert.equal(live1.wkts, replay1.wkts);
  assert.equal(live1.legalBalls, replay1.legalBalls);
  assert.equal(live2.runs, replay2.runs);
  assert.equal(live2.wkts, replay2.wkts);
  assert.equal(live2.legalBalls, replay2.legalBalls);
  assert.ok(innings1Events.length + innings2Events.length >= 30);
});
