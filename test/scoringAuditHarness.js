import {
  buildInningsTotals,
  buildScorerPostState,
  computeNextPosition,
  deriveLegalBallForExtraType,
  getOverCounts,
  isOverFinished,
  legalBallsCount,
  sumRuns,
  sumWkts,
} from "../src/lib/scoring.js";
import {
  applyEventOptimistically,
  applyRpcResultToState,
  enqueuePendingEvent,
  replayPendingEventsOnState,
} from "../src/lib/scoringSync.js";

function toIso(baseMs, index) {
  return new Date(baseMs + (index * 1000)).toISOString();
}

function makeSequence(start = 1) {
  let current = start;
  return () => current++;
}

function ensureBowler(state) {
  if (state.bowlerId) return state;

  const lastBowlerId = state.balls[state.balls.length - 1]?.bowler_id || "";
  let nextBowlerIndex = state.nextBowlerIndex;
  let candidate = state.bowlers[nextBowlerIndex % state.bowlers.length];

  while (candidate === lastBowlerId && state.bowlers.length > 1) {
    nextBowlerIndex += 1;
    candidate = state.bowlers[nextBowlerIndex % state.bowlers.length];
  }

  return {
    ...state,
    bowlerId: candidate,
    needsNextBowler: false,
    nextBowlerIndex: nextBowlerIndex + 1,
  };
}

function nextTurnFor(playerId, dismissalsByPlayer) {
  return playerId ? ((dismissalsByPlayer.get(playerId) || 0) + 1) : 1;
}

function buildDismissalMap(balls) {
  const map = new Map();
  for (const ball of balls) {
    if (!ball?.wicket || !ball?.dismissed_player_id) continue;
    map.set(ball.dismissed_player_id, (map.get(ball.dismissed_player_id) || 0) + 1);
  }
  return map;
}

function buildBallPayload({
  inningsState,
  action,
  innings1Runs,
  oversLimit,
  wicketCap,
}) {
  const readyState = ensureBowler(inningsState);
  const position = computeNextPosition(readyState.balls);
  const priorOverBalls = readyState.balls.filter(
    (ball) =>
      Number(ball?.over_no || 0) === position.over_no
      && Number(ball?.delivery_in_over || 0) < position.delivery_in_over
  );

  const extraType = action.type === "run" || action.type === "wicket" ? null : action.type;
  const runsOffBat =
    action.type === "run" ? action.runs
      : action.type === "noball" ? action.bat
        : 0;
  const extraRuns =
    action.type === "wide" ? action.total
      : action.type === "noball" ? 1
        : action.type === "bye" || action.type === "legbye" ? action.runs
          : 0;
  const legalBall = deriveLegalBallForExtraType(extraType, priorOverBalls);
  const payload = {
    match_id: "match-1",
    innings_id: readyState.innings.id,
    over_no: position.over_no,
    delivery_in_over: position.delivery_in_over,
    legal_ball: legalBall,
    runs_off_bat: runsOffBat,
    extra_type: extraType,
    extra_runs: extraRuns,
    wicket: action.type === "wicket",
    dismissal_kind: action.type === "wicket" ? (action.dismissalKind || "bowled") : null,
    dismissed_player_id: null,
    striker_id: readyState.strikerId,
    non_striker_id: readyState.nonStrikerId,
    bowler_id: readyState.bowlerId,
    batting_turn: nextTurnFor(readyState.strikerId, buildDismissalMap(readyState.balls)),
  };

  const previewEvent = {
    created_at: action.created_at,
    event_id: action.preview_event_id,
    event_type: "add_ball",
    innings_id: readyState.innings.id,
    match_id: "match-1",
    payload: { ball: payload },
  };
  const nextBalls = applyEventOptimistically({
    balls: readyState.balls,
    innings: readyState.innings,
    event: previewEvent,
  }).balls;

  const projectedRuns = sumRuns(nextBalls);
  const projectedWkts = sumWkts(nextBalls);
  const projectedLegal = legalBallsCount(nextBalls);
  const chaseComplete =
    readyState.innings.innings_no === 2
    && projectedRuns >= (innings1Runs + 1);
  const inningsComplete =
    projectedLegal >= (oversLimit * 6)
    || projectedWkts >= wicketCap
    || chaseComplete
    || !!readyState.innings.completed;

  let nextStrikerId = readyState.strikerId;
  let nextNonStrikerId = readyState.nonStrikerId;
  let nextBatterIndex = readyState.nextBatterIndex;

  if (action.type === "wicket") {
    const outgoingIsStriker = action.out !== "non";
    const survivor = outgoingIsStriker ? readyState.nonStrikerId : readyState.strikerId;
    const incoming = readyState.batters[nextBatterIndex] || `replacement-${nextBatterIndex}`;
    nextBatterIndex += 1;
    payload.dismissed_player_id = outgoingIsStriker ? readyState.strikerId : readyState.nonStrikerId;

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
  } else if (((payload.runs_off_bat || 0) + (payload.extra_runs || 0)) % 2 === 1) {
    [nextStrikerId, nextNonStrikerId] = [nextNonStrikerId, nextStrikerId];
  }

  const overCountsAfter = getOverCounts(nextBalls, payload.over_no);
  const overFinishedAfter = isOverFinished(overCountsAfter);
  let nextBowlerId = readyState.bowlerId;
  let needsNextBowler = false;

  if (overFinishedAfter && !inningsComplete) {
    [nextStrikerId, nextNonStrikerId] = [nextNonStrikerId, nextStrikerId];
    nextBowlerId = "";
    needsNextBowler = true;
  }

  const dismissalsByPlayer = buildDismissalMap(nextBalls);
  const postState = buildScorerPostState({
    strikerId: nextStrikerId,
    nonStrikerId: nextNonStrikerId,
    strikerTurn: nextTurnFor(nextStrikerId, dismissalsByPlayer),
    nonStrikerTurn: nextTurnFor(nextNonStrikerId, dismissalsByPlayer),
    bowlerId: nextBowlerId,
    needsNextBowler,
  });

  return {
    readyState,
    payload,
    postState,
    nextBatterIndex,
    overFinishedAfter,
    inningsComplete,
  };
}

function applyServerAddBall(state, event, resultBall) {
  const next = applyRpcResultToState({
    balls: state.balls,
    innings: state.innings,
    event,
    result: { ball: resultBall, innings: resultBall.innings },
  });

  return {
    ...state,
    balls: next.balls,
    innings: next.innings || state.innings,
  };
}

function snapshotState(label, inningsState, eventLog, queue) {
  const totals = buildInningsTotals(inningsState.innings, inningsState.balls);
  return {
    label,
    inningsId: inningsState.innings.id,
    inningsNo: inningsState.innings.innings_no,
    strikerId: inningsState.strikerId,
    nonStrikerId: inningsState.nonStrikerId,
    bowlerId: inningsState.bowlerId,
    needsNextBowler: inningsState.needsNextBowler,
    pendingQueueLength: queue.length,
    eventCount: eventLog.length,
    totals,
    eventLog: eventLog.map((entry) => ({
      event_id: entry.event_id,
      event_type: entry.event_type,
      innings_id: entry.innings_id,
      payload: entry.payload,
    })),
  };
}

export function simulateScenario({
  innings1Actions,
  innings2Actions = [],
  oversLimit = 20,
  wicketCap = 8,
  offlineInnings2Range = null,
}) {
  const nextServerBallId = makeSequence(1);
  const nextEventIndex = makeSequence(1);
  const baseMs = Date.UTC(2026, 2, 10, 12, 0, 0);
  const snapshots = [];
  const eventLog = [];
  let queue = [];

  let innings1State = {
    innings: { id: "inn-1", innings_no: 1, completed: false },
    balls: [],
    strikerId: "a1",
    nonStrikerId: "a2",
    bowlerId: "",
    needsNextBowler: false,
    batters: ["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8"],
    bowlers: ["x1", "x2", "x3", "x4"],
    nextBatterIndex: 2,
    nextBowlerIndex: 0,
  };

  const applyAction = (inningsState, innings1Runs, action, online = true) => {
    const actionIndex = nextEventIndex();
    const createdAt = toIso(baseMs, actionIndex);
    const previewEventId = `preview-${inningsState.innings.id}-${actionIndex}`;
    const eventId = `evt-${inningsState.innings.id}-${actionIndex}`;
    const built = buildBallPayload({
      inningsState,
      action: { ...action, created_at: createdAt, preview_event_id: previewEventId },
      innings1Runs,
      oversLimit,
      wicketCap,
    });

    const event = {
      created_at: createdAt,
      event_id: eventId,
      event_type: "add_ball",
      innings_id: inningsState.innings.id,
      match_id: "match-1",
      payload: {
        ball: built.payload,
        post_state: built.postState,
      },
    };
    eventLog.push(event);

    let nextState = {
      ...built.readyState,
      strikerId: built.postState.striker_id,
      nonStrikerId: built.postState.non_striker_id,
      bowlerId: built.postState.bowler_id,
      needsNextBowler: built.postState.needs_next_bowler,
      nextBatterIndex: built.nextBatterIndex,
    };

    if (online) {
      nextState = applyServerAddBall(nextState, event, {
        ...built.payload,
        id: `server-ball-${nextServerBallId()}`,
        source_event_id: event.event_id,
        created_at: createdAt,
        updated_at: createdAt,
      });
    } else {
      const optimistic = applyEventOptimistically({
        balls: nextState.balls,
        innings: nextState.innings,
        event,
      });
      nextState = {
        ...nextState,
        balls: optimistic.balls,
        innings: optimistic.innings || nextState.innings,
      };
      queue = enqueuePendingEvent(queue, event);
    }

    snapshots.push(snapshotState(`Ball ${actionIndex}`, nextState, eventLog, queue));
    return nextState;
  };

  innings1Actions.forEach((action) => {
    innings1State = applyAction(innings1State, 0, action, true);
  });

  const innings1EndEvent = {
    created_at: toIso(baseMs, nextEventIndex()),
    event_id: "evt-end-inn-1",
    event_type: "end_innings",
    innings_id: "inn-1",
    match_id: "match-1",
    payload: {},
  };
  eventLog.push(innings1EndEvent);
  const ended = applyRpcResultToState({
    balls: innings1State.balls,
    innings: innings1State.innings,
    event: innings1EndEvent,
    result: { innings: { ...innings1State.innings, completed: true } },
  });
  innings1State = {
    ...innings1State,
    balls: ended.balls,
    innings: ended.innings,
  };
  snapshots.push(snapshotState("End innings 1", innings1State, eventLog, queue));

  let innings2State = {
    innings: { id: "inn-2", innings_no: 2, completed: false },
    balls: [],
    strikerId: "b1",
    nonStrikerId: "b2",
    bowlerId: "",
    needsNextBowler: false,
    batters: ["b1", "b2", "b3", "b4", "b5", "b6", "b7", "b8"],
    bowlers: ["y1", "y2", "y3", "y4"],
    nextBatterIndex: 2,
    nextBowlerIndex: 0,
  };

  const innings1Runs = sumRuns(innings1State.balls);
  innings2Actions.forEach((action, index) => {
    const online = !offlineInnings2Range || index < offlineInnings2Range[0] || index > offlineInnings2Range[1];
    innings2State = applyAction(innings2State, innings1Runs, action, online);
  });

  if (queue.length) {
    for (const event of queue) {
      innings2State = applyServerAddBall(innings2State, event, {
        ...event.payload.ball,
        id: `server-ball-${nextServerBallId()}`,
        source_event_id: event.event_id,
        created_at: event.created_at,
        updated_at: event.created_at,
      });
      snapshots.push(snapshotState(`Replay ${event.event_id}`, innings2State, eventLog, queue));
    }

    queue = [];
  }

  const rebuilt1 = replayPendingEventsOnState({
    balls: [],
    innings: { id: "inn-1", innings_no: 1, completed: false },
    queue: innings1Actions.map((_, index) => eventLog[index]),
    inningsId: "inn-1",
  });
  const rebuilt2 = replayPendingEventsOnState({
    balls: [],
    innings: { id: "inn-2", innings_no: 2, completed: false },
    queue: eventLog.filter((event) => event.innings_id === "inn-2"),
    inningsId: "inn-2",
  });

  return {
    snapshots,
    eventLog,
    innings1State,
    innings2State,
    rebuilt1,
    rebuilt2,
  };
}

export function createLongOfflineActions(ballCount = 50) {
  const actions = [];
  for (let index = 0; index < ballCount; index += 1) {
    if (index % 11 === 3) {
      actions.push({ type: "wide", total: 2 });
      continue;
    }
    if (index % 13 === 7) {
      actions.push({ type: "noball", bat: 1 });
      continue;
    }
    if (index % 17 === 9) {
      actions.push({ type: "wicket", out: "striker", crossed: false });
      continue;
    }
    actions.push({ type: "run", runs: index % 6 });
  }
  return actions;
}
