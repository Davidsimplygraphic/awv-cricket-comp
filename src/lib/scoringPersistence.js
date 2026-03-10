function safeStorage(kind) {
  if (typeof window === "undefined") return null;
  return kind === "session" ? window.sessionStorage : window.localStorage;
}

function safeParse(raw, fallback) {
  try {
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function legacyPendingEventsKey(matchId) {
  return `awv_pending_events_${matchId || "unknown"}`;
}

export function getPendingEventsKey(matchId, scope = "shared") {
  return `awv_pending_events_${scope || "shared"}_${matchId || "unknown"}`;
}

export function readPendingEvents(matchId, scope = null) {
  const storage = safeStorage("local");
  if (!storage) return [];

  const scopedKey = scope ? getPendingEventsKey(matchId, scope) : legacyPendingEventsKey(matchId);
  const parsed = safeParse(storage.getItem(scopedKey), null);
  if (Array.isArray(parsed)) return parsed;

  if (scope) {
    const legacy = safeParse(storage.getItem(legacyPendingEventsKey(matchId)), []);
    return Array.isArray(legacy) ? legacy : [];
  }

  return [];
}

export function writePendingEvents(matchId, queue, scope = null) {
  const storage = safeStorage("local");
  if (!storage) return;
  const key = scope ? getPendingEventsKey(matchId, scope) : legacyPendingEventsKey(matchId);
  const legacyKey = scope ? legacyPendingEventsKey(matchId) : null;
  if (!queue?.length) {
    storage.removeItem(key);
    if (legacyKey) storage.removeItem(legacyKey);
    return;
  }
  storage.setItem(key, JSON.stringify(queue));
  if (legacyKey) storage.removeItem(legacyKey);
}

export function clearPendingEvents(matchId, scope = null) {
  const storage = safeStorage("local");
  if (!storage) return;
  storage.removeItem(scope ? getPendingEventsKey(matchId, scope) : legacyPendingEventsKey(matchId));
  if (scope) storage.removeItem(legacyPendingEventsKey(matchId));
}

function legacyScorerStateKey(matchId, inningsId) {
  return `awv_scorer_state_${matchId || "unknown"}_${inningsId || "unknown"}`;
}

export function getScorerStateKey(matchId, inningsId, scope = "shared") {
  return `awv_scorer_state_${scope || "shared"}_${matchId || "unknown"}_${inningsId || "unknown"}`;
}

function legacyScoringSnapshotKey(scope) {
  return `awv_score_snapshot_${scope || "unknown"}`;
}

export function getScoringSnapshotKey(scope, sessionScope = "shared") {
  return `awv_score_snapshot_${sessionScope || "shared"}_${scope || "unknown"}`;
}

export function readScorerState(matchId, inningsId, scope = null) {
  const storage = safeStorage("local");
  if (!storage) return null;
  const scopedKey = scope ? getScorerStateKey(matchId, inningsId, scope) : legacyScorerStateKey(matchId, inningsId);
  const parsed = safeParse(storage.getItem(scopedKey), null);
  if (parsed && typeof parsed === "object") return parsed;

  if (scope) {
    const legacy = safeParse(storage.getItem(legacyScorerStateKey(matchId, inningsId)), null);
    return legacy && typeof legacy === "object" ? legacy : null;
  }

  return null;
}

export function writeScorerState(matchId, inningsId, state, scope = null) {
  const storage = safeStorage("local");
  if (!storage || !matchId || !inningsId) return;

  const key = scope ? getScorerStateKey(matchId, inningsId, scope) : legacyScorerStateKey(matchId, inningsId);
  const legacyKey = scope ? legacyScorerStateKey(matchId, inningsId) : null;
  if (!state) {
    storage.removeItem(key);
    if (legacyKey) storage.removeItem(legacyKey);
    return;
  }

  storage.setItem(key, JSON.stringify(state));
  if (legacyKey) storage.removeItem(legacyKey);
}

export function clearScorerState(matchId, inningsId, scope = null) {
  const storage = safeStorage("local");
  if (!storage || !matchId || !inningsId) return;
  storage.removeItem(scope ? getScorerStateKey(matchId, inningsId, scope) : legacyScorerStateKey(matchId, inningsId));
  if (scope) storage.removeItem(legacyScorerStateKey(matchId, inningsId));
}

export function readScoringSnapshot(scope, sessionScope = null) {
  const storage = safeStorage("local");
  if (!storage) return null;
  const key = sessionScope ? getScoringSnapshotKey(scope, sessionScope) : legacyScoringSnapshotKey(scope);
  const parsed = safeParse(storage.getItem(key), null);
  if (parsed && typeof parsed === "object") return parsed;

  if (sessionScope) {
    const legacy = safeParse(storage.getItem(legacyScoringSnapshotKey(scope)), null);
    return legacy && typeof legacy === "object" ? legacy : null;
  }

  return null;
}

export function writeScoringSnapshot(scope, snapshot, sessionScope = null) {
  const storage = safeStorage("local");
  if (!storage || !scope) return;

  const key = sessionScope ? getScoringSnapshotKey(scope, sessionScope) : legacyScoringSnapshotKey(scope);
  const legacyKey = sessionScope ? legacyScoringSnapshotKey(scope) : null;
  if (!snapshot) {
    storage.removeItem(key);
    if (legacyKey) storage.removeItem(legacyKey);
    return;
  }

  storage.setItem(key, JSON.stringify(snapshot));
  if (legacyKey) storage.removeItem(legacyKey);
}

export function clearScoringSnapshot(scope, sessionScope = null) {
  const storage = safeStorage("local");
  if (!storage || !scope) return;
  storage.removeItem(sessionScope ? getScoringSnapshotKey(scope, sessionScope) : legacyScoringSnapshotKey(scope));
  if (sessionScope) storage.removeItem(legacyScoringSnapshotKey(scope));
}

export function readLegacyPendingBallQueues(matchId) {
  const storage = safeStorage("local");
  if (!storage || !matchId) return [];

  const prefix = `awv_pending_balls_${matchId}_`;
  const legacy = [];

  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key || !key.startsWith(prefix)) continue;

    const inningsId = key.slice(prefix.length);
    const parsed = safeParse(storage.getItem(key), []);
    if (!Array.isArray(parsed)) continue;

    for (const item of parsed) {
      if (!item?.payload) continue;
      const eventId = item.local_temp_id || `legacy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      legacy.push({
        created_at: item.created_at || null,
        event_id: eventId,
        event_type: "add_ball",
        innings_id: inningsId,
        payload: { ball: { ...item.payload, source_event_id: eventId } },
      });
    }
  }

  return legacy;
}

export function clearLegacyPendingBallQueues(matchId) {
  const storage = safeStorage("local");
  if (!storage || !matchId) return;

  const prefix = `awv_pending_balls_${matchId}_`;
  const keys = [];

  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key && key.startsWith(prefix)) keys.push(key);
  }

  keys.forEach((key) => storage.removeItem(key));
}

export function getOrCreateScorerSessionId(scope) {
  const storage = safeStorage("session");
  if (!storage) return `session-${Date.now()}`;

  const key = `awv_scorer_session_${scope || "unknown"}`;
  const existing = storage.getItem(key);
  if (existing) return existing;

  const generated = typeof crypto !== "undefined" && crypto?.randomUUID
    ? crypto.randomUUID()
    : `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  storage.setItem(key, generated);
  return generated;
}

export function describeScorerDevice() {
  if (typeof navigator === "undefined") return "Unknown device";
  const platform = navigator.userAgentData?.platform || navigator.platform || "Unknown platform";
  return `Browser on ${platform}`;
}
