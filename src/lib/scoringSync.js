import { mergeBallIntoList, sortBallsByPosition, updateBallInList } from "./scoring";

let lastClientOrder = 0;

function nextClientOrder(seed = Date.now()) {
  const base = Number.isFinite(Number(seed)) ? Number(seed) : Date.now();
  lastClientOrder = Math.max(lastClientOrder + 1, base);
  return lastClientOrder;
}

export function createEventId(prefix = "event") {
  if (typeof crypto !== "undefined" && crypto?.randomUUID) {
    return `${prefix}-${crypto.randomUUID()}`;
  }

  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function isNetworkLikeError(error) {
  const message = String(error?.message || error || "");
  return /network|fetch|offline|failed to fetch|load failed|timeout/i.test(message);
}

export function isMissingRpcError(error) {
  const message = String(error?.message || error || "");
  return /function|rpc|does not exist|could not find/i.test(message);
}

export function isLockConflictError(error) {
  const message = String(error?.message || error || "");
  return /locked by another scorer session/i.test(message);
}

export function normalizePendingEvent(event) {
  if (!event?.event_id || !event?.event_type || !event?.innings_id) return null;

  return {
    created_at: event.created_at || new Date().toISOString(),
    client_order: Number.isFinite(Number(event.client_order)) ? Number(event.client_order) : nextClientOrder(),
    event_id: event.event_id,
    event_type: event.event_type,
    innings_id: event.innings_id,
    match_id: event.match_id || null,
    payload: event.payload && typeof event.payload === "object" ? event.payload : {},
  };
}

export function enqueuePendingEvent(queue, event) {
  const normalized = normalizePendingEvent(event);
  if (!normalized) return sortPendingEvents(queue || []);

  const filtered = (queue || []).filter((item) => item?.event_id !== normalized.event_id);
  return sortPendingEvents([...filtered, normalized]);
}

export function removePendingEvent(queue, eventId) {
  return sortPendingEvents((queue || []).filter((item) => item?.event_id !== eventId));
}

export function sortPendingEvents(queue) {
  return [...(queue || [])]
    .filter(Boolean)
    .sort((a, b) => {
      const orderDiff = Number(a?.client_order || 0) - Number(b?.client_order || 0);
      if (orderDiff !== 0) return orderDiff;

      const createdDiff = new Date(a?.created_at || 0).getTime() - new Date(b?.created_at || 0).getTime();
      if (createdDiff !== 0) return createdDiff;
      return String(a?.event_id || "").localeCompare(String(b?.event_id || ""));
    });
}

export function applyEventOptimistically({ balls = [], innings = null, event }) {
  const normalized = normalizePendingEvent(event);
  if (!normalized) return { balls: sortBallsByPosition(balls), innings };

  if (normalized.event_type === "add_ball") {
    const optimisticBall = {
      ...(normalized.payload?.ball || {}),
      source_event_id: normalized.event_id,
      local_temp_id: normalized.event_id,
      created_at: normalized.created_at,
    };

    return {
      balls: mergeBallIntoList(balls, optimisticBall),
      innings,
    };
  }

  if (normalized.event_type === "edit_ball") {
    const target = {
      id: normalized.payload?.ball_id || null,
      source_event_id: normalized.payload?.target_source_event_id || null,
      local_temp_id: normalized.payload?.target_source_event_id || null,
    };

    return {
      balls: updateBallInList(balls, target, normalized.payload?.patch || {}),
      innings,
    };
  }

  if (normalized.event_type === "end_innings") {
    return {
      balls: sortBallsByPosition(balls),
      innings: innings ? { ...innings, completed: true } : innings,
    };
  }

  if (normalized.event_type === "reopen_innings") {
    return {
      balls: sortBallsByPosition(balls),
      innings: innings ? { ...innings, completed: false } : innings,
    };
  }

  return {
    balls: sortBallsByPosition(balls),
    innings,
  };
}

export function applyRpcResultToState({ balls = [], innings = null, event, result }) {
  const normalized = normalizePendingEvent(event);
  if (!normalized) return { balls: sortBallsByPosition(balls), innings };

  if ((normalized.event_type === "add_ball" || normalized.event_type === "edit_ball") && result?.ball) {
    return {
      balls: mergeBallIntoList(balls, result.ball),
      innings,
    };
  }

  if ((normalized.event_type === "end_innings" || normalized.event_type === "reopen_innings") && result?.innings) {
    return {
      balls: sortBallsByPosition(balls),
      innings: result.innings,
    };
  }

  return applyEventOptimistically({ balls, innings, event: normalized });
}

export function replayPendingEventsOnState({ balls = [], innings = null, queue = [], inningsId = null }) {
  return sortPendingEvents(queue).reduce(
    (state, event) => {
      if (inningsId && event?.innings_id !== inningsId) return state;
      return applyEventOptimistically({ balls: state.balls, innings: state.innings, event });
    },
    { balls: sortBallsByPosition(balls), innings }
  );
}
