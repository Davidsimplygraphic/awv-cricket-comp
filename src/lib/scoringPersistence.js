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

export function getPendingEventsKey(matchId) {
  return `awv_pending_events_${matchId || "unknown"}`;
}

export function readPendingEvents(matchId) {
  const storage = safeStorage("local");
  if (!storage) return [];
  const parsed = safeParse(storage.getItem(getPendingEventsKey(matchId)), []);
  return Array.isArray(parsed) ? parsed : [];
}

export function writePendingEvents(matchId, queue) {
  const storage = safeStorage("local");
  if (!storage) return;
  const key = getPendingEventsKey(matchId);
  if (!queue?.length) {
    storage.removeItem(key);
    return;
  }
  storage.setItem(key, JSON.stringify(queue));
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

export function getScorerStateKey(matchId, inningsId) {
  return `awv_scorer_state_${matchId || "unknown"}_${inningsId || "unknown"}`;
}

export function getScoringSnapshotKey(scope) {
  return `awv_score_snapshot_${scope || "unknown"}`;
}

export function readScorerState(matchId, inningsId) {
  const storage = safeStorage("local");
  if (!storage) return null;
  const parsed = safeParse(storage.getItem(getScorerStateKey(matchId, inningsId)), null);
  return parsed && typeof parsed === "object" ? parsed : null;
}

export function writeScorerState(matchId, inningsId, state) {
  const storage = safeStorage("local");
  if (!storage || !matchId || !inningsId) return;

  const key = getScorerStateKey(matchId, inningsId);
  if (!state) {
    storage.removeItem(key);
    return;
  }

  storage.setItem(key, JSON.stringify(state));
}

export function readScoringSnapshot(scope) {
  const storage = safeStorage("local");
  if (!storage) return null;
  const parsed = safeParse(storage.getItem(getScoringSnapshotKey(scope)), null);
  return parsed && typeof parsed === "object" ? parsed : null;
}

export function writeScoringSnapshot(scope, snapshot) {
  const storage = safeStorage("local");
  if (!storage || !scope) return;

  const key = getScoringSnapshotKey(scope);
  if (!snapshot) {
    storage.removeItem(key);
    return;
  }

  storage.setItem(key, JSON.stringify(snapshot));
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
