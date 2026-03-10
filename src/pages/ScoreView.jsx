import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { supabase } from "../lib/supabase";
import {
  clearPendingEvents,
  clearScorerState,
  clearScoringSnapshot,
  clearLegacyPendingBallQueues,
  describeScorerDevice,
  getOrCreateScorerSessionId,
  readLegacyPendingBallQueues,
  readPendingEvents,
  readScoringSnapshot,
  readScorerState,
  writePendingEvents,
  writeScoringSnapshot,
  writeScorerState,
} from "../lib/scoringPersistence";
import { buildScorerPostState, didBatterFaceBall, mergeBallIntoList, runsConcededByBowler } from "../lib/scoring";
import {
  applyEventOptimistically,
  applyRpcResultToState,
  createEventId,
  deriveQueuedScorerState,
  enqueuePendingEvent,
  isAuthoritativeScoringRejection,
  isLockConflictError,
  isMissingRpcError,
  isNetworkLikeError,
  removePendingEvent,
  removePendingEventsForInnings,
  replayPendingEventsOnState,
} from "../lib/scoringSync";

function toInt(n, fallback = 0) {
  const x = Number(n);
  return Number.isFinite(x) ? x : fallback;
}

function sumRuns(balls) {
  return balls.reduce((acc, b) => acc + (b.runs_off_bat || 0) + (b.extra_runs || 0), 0);
}

function sumWkts(balls) {
  return balls.reduce((acc, b) => acc + (b.wicket ? 1 : 0), 0);
}

function legalBallsCount(balls) {
  // Treat NULL as legal (legacy rows); only explicit false is illegal
  return balls.filter((b) => b.legal_ball !== false).length;
}

function oversTextFromLegal(legalBalls) {
  const overs = Math.floor(legalBalls / 6);
  const ballsInOver = legalBalls % 6;
  return `${overs}.${ballsInOver}`;
}

function getOverBalls(balls, overNo) {
  return balls.filter((b) => toInt(b.over_no, 0) === overNo);
}

/**
 * Tournament rule:
 * - Hard cap: 7 deliveries max in any over
 * - If NO illegal balls in over: over ends after 6 legal balls (normal)
 * - If there IS an illegal ball in over:
 *   - First illegal ball is NOT legal
 *   - Any further deliveries in that over count as legal (even if illegal)
 *   - Over ends after 7 total deliveries
 */
function getOverCounts(balls, overNo) {
  const overBalls = getOverBalls(balls, overNo);
  const deliveries = overBalls.length;
  const legal = overBalls.filter((b) => b.legal_ball !== false).length;
  const hasIllegal = overBalls.some((b) => b.legal_ball === false);
  return { deliveries, legal, hasIllegal };
}

function isOverFinished(counts) {
  if (!counts) return false;
  if (counts.hasIllegal) return counts.deliveries >= 7;
  return counts.legal >= 6;
}

function computeNextPosition(balls) {
  if (!balls.length) {
    return { over_no: 0, delivery_in_over: 1, counts: { deliveries: 0, legal: 0, hasIllegal: false }, newOver: true };
  }

  const last = balls[balls.length - 1];
  const overNo = toInt(last.over_no, 0);
  const counts = getOverCounts(balls, overNo);

  if (isOverFinished(counts)) {
    return {
      over_no: overNo + 1,
      delivery_in_over: 1,
      counts: { deliveries: 0, legal: 0, hasIllegal: false },
      newOver: true,
    };
  }

  const nextDelivery = Math.min(7, toInt(last.delivery_in_over, 0) + 1);

  if (nextDelivery > 7 || counts.deliveries >= 7) {
    return {
      over_no: overNo + 1,
      delivery_in_over: 1,
      counts: { deliveries: 0, legal: 0, hasIllegal: false },
      newOver: true,
    };
  }

  return { over_no: overNo, delivery_in_over: nextDelivery, counts, newOver: false };
}

function sortBallsByPosition(balls) {
  const copy = [...balls];
  copy.sort((a, b) => {
    const oa = toInt(a.over_no, 0);
    const ob = toInt(b.over_no, 0);
    if (oa !== ob) return oa - ob;
    return toInt(a.delivery_in_over, 0) - toInt(b.delivery_in_over, 0);
  });
  return copy;
}

function countLegalBallsBowledBy(balls, bowlerId) {
  // Treat NULL as legal (legacy rows)
  return balls.filter((b) => b.bowler_id === bowlerId && b.legal_ball !== false).length;
}

async function getOrCreateInnings({ matchId, inningsNo, match }) {
  const innRes = await supabase
    .from("innings")
    .select("*")
    .eq("match_id", matchId)
    .eq("innings_no", inningsNo)
    .maybeSingle();

  if (innRes.error) return { data: null, error: innRes.error };
  if (innRes.data) return { data: innRes.data, error: null };

  // IMPORTANT:
  // Two-innings-per-match model:
  // - Innings 1: match.team_a_id bats, match.team_b_id bowls
  // - Innings 2: match.team_b_id bats, match.team_a_id bowls
  const isSecondInnings = Number(inningsNo) === 2;
  const batting_team_id = isSecondInnings ? match.team_b_id : match.team_a_id;
  const bowling_team_id = isSecondInnings ? match.team_a_id : match.team_b_id;

  const createInn = await supabase
    .from("innings")
    .insert({
      match_id: matchId,
      innings_no: inningsNo,
      batting_team_id,
      bowling_team_id,
      completed: false,
    })
    .select("*")
    .single();

  if (createInn.error) {
    const message = String(createInn.error?.message || "");
    if (/duplicate key|unique/i.test(message)) {
      const existingInn = await supabase
        .from("innings")
        .select("*")
        .eq("match_id", matchId)
        .eq("innings_no", inningsNo)
        .maybeSingle();
      if (!existingInn.error && existingInn.data) return { data: existingInn.data, error: null };
    }

    return { data: null, error: createInn.error };
  }
  return { data: createInn.data, error: null };
}

/**
 * Loads players for a team from captain selection:
 * - if match_squads exists: use is_playing=true players for fixture/team
 * - else fallback to active players for team
 */
async function loadSquadPlayers({ fixtureId, teamId }) {
  const sq = await supabase
    .from("match_squads")
    .select("player_id,is_playing")
    .eq("fixture_id", fixtureId)
    .eq("team_id", teamId)
    .eq("is_playing", true);

  if (!sq.error && (sq.data || []).length) {
    const ids = sq.data.map((r) => r.player_id).filter(Boolean);
    const p = await supabase
      .from("players")
      .select("id,name,active,team_id")
      .in("id", ids)
      .order("name", { ascending: true });
    if (p.error) return { data: null, error: p.error };
    return { data: p.data || [], error: null };
  }

  const p2 = await supabase
    .from("players")
    .select("id,name,active,team_id")
    .eq("team_id", teamId)
    .eq("active", true)
    .order("name", { ascending: true });

  if (p2.error) return { data: null, error: p2.error };
  return { data: p2.data || [], error: null };
}

export default function ScoreView() {
  const { fixtureId } = useParams();


  // Single match per fixture_id; each match has two innings rows (innings_no 1 & 2).
  const [matchId, setMatchId] = useState("");
  const [canonicalFixtureId, setCanonicalFixtureId] = useState("");

  const [match, setMatch] = useState(null);
  const [clientSessionId] = useState(() => getOrCreateScorerSessionId(fixtureId || "unknown"));
  const [deviceLabel] = useState(() => describeScorerDevice());

  const [inningsNo, setInningsNo] = useState(1);
  const [innings, setInnings] = useState(null);

  // innings 1 summary for target/result
  const [innings1Runs, setInnings1Runs] = useState(0);
  const [innings1Wkts, setInnings1Wkts] = useState(0);
  const [innings1Legal, setInnings1Legal] = useState(0);
  const [innings1Row, setInnings1Row] = useState(null);

  // innings 2 summary (for reliable result calculation)
  const [innings2RowForResult, setInnings2RowForResult] = useState(null);
  const [innings2RunsForResult, setInnings2RunsForResult] = useState(0);
  const [innings2WktsForResult, setInnings2WktsForResult] = useState(0);
  const [innings2LegalForResult, setInnings2LegalForResult] = useState(0);

  const [balls, setBalls] = useState([]);
  const [battingPlayers, setBattingPlayers] = useState([]);
  const [bowlingPlayers, setBowlingPlayers] = useState([]);

  const [strikerId, setStrikerId] = useState("");
  const [nonStrikerId, setNonStrikerId] = useState("");
  const [strikerTurn, setStrikerTurn] = useState(1);
  const [nonStrikerTurn, setNonStrikerTurn] = useState(1);
  const [bowlerId, setBowlerId] = useState("");

  const [needsNextBowler, setNeedsNextBowler] = useState(false);
  const [needsWicketModal, setNeedsWicketModal] = useState(false);

  const [wicketCrossed, setWicketCrossed] = useState(false);
  const [incomingBatterId, setIncomingBatterId] = useState("");
  const [dismissalKind, setDismissalKind] = useState("bowled");
  const [wicketEndedOver, setWicketEndedOver] = useState(false);

  // ✅ NEW: select who was dismissed (striker vs non-striker)
  const [dismissedPlayerId, setDismissedPlayerId] = useState("");

  // ICC-style keypad tabs + edit last delivery
  const [keypadTab, setKeypadTab] = useState("runs"); // runs | extras | wicket
  const [editOpen, setEditOpen] = useState(false);
  const [editBall, setEditBall] = useState(null);
  const [editExtraType, setEditExtraType] = useState(null);
  const [editBatRuns, setEditBatRuns] = useState(0);
  const [editExtraRuns, setEditExtraRuns] = useState(0);
  const [editIsWicket, setEditIsWicket] = useState(false);
  const [editDismissalKind, setEditDismissalKind] = useState("bowled");
  // ✅ NEW: edit dismissed player on last ball
  const [editDismissedPlayerId, setEditDismissedPlayerId] = useState("");

  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [isOnline, setIsOnline] = useState(typeof navigator === "undefined" ? true : navigator.onLine);
  const [pendingEvents, setPendingEvents] = useState([]);
  const [isFlushingQueue, setIsFlushingQueue] = useState(false);
  const [lockReady, setLockReady] = useState(false);
  const [scoringLocked, setScoringLocked] = useState(false);
  const [activeScorerSession, setActiveScorerSession] = useState(null);
  const [lockFeatureAvailable, setLockFeatureAvailable] = useState(true);
  const [takingControl, setTakingControl] = useState(false);

  const ballsRef = useRef([]);
  const inningsRef = useRef(null);
  const strikerIdRef = useRef("");
  const nonStrikerIdRef = useRef("");
  const strikerTurnRef = useRef(1);
  const nonStrikerTurnRef = useRef(1);
  const bowlerIdRef = useRef("");
  const pendingEventsRef = useRef([]);
  const savingRef = useRef(false);
  const flushingQueueRef = useRef(false);
  const matchSnapshotScope = fixtureId || canonicalFixtureId || matchId || "unknown";
  const persistenceScope = clientSessionId || "shared";

  // CURRENT innings totals
  const totalRuns = useMemo(() => sumRuns(balls), [balls]);
  const wickets = useMemo(() => sumWkts(balls), [balls]);
  const legalBalls = useMemo(() => legalBallsCount(balls), [balls]);

  const oversLimit = useMemo(() => {
    const v = toInt(match?.overs_limit, 20);
    return v > 0 ? v : 20;
  }, [match]);

  const maxLegal = useMemo(() => oversLimit * 6, [oversLimit]);
  const oversText = useMemo(() => oversTextFromLegal(legalBalls), [legalBalls]);

  const wicketCap = useMemo(() => {
    const v = toInt(match?.wicket_cap, 10);
    return v > 0 ? v : 10;
  }, [match]);

  const allOut = useMemo(() => wickets >= wicketCap, [wickets, wicketCap]);
  const oversDone = useMemo(() => legalBalls >= maxLegal, [legalBalls, maxLegal]);
  const chaseComplete = useMemo(() => {
    if (inningsNo !== 2) return false;
    if (!(innings1Row?.completed || innings1Legal > 0)) return false;
    return totalRuns >= (innings1Runs + 1);
  }, [innings1Legal, innings1Row?.completed, innings1Runs, inningsNo, totalRuns]);
  const inningsCompletedFlag = useMemo(() => !!innings?.completed, [innings]);
  const inningsComplete = useMemo(
    () => oversDone || allOut || chaseComplete || inningsCompletedFlag,
    [oversDone, allOut, chaseComplete, inningsCompletedFlag]
  );

  const nextPos = useMemo(() => computeNextPosition(balls), [balls]);

  const lastOverBowlerId = useMemo(() => {
    if (!balls.length) return "";
    return balls[balls.length - 1]?.bowler_id || "";
  }, [balls]);

  const currentRR = useMemo(() => {
    if (legalBalls <= 0) return "0.00";
    return (totalRuns / (legalBalls / 6)).toFixed(2);
  }, [legalBalls, totalRuns]);

  const target = useMemo(() => (inningsNo === 2 ? innings1Runs + 1 : null), [inningsNo, innings1Runs]);
  const ballsRemaining = useMemo(() => Math.max(0, maxLegal - legalBalls), [maxLegal, legalBalls]);

  const runsRemaining = useMemo(() => {
    if (inningsNo !== 2) return null;
    return Math.max(0, (innings1Runs + 1) - totalRuns);
  }, [inningsNo, innings1Runs, totalRuns]);

  const requiredRR = useMemo(() => {
    if (inningsNo !== 2) return null;
    if (ballsRemaining <= 0) return runsRemaining > 0 ? "∞" : "0.00";
    return (runsRemaining / (ballsRemaining / 6)).toFixed(2);
  }, [inningsNo, ballsRemaining, runsRemaining]);

  const resultText = useMemo(() => {
    if (!match) return "";
    if (inningsNo !== 2) return "";

    // Use the computed innings totals rather than the currently-visible innings state.
    // This prevents incorrect results when a match is opened via a legacy/incorrect URL.
    const i1Runs = toInt(innings1Runs, 0);
    const i2Runs = toInt(innings2RunsForResult, 0);
    const i2Wkts = toInt(innings2WktsForResult, 0);
    const i2Legal = toInt(innings2LegalForResult, 0);

    const targetToWin = i1Runs + 1;
    const maxLegal = toInt(match?.overs_limit, 20) * 6;
    const ballsRem = Math.max(0, maxLegal - i2Legal);

    const teamById = new Map();
    if (match?.team_a?.id) teamById.set(match.team_a.id, match.team_a);
    if (match?.team_b?.id) teamById.set(match.team_b.id, match.team_b);

    const inn1BatTeam = innings1Row?.batting_team_id ? teamById.get(innings1Row.batting_team_id) : match?.team_a;
    const inn2BatTeam = innings2RowForResult?.batting_team_id
      ? teamById.get(innings2RowForResult.batting_team_id)
      : match?.team_b;

    const team1Name = inn1BatTeam?.name || inn1BatTeam?.short_name || "Team 1";
    const team2Name = inn2BatTeam?.name || inn2BatTeam?.short_name || "Team 2";

    const innings2Exhausted =
      !!innings2RowForResult?.completed || i2Legal >= maxLegal || i2Wkts >= wicketCap;

    if (!innings2Exhausted) {
      if (i2Runs > i1Runs) {
        const leadBy = i2Runs - i1Runs;
        return `LIVE: ${team2Name} is ahead by ${leadBy} run${leadBy === 1 ? "" : "s"} with ${ballsRem} ball${ballsRem === 1 ? "" : "s"} remaining.`;
      }

      const runsNeeded = Math.max(0, targetToWin - i2Runs);
      return `LIVE: ${team2Name} needs ${runsNeeded} run${runsNeeded === 1 ? "" : "s"} from ${ballsRem} ball${ballsRem === 1 ? "" : "s"}.`;
    }

    if (i2Runs === i1Runs) return "RESULT: Match tied.";
    if (i2Runs > i1Runs) {
      const wicketsRemaining = Math.max(0, wicketCap - i2Wkts);
      return `RESULT: ${team2Name} won by ${wicketsRemaining} wicket${wicketsRemaining === 1 ? "" : "s"}.`;
    }

    const runsBy = i1Runs - i2Runs;
    return `RESULT: ${team1Name} won by ${runsBy} run${runsBy === 1 ? "" : "s"}.`;
  }, [
    match,
    inningsNo,
    wicketCap,
    innings1Runs,
    innings1Row,
    innings2RowForResult,
    innings2RunsForResult,
    innings2WktsForResult,
    innings2LegalForResult,
  ]);

  /* Match status is derived from innings and balls. Do not rewrite stored match status from a potentially stale client view.
  useEffect(() => {
    if (!match?.id) return;
    const status = String(match.status || "").toLowerCase();
    if (status !== "scheduled") return;
    if (!innings?.id) return;
    if (!balls?.length) return;

    (async () => {
      const upd = await supabase
        .from("matches")
        .update({ status: "live" })
        .eq("id", match.id)
        .select(
          `
          *,
          team_a:teams!matches_team_a_id_fkey(id,name,short_name),
          team_b:teams!matches_team_b_id_fkey(id,name,short_name)
          `
        )
        .maybeSingle();
      if (!upd.error && upd.data) setMatch(upd.data);
    })();
  }, [match?.id, match?.status, innings?.id, balls?.length]);

// Safety: if a match was previously marked completed but no balls have been scored yet (or innings 2 isn't actually decided),
// force it back to scheduled so Fixtures / Results doesn't show "COMPLETED" incorrectly.
useEffect(() => {
  if (!match?.id) return;
  const status = String(match.status || "").toLowerCase();
  if (status !== "completed") return;

  const anyBalls = (balls || []).length > 0;
  const i2HasMeaningful =
    (innings2LegalForResult || 0) > 0 || (innings2RunsForResult || 0) > 0 || !!innings2RowForResult?.completed;

  // If the match isn't actually decided yet, treat it as LIVE (stale completed flag).
  const maxLegal = toInt(match?.overs_limit, 20) * 6;
  const targetToWin = toInt(innings1Runs, 0) + 1;
  const innings2Exhausted =
    !!innings2RowForResult?.completed || (innings2LegalForResult || 0) >= maxLegal || (innings2WktsForResult || 0) >= wicketCap;
  const decided = innings2Exhausted;

  // If no scoring yet (and innings 2 not decided), this is almost certainly a stale "completed" flag.
  if (!anyBalls && !i2HasMeaningful) {
    (async () => {
      const upd = await supabase
        .from("matches")
        .update({ status: "scheduled" })
        .eq("id", match.id)
        .select(
          `
          *,
          team_a:teams!matches_team_a_id_fkey(id,name,short_name),
          team_b:teams!matches_team_b_id_fkey(id,name,short_name)
          `
        )
        .maybeSingle();
      if (!upd.error && upd.data) setMatch(upd.data);
    })();
    return;
  }

  // If there are balls, but the chase isn't decided yet, it should not be completed.
  if (anyBalls && !decided) {
    (async () => {
      const upd = await supabase
        .from("matches")
        .update({ status: "live" })
        .eq("id", match.id)
        .select(
          `
          *,
          team_a:teams!matches_team_a_id_fkey(id,name,short_name),
          team_b:teams!matches_team_b_id_fkey(id,name,short_name)
          `
        )
        .maybeSingle();
      if (!upd.error && upd.data) setMatch(upd.data);
    })();
  }
}, [
  match?.id,
  match?.status,
  match?.overs_limit,
  balls?.length,
  wicketCap,
  innings1Runs,
  innings2RowForResult?.completed,
  innings2RunsForResult,
  innings2WktsForResult,
  innings2LegalForResult,
]); */


  // ✅ FIX: dismissal counts MUST use dismissed_player_id (not striker_id)
const dismissalsByBatter = useMemo(() => {
  const map = new Map();
  balls.forEach((b) => {
    if (b.wicket && b.dismissed_player_id) {
      map.set(
        b.dismissed_player_id,
        (map.get(b.dismissed_player_id) || 0) + 1
      );
    }
  });
  return map;
}, [balls]);

  
// Bat-twice rule helper:
// batting_turn is tracked per STRIKER appearance in balls.batting_turn (1 = first time batting in this innings, 2 = second, etc.)
const getTurnFor = (playerId) => (playerId ? (dismissalsByBatter.get(playerId) || 0) + 1 : 1);

const setStrikerSelection = (playerId) => {
  setStrikerId(playerId || "");
  setStrikerTurn(getTurnFor(playerId));
};

const setNonStrikerSelection = (playerId) => {
  setNonStrikerId(playerId || "");
  setNonStrikerTurn(getTurnFor(playerId));
};

const clearLiveSelections = () => {
  setStrikerSelection("");
  setNonStrikerSelection("");
  setBowlerId("");
  setNeedsNextBowler(false);
};

const applyRecoveredScorerState = (state) => {
  if (!state || typeof state !== "object") return false;

  setStrikerSelection(state.striker_id || "");
  setNonStrikerSelection(state.non_striker_id || "");
  if (typeof state.striker_turn === "number") setStrikerTurn(toInt(state.striker_turn, 1) || 1);
  if (typeof state.non_striker_turn === "number") setNonStrikerTurn(toInt(state.non_striker_turn, 1) || 1);
  setBowlerId(state.bowler_id || "");
  setNeedsNextBowler(!!state.needs_next_bowler);
  return true;
};

const applyStoredScorerState = (state) => {
  if (!state || typeof state !== "object") return false;

  if (state.strikerId) setStrikerSelection(state.strikerId);
  if (state.nonStrikerId) setNonStrikerSelection(state.nonStrikerId);
  if (typeof state.strikerTurn === "number") setStrikerTurn(state.strikerTurn);
  if (typeof state.nonStrikerTurn === "number") setNonStrikerTurn(state.nonStrikerTurn);
  if (state.bowlerId !== undefined) setBowlerId(state.bowlerId || "");
  setNeedsNextBowler(!!state.needsNextBowler);
  return true;
};

const loadCanonicalRecoveryState = async (resolvedMatchId, resolvedInningsId) => {
  if (!resolvedMatchId || !resolvedInningsId || !isOnline) {
    return { recoveryState: null, stateInvalidated: false, missing: false };
  }

  const { data, error } = await supabase.rpc("get_innings_recovery_state", {
    p_match_id: resolvedMatchId,
    p_innings_id: resolvedInningsId,
  });

  if (error) {
    if (isMissingRpcError(error)) {
      return { recoveryState: null, stateInvalidated: false, missing: true };
    }

    if (isNetworkLikeError(error)) {
      return { recoveryState: null, stateInvalidated: false, missing: false };
    }

    setErr(`Recovery state error: ${error.message}`);
    return { recoveryState: null, stateInvalidated: false, missing: false };
  }

  return {
    recoveryState: data?.recovery_state && typeof data.recovery_state === "object" ? data.recovery_state : null,
    stateInvalidated: data?.state_invalidated === true,
    missing: false,
  };
};

const readStoredPendingQueue = (resolvedMatchId) => {
  if (!resolvedMatchId) return [];

  const fromStorage = (readPendingEvents(resolvedMatchId, persistenceScope) || []).reduce(
    (queue, event) => enqueuePendingEvent(queue, { ...event, match_id: event?.match_id || resolvedMatchId }),
    []
  );

  const legacy = readLegacyPendingBallQueues(resolvedMatchId).reduce(
    (queue, event) => enqueuePendingEvent(queue, { ...event, match_id: resolvedMatchId }),
    fromStorage
  );

  clearLegacyPendingBallQueues(resolvedMatchId);
  return legacy;
};

const restorePreferredScorerState = ({
  inningsId,
  recoveryState = null,
  stateInvalidated = false,
  storedScorerState = null,
  pendingQueue = pendingEventsRef.current,
} = {}) => {
  const hasPendingEvents = (pendingQueue || []).some((event) => event?.innings_id === inningsId);
  const queuedState = deriveQueuedScorerState({
    queue: pendingQueue,
    inningsId,
    basePostState: stateInvalidated ? null : recoveryState,
  });

  if (stateInvalidated || queuedState.invalidatesPostState) {
    if (matchId && inningsId) clearScorerState(matchId, inningsId, persistenceScope);
    clearLiveSelections();
    return { restored: false, invalidated: true, hasPendingEvents };
  }

  if (applyRecoveredScorerState(queuedState.postState)) {
    return { restored: true, invalidated: false, hasPendingEvents };
  }

  if (!hasPendingEvents && applyStoredScorerState(storedScorerState)) {
    return { restored: true, invalidated: false, hasPendingEvents };
  }

  clearLiveSelections();
  return { restored: false, invalidated: false, hasPendingEvents };
};

const restoreSnapshot = (snapshot) => {
  if (!snapshot || typeof snapshot !== "object") return false;
  if (!snapshot.matchId || !snapshot.match) return false;

  setMatch(snapshot.match || null);
  setMatchId(snapshot.matchId || "");
  setCanonicalFixtureId(snapshot.canonicalFixtureId || snapshot.match?.fixture_id || snapshot.matchId);
  setInningsNo(toInt(snapshot.inningsNo, 1) || 1);
  setInnings(snapshot.innings || null);
  setInnings1Row(snapshot.innings1Row || null);
  setInnings1Runs(toInt(snapshot.innings1Runs, 0));
  setInnings1Wkts(toInt(snapshot.innings1Wkts, 0));
  setInnings1Legal(toInt(snapshot.innings1Legal, 0));
  setInnings2RowForResult(snapshot.innings2RowForResult || null);
  setInnings2RunsForResult(toInt(snapshot.innings2RunsForResult, 0));
  setInnings2WktsForResult(toInt(snapshot.innings2WktsForResult, 0));
  setInnings2LegalForResult(toInt(snapshot.innings2LegalForResult, 0));
  setBalls(sortBallsByPosition(snapshot.balls || []));
  setBattingPlayers(Array.isArray(snapshot.battingPlayers) ? snapshot.battingPlayers : []);
  setBowlingPlayers(Array.isArray(snapshot.bowlingPlayers) ? snapshot.bowlingPlayers : []);
  setStrikerId(snapshot.strikerId || "");
  setNonStrikerId(snapshot.nonStrikerId || "");
  setStrikerTurn(toInt(snapshot.strikerTurn, 1) || 1);
  setNonStrikerTurn(toInt(snapshot.nonStrikerTurn, 1) || 1);
  setBowlerId(snapshot.bowlerId || "");
  setNeedsNextBowler(!!snapshot.needsNextBowler);
  setLockReady(!!snapshot.lockReady);
  setLockFeatureAvailable(snapshot.lockFeatureAvailable !== false);
  setPendingEvents(Array.isArray(snapshot.pendingEvents) ? snapshot.pendingEvents : readStoredPendingQueue(snapshot.matchId));
  setInfo("Offline snapshot restored. Pending scoring changes will sync when the connection returns.");
  return true;
};

const applyOptimisticEventState = (event) => {
  const nextState = applyEventOptimistically({
    balls: ballsRef.current,
    innings: inningsRef.current,
    event,
  });

  setBalls(nextState.balls);
  if (nextState.innings !== inningsRef.current) {
    setInnings(nextState.innings);
  }

  return nextState;
};

const applyServerEventState = (event, result) => {
  const nextState = applyRpcResultToState({
    balls: ballsRef.current,
    innings: inningsRef.current,
    event,
    result,
  });

  setBalls(nextState.balls);
  if (nextState.innings !== inningsRef.current) {
    setInnings(nextState.innings);
  }

  return nextState;
};

const reloadCurrentInningsState = async (targetInningsId = inningsRef.current?.id) => {
  if (!matchId || !targetInningsId) return;

  const [ballsRes, inningsRes] = await Promise.all([
    supabase
      .from("balls")
      .select("*")
      .eq("match_id", matchId)
      .eq("innings_id", targetInningsId)
      .order("over_no", { ascending: true })
      .order("delivery_in_over", { ascending: true }),
    supabase.from("innings").select("*").eq("id", targetInningsId).maybeSingle(),
  ]);

  if (!ballsRes.error) {
    setBalls(sortBallsByPosition(ballsRes.data || []));
  }

  if (!inningsRes.error && inningsRes.data) {
    setInnings((prev) => (prev?.id === inningsRes.data.id ? inningsRes.data : prev));
  }
};

const applySessionEvent = async (
  event,
  {
    optimisticQueuedInfo = "Offline: scoring change queued locally.",
    successInfo = "Saved ✅",
    failurePrefix = "Save",
  } = {}
) => {
  const normalizedEvent = {
    created_at: event?.created_at || new Date().toISOString(),
    event_id: event?.event_id || createEventId(event?.event_type || "event"),
    event_type: event?.event_type,
    innings_id: event?.innings_id || inningsRef.current?.id || "",
    match_id: event?.match_id || matchId,
    payload: event?.payload || {},
  };

  if (!normalizedEvent.match_id || !normalizedEvent.innings_id || !normalizedEvent.event_type) {
    throw new Error("Incomplete scoring event payload.");
  }

  if (!isOnline) {
    setPendingEvents((prev) => enqueuePendingEvent(prev, normalizedEvent));
    applyOptimisticEventState(normalizedEvent);
    setInfo(optimisticQueuedInfo);
    return { queued: true, result: null, event: normalizedEvent };
  }

  const { data, error } = await supabase.rpc("apply_match_session_event", {
    p_event_id: normalizedEvent.event_id,
    p_match_id: normalizedEvent.match_id,
    p_innings_id: normalizedEvent.innings_id,
    p_client_session_id: clientSessionId,
    p_event_type: normalizedEvent.event_type,
    p_payload: normalizedEvent.payload,
  });

  if (error) {
    if (isMissingRpcError(error)) {
      setErr("The database is missing the required scoring RPC. Apply the latest Supabase migrations before scoring.");
      throw error;
    }

    if (isLockConflictError(error)) {
      setScoringLocked(true);
      setErr("Another scorer session currently holds the match lock for this fixture.");
      throw error;
    }

    if (isNetworkLikeError(error)) {
      setPendingEvents((prev) => enqueuePendingEvent(prev, normalizedEvent));
      applyOptimisticEventState(normalizedEvent);
      setInfo(optimisticQueuedInfo);
      return { queued: true, result: null, event: normalizedEvent };
    }

    const message = String(error?.message || error || "");
    if (/balls_unique_position/i.test(message)) {
      await reloadCurrentInningsState(normalizedEvent.innings_id);
      setErr("A scoring conflict was detected for that delivery. Canonical innings state has been reloaded.");
      throw error;
    }

    setErr(`${failurePrefix} failed: ${message}`);
    throw error;
  }

  applyServerEventState(normalizedEvent, data || {});
  setPendingEvents((prev) => removePendingEvent(prev, normalizedEvent.event_id));
  if (successInfo) setInfo(successInfo);
  return { queued: false, result: data || null, event: normalizedEvent };
};

const flushPendingQueue = async () => {
  if (!matchId || !isOnline || !pendingEventsRef.current.length || flushingQueueRef.current) return;
  if (lockFeatureAvailable && scoringLocked) return;

  flushingQueueRef.current = true;
  setIsFlushingQueue(true);

  try {
    for (const event of pendingEventsRef.current) {
      const { data, error } = await supabase.rpc("apply_match_session_event", {
        p_event_id: event.event_id,
        p_match_id: event.match_id || matchId,
        p_innings_id: event.innings_id,
        p_client_session_id: clientSessionId,
        p_event_type: event.event_type,
        p_payload: event.payload || {},
      });

      if (error) {
        if (isNetworkLikeError(error)) break;
        if (isLockConflictError(error)) {
          setScoringLocked(true);
          setErr("Pending scoring changes could not sync because another scorer session now holds the match lock.");
          break;
        }
        if (isMissingRpcError(error)) {
          setErr("Pending scoring changes cannot sync because the scoring RPC is missing from the database.");
          break;
        }

        const message = String(error?.message || error || "");
        if (isAuthoritativeScoringRejection(error)) {
          const nextQueue = removePendingEventsForInnings(pendingEventsRef.current, event.innings_id);
          setPendingEvents(nextQueue);
          await reloadCurrentInningsState(event.innings_id);
          if (event.innings_id === inningsRef.current?.id) {
            const recovery = await loadCanonicalRecoveryState(matchId, event.innings_id);
            const scorerState = restorePreferredScorerState({
              inningsId: event.innings_id,
              recoveryState: recovery.recoveryState,
              stateInvalidated: recovery.stateInvalidated,
              storedScorerState: null,
              pendingQueue: nextQueue,
            });

            setInfo(
              scorerState.invalidated
                ? "Pending local scoring changes were discarded because the server rejected them. Re-select striker, non-striker, and bowler before scoring again."
                : "Pending local scoring changes were discarded because the server rejected them. Canonical innings state was reloaded."
            );
          }
          setErr(`Pending sync failed: ${message}`);
          break;
        }

        setErr(`Pending sync failed: ${message}`);
        break;
      }

      const nextState = applyServerEventState(event, data || {});
      if (event.innings_id === inningsRef.current?.id) {
        if (nextState.invalidatesPostState) {
          clearScorerState(matchId, event.innings_id, persistenceScope);
          clearLiveSelections();
          setInfo("A pending delivery edit synced. Re-select striker, non-striker, and bowler before scoring again.");
        } else if (nextState.postState && typeof nextState.postState === "object") {
          applyRecoveredScorerState(nextState.postState);
        }
      }
      setPendingEvents((prev) => removePendingEvent(prev, event.event_id));
    }
  } finally {
    flushingQueueRef.current = false;
    setIsFlushingQueue(false);
  }
};

const acquireScorerLock = async (override = false) => {
  if (!matchId || !isOnline) return false;

  const { data, error } = await supabase.rpc("acquire_match_scorer_lock", {
    p_match_id: matchId,
    p_client_session_id: clientSessionId,
    p_override: override,
    p_device_label: deviceLabel,
  });

  if (error) {
    if (isMissingRpcError(error)) {
      setLockFeatureAvailable(false);
      setLockReady(true);
      setScoringLocked(false);
      return false;
    }

    if (!isNetworkLikeError(error)) {
      setErr(`Scorer lock error: ${error.message}`);
    }

    return false;
  }

  if (data?.ok === false && data?.locked_by_other) {
    setLockReady(false);
    setScoringLocked(true);
    setActiveScorerSession(data.active_session || null);
    return false;
  }

  setActiveScorerSession(data?.session || null);
  setScoringLocked(false);
  setLockReady(true);
  return true;
};

const takeScorerControl = async () => {
  setTakingControl(true);
  try {
    const ok = await acquireScorerLock(true);
    if (ok) {
      setInfo("Scorer control acquired for this browser session.");
      flushPendingQueue();
    }
  } finally {
    setTakingControl(false);
  }
};

const clearLocalMatchState = (resolvedMatchId = matchId) => {
  pendingEventsRef.current = [];
  setPendingEvents([]);

  if (resolvedMatchId) {
    clearPendingEvents(resolvedMatchId, persistenceScope);

    const inningsIds = [inningsRef.current?.id, innings1Row?.id, innings2RowForResult?.id].filter(Boolean);
    [...new Set(inningsIds)].forEach((inningsId) => clearScorerState(resolvedMatchId, inningsId, persistenceScope));
  }

  clearScoringSnapshot(matchSnapshotScope, persistenceScope);
};

// Load the single match row for this fixture_id
  useEffect(() => {
    let alive = true;
    const storedSnapshot = readScoringSnapshot(matchSnapshotScope, persistenceScope);

    (async () => {
      setLoading(true);
      setErr("");
      setInfo("");

      const m = await supabase
        .from("matches")
        .select(
          `
          *,
          team_a:teams!matches_team_a_id_fkey(id,name,short_name),
          team_b:teams!matches_team_b_id_fkey(id,name,short_name)
          `
        )
        // Support legacy links that used match.id in the URL as well as the newer fixture_id routing.
        .or(`fixture_id.eq.${fixtureId},id.eq.${fixtureId}`)
        .order("scheduled_at", { ascending: true, nullsFirst: false })
        .limit(1)
        .maybeSingle();

      if (!alive) return;

      if (m.error) {
        if (isNetworkLikeError(m.error) && restoreSnapshot(storedSnapshot)) {
          setLoading(false);
          return;
        }
        setErr(`Match load error: ${m.error.message}`);
        setMatch(null);
        setMatchId("");
        setLoading(false);
        return;
      }

      if (!m.data) {
        if (restoreSnapshot(storedSnapshot)) {
          setLoading(false);
          return;
        }
        setErr("No match found for this fixture.");
        setMatch(null);
        setMatchId("");
        setLoading(false);
        return;
      }

      setMatch(m.data);
      setMatchId(m.data.id);
      setInningsNo(1);
      setStrikerTurn(1);
      setNonStrikerTurn(1);

      // Use the real fixture_id when available for anything keyed by fixture_id (match_squads, fixtures grouping, etc.)
      setCanonicalFixtureId(m.data.fixture_id || m.data.id);

      // If this match has no fixture_id (older data), normalise it so all routes work consistently.
      if (!m.data.fixture_id) {
        await supabase.from("matches").update({ fixture_id: m.data.id }).eq("id", m.data.id);
      }

      const restoredQueue = readStoredPendingQueue(m.data.id);
      if (alive) {
        setPendingEvents(restoredQueue);
      }

      setLoading(false);
    })();

    return () => {
      alive = false;
    };
  }, [fixtureId]);

  // Always compute innings 1 totals for target/result
  useEffect(() => {
    if (!matchId || !match) return;

    (async () => {
      const inn1Res = await getOrCreateInnings({ matchId, inningsNo: 1, match });
      if (inn1Res.error) return;

      setInnings1Row(inn1Res.data);

      const b1 = await supabase
        .from("balls")
        .select("*")
        .eq("match_id", matchId)
        .eq("innings_id", inn1Res.data.id);
      if (b1.error) return;

      const list = b1.data || [];
      setInnings1Runs(sumRuns(list));
      setInnings1Wkts(sumWkts(list));
      setInnings1Legal(legalBallsCount(list));
    })();
  }, [matchId, match]);

  // Also compute innings 2 totals for a reliable result calculation
  useEffect(() => {
    if (!matchId || !match) return;

    (async () => {
      const inn2Res = await getOrCreateInnings({ matchId, inningsNo: 2, match });
      if (inn2Res.error) return;

      setInnings2RowForResult(inn2Res.data);

      const b2 = await supabase
        .from("balls")
        .select("*")
        .eq("match_id", matchId)
        .eq("innings_id", inn2Res.data.id);
      if (b2.error) return;

      const list = b2.data || [];
      setInnings2RunsForResult(sumRuns(list));
      setInnings2WktsForResult(sumWkts(list));
      setInnings2LegalForResult(legalBallsCount(list));
    })();
  }, [matchId, match]);

  // If innings 1 is completed, auto-jump to innings 2 (unless user already chose otherwise)
  useEffect(() => {
    if (!matchId) return;
    if (!innings1Row?.completed) return;
    if (inningsNo !== 1) return;
    setInningsNo(2);
  }, [matchId, innings1Row?.completed, inningsNo]);

  // Load selected innings
  useEffect(() => {
    if (!match) return;

    if (inningsNo === 2 && innings1Row && !innings1Row.completed) {
      setErr("You can only start Innings 2 after Innings 1 is ended/completed.");
      setInningsNo(1);
      return;
    }

    let channel;

    (async () => {
      setLoading(true);
      setErr("");
      setInfo("");
      const storedSnapshot = readScoringSnapshot(matchSnapshotScope, persistenceScope);

      clearLiveSelections();
      setNeedsWicketModal(false);
      setIncomingBatterId("");
      setDismissedPlayerId("");

      const inn = await getOrCreateInnings({ matchId, inningsNo, match });
      if (inn.error) {
        setErr(`Innings load/create error: ${inn.error.message}`);
        setLoading(false);
        return;
      }
      setInnings(inn.data);

      const batPlayersRes = await loadSquadPlayers({ fixtureId: canonicalFixtureId || fixtureId, teamId: inn.data.batting_team_id });
      if (batPlayersRes.error) {
        if (isNetworkLikeError(batPlayersRes.error) && Array.isArray(storedSnapshot?.battingPlayers)) {
          setBattingPlayers(storedSnapshot.battingPlayers);
        } else {
          setErr(`Batting roster error: ${batPlayersRes.error.message}`);
          setLoading(false);
          return;
        }
      }

      const bowlPlayersRes = await loadSquadPlayers({ fixtureId: canonicalFixtureId || fixtureId, teamId: inn.data.bowling_team_id });
      if (bowlPlayersRes.error) {
        if (isNetworkLikeError(bowlPlayersRes.error) && Array.isArray(storedSnapshot?.bowlingPlayers)) {
          setBowlingPlayers(storedSnapshot.bowlingPlayers);
        } else {
          setErr(`Bowling roster error: ${bowlPlayersRes.error.message}`);
          setLoading(false);
          return;
        }
      }

      if (!batPlayersRes.error) setBattingPlayers(batPlayersRes.data || []);
      if (!bowlPlayersRes.error) setBowlingPlayers(bowlPlayersRes.data || []);

      const b = await supabase
        .from("balls")
        .select("*")
        .eq("match_id", matchId)
        .eq("innings_id", inn.data.id)
        .order("over_no", { ascending: true })
        .order("delivery_in_over", { ascending: true });

      if (b.error) {
        if (isNetworkLikeError(b.error) && storedSnapshot?.innings?.id === inn.data.id) {
          const restoredState = replayPendingEventsOnState({
            balls: storedSnapshot.balls || [],
            innings: storedSnapshot.innings || inn.data,
            queue: pendingEventsRef.current,
            inningsId: inn.data.id,
          });

          setInnings(restoredState.innings || storedSnapshot.innings || inn.data);
          setBalls(restoredState.balls);
          setInfo("Offline snapshot restored for this innings. Pending events will sync when the network returns.");
          setLoading(false);
          return;
        }

        setErr(`Balls load error: ${b.error.message}`);
        setLoading(false);
        return;
      }

      const restoredState = replayPendingEventsOnState({
        balls: b.data || [],
        innings: inn.data,
        queue: pendingEventsRef.current,
        inningsId: inn.data.id,
      });
      const sorted = sortBallsByPosition(restoredState.balls || []);
      setInnings(restoredState.innings || inn.data);
      setBalls(sorted);
      const recovery = await loadCanonicalRecoveryState(matchId, inn.data.id);

      /* Do not reopen innings implicitly from the client.
      if (inn.data?.completed && sorted.length === 0) {
        const reopen = await supabase.from("innings").update({ completed: false }).eq("id", inn.data.id).select("*").single();
        if (!reopen.error && reopen.data) {
          setInnings(reopen.data);
        }
      } */

      if ((restoredState.innings || inn.data)?.completed && sorted.length === 0) {
        setInfo("Innings 2 is marked completed but has no balls. Click ‘Reopen innings’ to start scoring.");
      }

      const storedScorerState = readScorerState(matchId, inn.data.id, persistenceScope);
      const scorerState = restorePreferredScorerState({
        inningsId: inn.data.id,
        recoveryState: recovery.recoveryState,
        stateInvalidated: recovery.stateInvalidated,
        storedScorerState,
      });
      if (scorerState.invalidated) {
        setInfo(
          scorerState.hasPendingEvents
            ? "Pending local scoring changes were restored, but the active batter/bowler state could not be proven. Re-select them before scoring or syncing."
            : "Last delivery was edited. Re-select striker, non-striker, and bowler before scoring again."
        );
      } else if (!scorerState.restored && (scorerState.hasPendingEvents || (sorted.length && !recovery.missing))) {
        setInfo(
          scorerState.hasPendingEvents
            ? "Pending local scoring changes were restored, but the active batter/bowler state could not be proven. Re-select them before scoring or syncing."
            : "Scoring totals were recovered, but the active batter/bowler state could not be proven. Re-select them before scoring."
        );
      }

      channel = supabase
        .channel(`balls-live-score-${matchId}-${inn.data.id}`)
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "balls", filter: `innings_id=eq.${inn.data.id}` },
          (payload) => {
            if (payload.eventType === "DELETE") {
              setBalls((prev) =>
                prev.filter(
                  (ball) =>
                    ball.id !== payload.old?.id &&
                    ball.source_event_id !== payload.old?.source_event_id
                )
              );
              return;
            }

            if (!payload.new) return;
            setBalls((prev) => mergeBallIntoList(prev, payload.new));
          }
        )
        .subscribe();

      setLoading(false);
    })();

    return () => {
      if (channel) supabase.removeChannel(channel);
    };
  }, [match, matchId, inningsNo, fixtureId, canonicalFixtureId, innings1Row]);

  useEffect(() => {
    if (!innings) return;

    const runs = sumRuns(balls);
    const wkts = sumWkts(balls);
    const legal = legalBallsCount(balls);

    if (innings.innings_no === 1) {
      setInnings1Row(innings);
      setInnings1Runs(runs);
      setInnings1Wkts(wkts);
      setInnings1Legal(legal);
      return;
    }

    if (innings.innings_no === 2) {
      setInnings2RowForResult(innings);
      setInnings2RunsForResult(runs);
      setInnings2WktsForResult(wkts);
      setInnings2LegalForResult(legal);
    }
  }, [balls, innings]);

  useEffect(() => {
    ballsRef.current = balls;
  }, [balls]);

  useEffect(() => {
    inningsRef.current = innings;
  }, [innings]);

  useEffect(() => {
    strikerIdRef.current = strikerId;
    nonStrikerIdRef.current = nonStrikerId;
    strikerTurnRef.current = strikerTurn;
    nonStrikerTurnRef.current = nonStrikerTurn;
    bowlerIdRef.current = bowlerId;
  }, [bowlerId, nonStrikerId, nonStrikerTurn, strikerId, strikerTurn]);

  useEffect(() => {
    pendingEventsRef.current = pendingEvents;
    if (matchId) {
      writePendingEvents(matchId, pendingEvents, persistenceScope);
    }
  }, [matchId, pendingEvents, persistenceScope]);

  useEffect(() => {
    savingRef.current = saving;
  }, [saving]);

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  useEffect(() => {
    if (!matchId || !match) return;

    writeScoringSnapshot(matchSnapshotScope, {
      match,
      matchId,
      canonicalFixtureId,
      inningsNo,
      innings,
      innings1Row,
      innings1Runs,
      innings1Wkts,
      innings1Legal,
      innings2RowForResult,
      innings2RunsForResult,
      innings2WktsForResult,
      innings2LegalForResult,
      balls,
      battingPlayers,
      bowlingPlayers,
      strikerId,
      nonStrikerId,
      strikerTurn,
      nonStrikerTurn,
      bowlerId,
      needsNextBowler,
      lockReady,
      lockFeatureAvailable,
      pendingEvents,
    }, persistenceScope);
  }, [
    balls,
    battingPlayers,
    bowlingPlayers,
    bowlerId,
    canonicalFixtureId,
    innings,
    innings1Legal,
    innings1Row,
    innings1Runs,
    innings1Wkts,
    innings2LegalForResult,
    innings2RowForResult,
    innings2RunsForResult,
    innings2WktsForResult,
    inningsNo,
    match,
    matchId,
    matchSnapshotScope,
    persistenceScope,
    needsNextBowler,
    nonStrikerId,
    nonStrikerTurn,
    lockFeatureAvailable,
    lockReady,
    pendingEvents,
    strikerId,
    strikerTurn,
  ]);

  useEffect(() => {
    if (!matchId || !lockFeatureAvailable || !isOnline) return;
    acquireScorerLock(false);
  }, [isOnline, lockFeatureAvailable, matchId]);

  useEffect(() => {
    if (!matchId || !lockFeatureAvailable || !lockReady || scoringLocked || !isOnline) return;

    const intervalId = window.setInterval(async () => {
      const { data, error } = await supabase.rpc("heartbeat_match_scorer_lock", {
        p_match_id: matchId,
        p_client_session_id: clientSessionId,
      });

      if (error) {
        if (isMissingRpcError(error)) {
          setLockFeatureAvailable(false);
        } else if (!isNetworkLikeError(error)) {
          setErr(`Scorer heartbeat error: ${error.message}`);
        }
        return;
      }

      if (data?.has_lock === false) {
        setScoringLocked(true);
        setLockReady(false);
      }
    }, 15000);

    return () => window.clearInterval(intervalId);
  }, [clientSessionId, isOnline, lockFeatureAvailable, lockReady, matchId, scoringLocked]);

  useEffect(() => {
    return () => {
      if (!matchId || !lockFeatureAvailable || !lockReady) return;
      supabase.rpc("release_match_scorer_lock", {
        p_match_id: matchId,
        p_client_session_id: clientSessionId,
      });
    };
  }, [clientSessionId, lockFeatureAvailable, lockReady, matchId]);

  useEffect(() => {
    if (!isOnline || !pendingEvents.length) return;
    flushPendingQueue();
  }, [isOnline, pendingEvents.length, matchId, lockFeatureAvailable, lockReady, scoringLocked]);

  useEffect(() => {
    if (!matchId || !innings?.id) return;
    writeScorerState(matchId, innings.id, {
      strikerId,
      nonStrikerId,
      strikerTurn,
      nonStrikerTurn,
      bowlerId,
      needsNextBowler,
    }, persistenceScope);
  }, [bowlerId, innings?.id, matchId, needsNextBowler, nonStrikerId, nonStrikerTurn, persistenceScope, strikerId, strikerTurn]);

  // Batting order (for scorecard)
  const battingOrderIds = useMemo(() => {
    const order = [];
    const seen = new Set();
    const push = (id) => {
      if (!id) return;
      if (seen.has(id)) return;
      seen.add(id);
      order.push(id);
    };

    balls.forEach((b) => {
      push(b.striker_id);
      push(b.non_striker_id);
    });

    push(strikerId);
    push(nonStrikerId);

    return order;
  }, [balls, strikerId, nonStrikerId]);

  
// Batting scorecard rows:
// - Show EACH batting stint separately using balls.batting_turn (1st time batting, 2nd time, etc.)
// - This makes the scorer view behave correctly when a player bats again: their stint score starts at 0.
const battingScorecardRows = useMemo(() => {
  const rows = [];

  const ordinal = (n) => {
    const x = Number(n);
    if (!Number.isFinite(x) || x <= 0) return "";
    if (x === 1) return "";
    if (x === 2) return " (2nd)";
    if (x === 3) return " (3rd)";
    return ` (${x}th)`;
  };

  // Determine which (player,turn) appearances exist in this innings.
  const appearances = [];
  const seen = new Set();

  const pushAppearance = (playerId, turn) => {
    if (!playerId) return;
    const t = toInt(turn, 1) || 1;
    const key = `${playerId}:${t}`;
    if (seen.has(key)) return;
    seen.add(key);
    appearances.push({ playerId, turn: t });
  };

  // Preserve natural order from balls + current crease.
  balls.forEach((b) => {
    pushAppearance(b.striker_id, b.batting_turn || 1);
    // Note: non-striker turn is not stored on the ball; we'll infer their current turn from dismissals map if needed.
    pushAppearance(b.non_striker_id, (dismissalsByBatter.get(b.non_striker_id) || 0) + 1);
  });

  // Ensure current crease stints are always included.
  pushAppearance(strikerId, strikerTurn);
  pushAppearance(nonStrikerId, nonStrikerTurn);

  for (const ap of appearances) {
    const p = battingPlayers.find((x) => x.id === ap.playerId);
    if (!p) continue;

    const facedAsStriker = balls.filter((b) => b.striker_id === ap.playerId && toInt(b.batting_turn, 1) === ap.turn);
    const ballsFaced = facedAsStriker.filter((b) => didBatterFaceBall(b)).length;
    const runs = facedAsStriker.reduce((acc, b) => acc + (b.runs_off_bat || 0), 0);
    const fours = facedAsStriker.filter((b) => (b.runs_off_bat || 0) === 4).length;
    const sixes = facedAsStriker.filter((b) => (b.runs_off_bat || 0) === 6).length;
    const sr = ballsFaced > 0 ? ((runs / ballsFaced) * 100).toFixed(1) : "0.0";

    const atCreaseThisStint =
      (ap.playerId === strikerId && ap.turn === strikerTurn) || (ap.playerId === nonStrikerId && ap.turn === nonStrikerTurn);

    const dismissals = dismissalsByBatter.get(ap.playerId) || 0;
    const stintOut = dismissals >= ap.turn && !atCreaseThisStint;

    const status = atCreaseThisStint
      ? "Not out"
      : stintOut
        ? "Out x1"
        : ballsFaced > 0
          ? "Not out"
          : "—";

    rows.push({
      key: `${ap.playerId}:${ap.turn}`,
      id: ap.playerId,
      turn: ap.turn,
      name: `${p.name}${ordinal(ap.turn)}`,
      runs,
      balls: ballsFaced,
      fours,
      sixes,
      sr,
      isAtCrease: atCreaseThisStint,
      dismissals,
      status,
    });
  }

  // Only show stints that have started or are currently at the crease.
  return rows.filter((r) => r.isAtCrease || r.balls > 0);
}, [battingPlayers, balls, strikerId, nonStrikerId, strikerTurn, nonStrikerTurn, dismissalsByBatter]);

  const canScoreLegacy = () => {
    if (!innings?.id) return { ok: false, msg: "Innings not loaded." };

    if (inningsComplete) return { ok: false, msg: "Innings complete." };
    if (saving) return { ok: false, msg: "Saving…" };

    if (!strikerId || !nonStrikerId) return { ok: false, msg: "Select striker and non-striker." };
    if (strikerId === nonStrikerId) return { ok: false, msg: "Striker and non-striker must be different." };

    if (!bowlerId) return { ok: false, msg: "Select current bowler." };

    // New over: enforce "no same bowler two overs in a row" + 4-over cap
    if (nextPos.newOver) {
      if (bowlerId === lastOverBowlerId && lastOverBowlerId) {
        return { ok: false, msg: "Bowler cannot bowl two overs in a row. Choose a different bowler." };
      }
      const legalBowled = countLegalBallsBowledBy(balls, bowlerId);
      if (legalBowled >= 24) {
        return { ok: false, msg: "That bowler has already bowled 4 overs (24 legal balls)." };
      }
    } else {
      // Mid-over: bowler cannot change
      const last = balls[balls.length - 1];
      if (last?.bowler_id && bowlerId !== last.bowler_id) {
        return { ok: false, msg: "Bowler cannot change mid-over." };
      }
    }

    return { ok: true, msg: "" };
  };

  const canScore = () => {
    const currentInnings = inningsRef.current;
    const currentBalls = ballsRef.current;
    const currentStrikerId = strikerIdRef.current;
    const currentNonStrikerId = nonStrikerIdRef.current;
    const currentBowlerId = bowlerIdRef.current;
    const currentNextPos = computeNextPosition(currentBalls);
    const currentLastOverBowlerId = currentBalls[currentBalls.length - 1]?.bowler_id || "";
    const currentChaseComplete =
      currentInnings?.innings_no === 2 &&
      !!innings1Row?.completed &&
      sumRuns(currentBalls) >= (toInt(innings1Runs, 0) + 1);
    const currentInningsComplete =
      legalBallsCount(currentBalls) >= maxLegal
      || sumWkts(currentBalls) >= wicketCap
      || currentChaseComplete
      || !!currentInnings?.completed;

    if (!currentInnings?.id) return { ok: false, msg: "Innings not loaded." };
    if (lockFeatureAvailable && scoringLocked) return { ok: false, msg: "Scoring is locked by another active scorer session." };
    if (!isOnline && lockFeatureAvailable && !lockReady) {
      return { ok: false, msg: "Cannot score offline before the scorer lock has been acquired at least once." };
    }

    if (currentInningsComplete) return { ok: false, msg: "Innings complete." };
    if (savingRef.current) return { ok: false, msg: "Saving..." };

    if (!currentStrikerId || !currentNonStrikerId) return { ok: false, msg: "Select striker and non-striker." };
    if (currentStrikerId === currentNonStrikerId) return { ok: false, msg: "Striker and non-striker must be different." };

    if (!currentBowlerId) return { ok: false, msg: "Select current bowler." };

    if (currentNextPos.newOver) {
      if (currentBowlerId === currentLastOverBowlerId && currentLastOverBowlerId) {
        return { ok: false, msg: "Bowler cannot bowl two overs in a row. Choose a different bowler." };
      }

      const legalBowled = countLegalBallsBowledBy(currentBalls, currentBowlerId);
      if (legalBowled >= 24) {
        return { ok: false, msg: "That bowler has already bowled 4 overs (24 legal balls)." };
      }
    } else {
      const last = currentBalls[currentBalls.length - 1];
      if (last?.bowler_id && currentBowlerId !== last.bowler_id) {
        return { ok: false, msg: "Bowler cannot change mid-over." };
      }
    }

    return { ok: true, msg: "" };
  };

  const insertBall = async ({
    runs_off_bat = 0,
    extra_type = null,
    extra_runs = null,
    wicket = false,
    dismissal_kind = null,
    dismissed_player_id = null, // ✅ NEW
    postStateOverride = null,
  }) => {
    setErr("");
    setInfo("");

    const ok = canScore();
    if (!ok.ok) {
      setErr(ok.msg);
      return { overFinishedAfter: false, saved: false };
    }

    savingRef.current = true;
    setSaving(true);

    try {
      const currentBalls = ballsRef.current;
      const currentInnings = inningsRef.current;
      const currentStrikerId = strikerIdRef.current;
      const currentNonStrikerId = nonStrikerIdRef.current;
      const currentBowlerId = bowlerIdRef.current;
      const currentLegalBalls = legalBallsCount(currentBalls);
      const pos = computeNextPosition(currentBalls);

      const overCountsBefore = getOverCounts(currentBalls, pos.over_no);
      const overAlreadyHadIllegal = !!overCountsBefore?.hasIllegal;

      let extra_runs_calc = 0;
      let legal_ball = true;

      if (extra_type === "wide") {
        extra_runs_calc = Math.max(2, toInt(extra_runs ?? 2, 2));
        runs_off_bat = 0;
        legal_ball = overAlreadyHadIllegal ? true : false;
      } else if (extra_type === "noball") {
        extra_runs_calc = Math.max(1, toInt(extra_runs ?? 1, 1));
        legal_ball = overAlreadyHadIllegal ? true : false;
      } else if (extra_type === "bye" || extra_type === "legbye") {
        extra_runs_calc = Math.max(0, toInt(extra_runs ?? 0, 0));
        legal_ball = true;
        runs_off_bat = 0;
      } else {
        extra_runs_calc = 0;
        legal_ball = true;
      }

      if (legal_ball && currentLegalBalls + 1 > maxLegal) {
        setErr(`Cannot add: overs limit reached (${oversLimit} overs).`);
        return { overFinishedAfter: false, saved: false };
      }

      if (legal_ball) {
        const legalBowled = countLegalBallsBowledBy(currentBalls, currentBowlerId);
        if (legalBowled + 1 > 24) {
          setErr("That bowler would exceed 4 overs (24 legal balls). Choose another bowler.");
          return { overFinishedAfter: false, saved: false };
        }
      }

      // batting_turn tracks the STRIKER's current batting stint in this innings (1 = first time batting, 2 = second, etc.)
      // IMPORTANT: even if the NON-STRIKER is dismissed (run out), batting_turn still belongs to the striker's stint.
      const prevDismissals = currentStrikerId
        ? currentBalls.filter((ball) => ball.wicket && ball.dismissed_player_id === currentStrikerId).length
        : 0;
      const batting_turn = prevDismissals + 1;

      const payload = {
  match_id: matchId,
  innings_id: currentInnings.id,
  over_no: pos.over_no,
  delivery_in_over: pos.delivery_in_over,
  legal_ball,
  runs_off_bat: toInt(runs_off_bat, 0),
  extra_type,
  extra_runs: extra_runs_calc,
  wicket,
  dismissal_kind: wicket ? dismissal_kind : null,

  // ✅ CRITICAL FIX: store the ACTUAL dismissed player (can be striker OR non-striker)
  dismissed_player_id: wicket ? (dismissed_player_id || currentStrikerId) : null,

  striker_id: currentStrikerId,
  non_striker_id: currentNonStrikerId,
  bowler_id: currentBowlerId,
  batting_turn,
};

      const previewEvent = {
        created_at: new Date().toISOString(),
        event_id: "preview-ball",
        event_type: "add_ball",
        innings_id: currentInnings.id,
        match_id: matchId,
        payload: {
          ball: payload,
        },
      };

      const nextBalls = applyEventOptimistically({
        balls: currentBalls,
        innings: currentInnings,
        event: previewEvent,
      }).balls;

      const totalRunsOnBall = (payload.runs_off_bat || 0) + (payload.extra_runs || 0);
      let nextStrikerId = currentStrikerId;
      let nextNonStrikerId = currentNonStrikerId;

      if (!payload.wicket && totalRunsOnBall % 2 === 1) {
        [nextStrikerId, nextNonStrikerId] = [nextNonStrikerId, nextStrikerId];
      }

      const overCountsAfter = getOverCounts(nextBalls, payload.over_no);
      const overFinishedAfter = isOverFinished(overCountsAfter);
      const projectedRuns = sumRuns(nextBalls);
      const projectedWickets = sumWkts(nextBalls);
      const projectedLegalBalls = legalBallsCount(nextBalls);
      const projectedChaseComplete =
        currentInnings?.innings_no === 2 &&
        !!innings1Row?.completed &&
        projectedRuns >= (toInt(innings1Runs, 0) + 1);
      const projectedInningsComplete =
        projectedLegalBalls >= maxLegal
        || projectedWickets >= wicketCap
        || projectedChaseComplete
        || !!currentInnings?.completed;
      let nextBowlerId = currentBowlerId;
      let nextNeedsNextBowler = false;

      if (!payload.wicket && overFinishedAfter && !projectedInningsComplete) {
        [nextStrikerId, nextNonStrikerId] = [nextNonStrikerId, nextStrikerId];
        nextBowlerId = "";
        nextNeedsNextBowler = true;
      }

      const postState = postStateOverride || buildScorerPostState({
        strikerId: nextStrikerId,
        nonStrikerId: nextNonStrikerId,
        strikerTurn: getTurnFor(nextStrikerId),
        nonStrikerTurn: getTurnFor(nextNonStrikerId),
        bowlerId: nextBowlerId,
        needsNextBowler: nextNeedsNextBowler,
      });

      const event = {
        created_at: new Date().toISOString(),
        event_id: createEventId("ball"),
        event_type: "add_ball",
        innings_id: currentInnings.id,
        match_id: matchId,
        payload: {
          ball: payload,
          post_state: postState,
        },
      };

      await applySessionEvent(event, {
        failurePrefix: "Ball save",
        successInfo: "Saved ✅",
      });

      

      if (!payload.wicket) {
        setStrikerSelection(postState.striker_id || "");
        setNonStrikerSelection(postState.non_striker_id || "");
        setBowlerId(postState.bowler_id || "");
        setNeedsNextBowler(!!postState.needs_next_bowler);
      }

      if (postState.needs_next_bowler) {
        setInfo("Over complete - select a new bowler.");
      }

      if (!postState.needs_next_bowler && !overFinishedAfter) setInfo("Saved.");

      return { overFinishedAfter, postState, saved: true };
    } catch {
      return { overFinishedAfter: false, postState: null, saved: false };
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const addRun = (n) => insertBall({ runs_off_bat: n, extra_type: null, wicket: false });
  const addWide = (totalWideRuns = 2) =>
    insertBall({ runs_off_bat: 0, extra_type: "wide", extra_runs: totalWideRuns, wicket: false });
  const addNoBall = (batRuns = 0) =>
    insertBall({ runs_off_bat: batRuns, extra_type: "noball", extra_runs: 1, wicket: false });
  const addBye = (n) => insertBall({ runs_off_bat: 0, extra_type: "bye", extra_runs: n, wicket: false });
  const addLegBye = (n) => insertBall({ runs_off_bat: 0, extra_type: "legbye", extra_runs: n, wicket: false });

  const addWicket = async () => {
    const currentNextPos = computeNextPosition(ballsRef.current);
    const simulated = {
      deliveries: currentNextPos.counts.deliveries + 1,
      legal: currentNextPos.counts.legal + 1,
      hasIllegal: currentNextPos.counts.hasIllegal,
    };
    const wouldFinish = isOverFinished(simulated);

    setWicketEndedOver(wouldFinish);
    setWicketCrossed(false);
    setIncomingBatterId("");
    setDismissalKind("bowled");

    // ✅ Default: striker is out
    setDismissedPlayerId(strikerId || "");

    setNeedsWicketModal(true);
  };

  // Incoming batters:
  // - allow ANY squad player not currently at crease (even if dismissed before),
  //   because players may bat twice under wicket cap rule.
  const availableIncomingBatters = useMemo(() => {
    return battingPlayers.filter((p) => p.id !== strikerId && p.id !== nonStrikerId);
  }, [battingPlayers, strikerId, nonStrikerId]);

  const confirmWicket = async () => {
    if (!incomingBatterId) {
      setErr("Select the incoming batter.");
      return;
    }
    if (!dismissedPlayerId) {
      setErr("Select who was dismissed (striker/non-striker).");
      return;
    }
    if (dismissedPlayerId !== strikerId && dismissedPlayerId !== nonStrikerId) {
      setErr("Dismissed player must be striker or non-striker.");
      return;
    }

    const outWasStriker = dismissedPlayerId === strikerId;
    const survivor = outWasStriker ? nonStrikerId : strikerId;
    const crossedApplies = wicketCrossed && outWasStriker;
    const projectedLegalBalls = legalBallsCount(ballsRef.current) + 1;
    const projectedWickets = sumWkts(ballsRef.current) + 1;
    const projectedRuns = sumRuns(ballsRef.current);
    const projectedChaseComplete =
      inningsRef.current?.innings_no === 2 &&
      !!innings1Row?.completed &&
      projectedRuns >= (toInt(innings1Runs, 0) + 1);
    const projectedInningsComplete =
      projectedLegalBalls >= maxLegal
      || projectedWickets >= wicketCap
      || projectedChaseComplete
      || !!inningsRef.current?.completed;

    let nextStrikerId = strikerId;
    let nextNonStrikerId = nonStrikerId;
    let nextBowlerId = bowlerId;
    let nextNeedsNextBowler = false;

    if (wicketEndedOver && !projectedInningsComplete) {
      if (crossedApplies) {
        nextStrikerId = survivor;
        nextNonStrikerId = incomingBatterId;
      } else {
        nextStrikerId = incomingBatterId;
        nextNonStrikerId = survivor;
      }
      nextBowlerId = "";
      nextNeedsNextBowler = true;
    } else if (outWasStriker) {
      if (crossedApplies) {
        nextStrikerId = survivor;
        nextNonStrikerId = incomingBatterId;
      } else {
        nextStrikerId = incomingBatterId;
        nextNonStrikerId = survivor;
      }
    } else {
      nextStrikerId = strikerId;
      nextNonStrikerId = incomingBatterId;
    }

    const wicketPostState = buildScorerPostState({
      strikerId: nextStrikerId,
      nonStrikerId: nextNonStrikerId,
      strikerTurn: getTurnFor(nextStrikerId),
      nonStrikerTurn: getTurnFor(nextNonStrikerId),
      bowlerId: nextBowlerId,
      needsNextBowler: nextNeedsNextBowler,
    });

    const { postState, saved } = await insertBall({
      runs_off_bat: 0,
      extra_type: null,
      wicket: true,
      dismissal_kind: dismissalKind,
      dismissed_player_id: dismissedPlayerId,
      postStateOverride: wicketPostState,
    });

    if (!saved) return;

    setNeedsWicketModal(false);

    const resolvedPostState = postState || wicketPostState;
    setStrikerSelection(resolvedPostState.striker_id || "");
    setNonStrikerSelection(resolvedPostState.non_striker_id || "");
    setBowlerId(resolvedPostState.bowler_id || "");
    setNeedsNextBowler(!!resolvedPostState.needs_next_bowler);

    if (resolvedPostState.needs_next_bowler) {
      // End of over + wicket: apply "crossed?" + force new bowler
      setInfo("Over complete - select a new bowler.");

    }
  };

  const endInnings = async () => {
    if (!innings?.id) return;
    setErr("");
    setInfo("");
    savingRef.current = true;
    setSaving(true);
    try {
      await applySessionEvent(
        {
          created_at: new Date().toISOString(),
          event_id: createEventId("end-innings"),
          event_type: "end_innings",
          innings_id: innings.id,
          match_id: matchId,
          payload: {},
        },
        {
          failurePrefix: "End innings",
          successInfo: "Innings ended ✅",
          optimisticQueuedInfo: "Offline: innings end queued locally.",
        }
      );
      setInfo("Innings ended ✅");
      if (inningsNo === 1) {
        setInningsNo(2);
      }
    } catch {
      return;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const reopenInnings = async () => {
    if (!innings?.id) return;
    setErr("");
    setInfo("");
    savingRef.current = true;
    setSaving(true);
    try {
      await applySessionEvent(
        {
          created_at: new Date().toISOString(),
          event_id: createEventId("reopen-innings"),
          event_type: "reopen_innings",
          innings_id: innings.id,
          match_id: matchId,
          payload: {},
        },
        {
          failurePrefix: "Reopen innings",
          successInfo: "Innings reopened ✅",
          optimisticQueuedInfo: "Offline: innings reopen queued locally.",
        }
      );
      setInfo("Innings reopened ✅");
    } catch {
      return;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  // Innings auto-completion is handled by the scoring RPC so reopen/edit flows do not double-end innings.

  // Scorer-only: reset the match so you can test scoring again
  const resetMatchData = async () => {
    if (!match?.id) return;

    const label = `${match?.team_a?.short_name || match?.team_a?.name || "Team A"} vs ${match?.team_b?.short_name || match?.team_b?.name || "Team B"}`;
    const ok = window.confirm(
      `Reset match data for: ${label}?

This will delete ALL balls + innings for this match, clear any selected playing XIs (match_squads), and set the match back to SCHEDULED.

You can then start scoring again from ball 1.`
    );
    if (!ok) return;

    setSaving(true);
    setErr("");
    setInfo("");

    const legacyResetMatchData = async () => {
      const delBalls = await supabase.from("balls").delete().eq("match_id", match.id);
      if (delBalls.error) {
        throw new Error(`Reset failed (balls): ${delBalls.error.message}`);
      }

      const delInn = await supabase.from("innings").delete().eq("match_id", match.id);
      if (delInn.error) {
        throw new Error(`Reset failed (innings): ${delInn.error.message}`);
      }

      const fid = canonicalFixtureId || fixtureId;
      if (fid) {
        const delSq = await supabase.from("match_squads").delete().eq("fixture_id", fid);
        if (delSq.error) console.warn("Reset: match_squads delete blocked", delSq.error.message);
      }

      const upd = await supabase.from("matches").update({ status: "scheduled", wicket_cap: null }).eq("id", match.id);
      if (upd.error) {
        throw new Error(`Reset failed (match): ${upd.error.message}`);
      }
    };

    try {
      const { error } = await supabase.rpc("reset_match_state", {
        p_match_id: match.id,
        p_client_session_id: clientSessionId,
        p_clear_squads: true,
      });

      if (error) {
        if (isMissingRpcError(error)) {
          await legacyResetMatchData();
        } else {
          throw new Error(`Reset failed: ${error.message}`);
        }
      }

      clearLocalMatchState(match.id);
      window.location.reload();
    } catch (error) {
      setErr(String(error?.message || error || "Reset failed."));
      setSaving(false);
      return;
    }

    setSaving(false);
  };

  // Bowling overview
  const bowlingOverviewRows = useMemo(() => {
    const byBowler = new Map();

    const ensure = (id) => {
      if (!id) return null;
      if (!byBowler.has(id)) byBowler.set(id, { legalBalls: 0, runs: 0, wickets: 0, perOver: new Map() });
      return byBowler.get(id);
    };

    balls.forEach((b) => {
      const s = ensure(b.bowler_id);
      if (!s) return;

      if (b.legal_ball) s.legalBalls += 1;
        s.runs += runsConcededByBowler(b);
      if (b.wicket) s.wickets += 1;

      const overNo = toInt(b.over_no, 0);
      if (!s.perOver.has(overNo)) s.perOver.set(overNo, { deliveries: 0, legal: 0, runs: 0 });
      const o = s.perOver.get(overNo);
      o.deliveries += 1;
      if (b.legal_ball) o.legal += 1;
        o.runs += runsConcededByBowler(b);
    });

    const rows = [];
    bowlingPlayers.forEach((p) => {
      const s = byBowler.get(p.id);
      if (!s) return;

      let maidens = 0;
      s.perOver.forEach((o) => {
        const finished = o.legal >= 6;
        if (finished && o.runs === 0) maidens += 1;
      });

      const oversFull = Math.floor(s.legalBalls / 6);
      const ballsIn = s.legalBalls % 6;
      const oversText = `${oversFull}.${ballsIn}`;

      const oversAsFloat = s.legalBalls / 6;
      const econ = oversAsFloat > 0 ? (s.runs / oversAsFloat).toFixed(2) : "0.00";

      rows.push({ id: p.id, name: p.name, oversText, maidens, runs: s.runs, wickets: s.wickets, econ });
    });

    rows.sort((a, b) => {
      if (b.wickets !== a.wickets) return b.wickets - a.wickets;
      return Number(a.econ) - Number(b.econ);
    });

    return rows;
  }, [balls, bowlingPlayers]);

  const currentBowlerRow = useMemo(() => {
    return bowlingOverviewRows.find((r) => r.id === bowlerId) || null;
  }, [bowlingOverviewRows, bowlerId]);

  const keyBtnStyle = {
    padding: "14px 10px",
    borderRadius: 16,
    border: "1px solid rgba(255,255,255,0.14)",
    background: "rgba(255,255,255,0.06)",
    color: "#e8eefc",
    fontWeight: 900,
    cursor: "pointer",
  };

  const modalSelectStyle = {
    width: "100%",
    padding: 10,
    borderRadius: 12,
    background: "rgba(255,255,255,0.06)",
    border: "1px solid rgba(255,255,255,0.14)",
    color: "#e8eefc",
    fontWeight: 800,
    colorScheme: "dark",
  };

  const selectStyle = {
    width: "100%",
    padding: 10,
    borderRadius: 12,
    background: "rgba(255,255,255,0.06)",
    border: "1px solid rgba(255,255,255,0.12)",
    color: "#e8eefc",
    colorScheme: "dark",
  };

  const modalInputStyle = {
    width: "100%",
    padding: 10,
    borderRadius: 12,
    background: "rgba(255,255,255,0.06)",
    border: "1px solid rgba(255,255,255,0.14)",
    color: "#e8eefc",
  };

  const modalBtnGhost = {
    padding: "10px 12px",
    borderRadius: 12,
    background: "rgba(255,255,255,0.06)",
    border: "1px solid rgba(255,255,255,0.14)",
    color: "#e8eefc",
    fontWeight: 900,
    cursor: "pointer",
  };

  const modalBtnPrimary = {
    padding: "10px 12px",
    borderRadius: 12,
    background: "rgba(255,255,255,0.10)",
    border: "1px solid rgba(255,255,255,0.18)",
    color: "#e8eefc",
    fontWeight: 900,
    cursor: "pointer",
  };

  if (loading) return <div>Loading...</div>;

  return (
    <div style={{ minHeight: "100vh", background: "linear-gradient(180deg,#0b1220,#060a12)", color: "#e8eefc" }}>
      {/* Top bar */}
      <div
        style={{
          position: "sticky",
          top: 0,
          zIndex: 20,
          backdropFilter: "blur(10px)",
          background: "rgba(10,16,28,0.72)",
          borderBottom: "1px solid rgba(255,255,255,0.08)",
        }}
      >
        <div style={{ maxWidth: 980, margin: "0 auto", padding: "12px 14px", display: "flex", gap: 12, alignItems: "center" }}>
          <Link to="/score" style={{ color: "#cfe0ff", textDecoration: "none", fontWeight: 700 }}>
            ← Scoring Home
          </Link>
          <div style={{ marginLeft: "auto", display: "flex", gap: 10, alignItems: "center" }}>
            <Link
              to={`/match/${fixtureId}`}
              style={{
                color: "#cfe0ff",
                textDecoration: "none",
                fontWeight: 700,
                padding: "8px 10px",
                borderRadius: 999,
                border: "1px solid rgba(255,255,255,0.14)",
                background: "rgba(255,255,255,0.04)",
              }}
            >
              Spectator
            </Link>
          </div>
        </div>
      </div>

      <div style={{ maxWidth: 980, margin: "0 auto", padding: "14px 14px calc(260px + env(safe-area-inset-bottom))" }}>
        {err && (
          <div
            style={{
              marginTop: 10,
              padding: 10,
              borderRadius: 12,
              background: "rgba(255, 0, 0, 0.08)",
              border: "1px solid rgba(255,0,0,0.25)",
              color: "#ffd6d6",
            }}
          >
            {err}
          </div>
        )}

        {info && (
          <div
            style={{
              marginTop: 10,
              padding: 10,
              borderRadius: 12,
              background: "rgba(0, 200, 120, 0.10)",
              border: "1px solid rgba(0,200,120,0.25)",
              color: "#d8ffee",
            }}
          >
            {info}
          </div>
        )}

        {(!isOnline || pendingEvents.length || isFlushingQueue || scoringLocked) && (
          <div
            style={{
              marginTop: 10,
              padding: 10,
              borderRadius: 12,
              background: "rgba(255, 204, 102, 0.10)",
              border: "1px solid rgba(255,204,102,0.25)",
              color: "#ffe4b0",
              display: "flex",
              gap: 10,
              alignItems: "center",
              flexWrap: "wrap",
            }}
          >
            <div style={{ fontWeight: 900 }}>
              {!isOnline ? "Offline" : scoringLocked ? "Scoring locked" : isFlushingQueue ? "Syncing" : "Pending sync"}
            </div>
            {!isOnline ? <div>{pendingEvents.length} queued event{pendingEvents.length === 1 ? "" : "s"} will replay when online.</div> : null}
            {isOnline && pendingEvents.length ? <div>{pendingEvents.length} queued event{pendingEvents.length === 1 ? "" : "s"} waiting to sync.</div> : null}
            {scoringLocked && activeScorerSession ? (
              <div>
                Active session: {activeScorerSession.device_label || activeScorerSession.client_session_id || "another browser"}
              </div>
            ) : null}
            {scoringLocked ? (
              <button onClick={takeScorerControl} disabled={takingControl || !isOnline} style={modalBtnGhost}>
                {takingControl ? "Taking control..." : "Take control"}
              </button>
            ) : null}
          </div>
        )}

        {/* Score header */}
        <div
          style={{
            marginTop: 12,
            padding: 14,
            borderRadius: 16,
            border: "1px solid rgba(255,255,255,0.10)",
            background: "rgba(255,255,255,0.04)",
            boxShadow: "0 10px 30px rgba(0,0,0,0.25)",
          }}
        >
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <div style={{ fontSize: 34, fontWeight: 900, letterSpacing: -0.5 }}>
              {totalRuns}/{wickets}
              <span style={{ fontSize: 14, fontWeight: 700, marginLeft: 10, color: "rgba(232,238,252,0.75)" }}>
                ({oversText} / {oversLimit} ov) • 7-ball overs rule • Wicket cap {wicketCap}
              </span>
            </div>

            <div style={{ marginLeft: "auto", display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <div style={{ fontSize: 13, color: "rgba(232,238,252,0.75)" }}>
                CRR <span style={{ fontWeight: 900, color: "#e8eefc" }}>{currentRR}</span>
              </div>

              {inningsNo === 2 ? (
                <>
                  <div style={{ fontSize: 13, color: "rgba(232,238,252,0.75)" }}>
                    Target <span style={{ fontWeight: 900, color: "#e8eefc" }}>{target}</span>
                  </div>
                  <div style={{ fontSize: 13, color: "rgba(232,238,252,0.75)" }}>
                    Need <span style={{ fontWeight: 900, color: "#e8eefc" }}>{runsRemaining}</span> in{" "}
                    <span style={{ fontWeight: 900, color: "#e8eefc" }}>{ballsRemaining}</span>
                  </div>
                  <div style={{ fontSize: 13, color: "rgba(232,238,252,0.75)" }}>
                    RRR <span style={{ fontWeight: 900, color: "#e8eefc" }}>{requiredRR}</span>
                  </div>
                </>
              ) : null}
            </div>
          </div>

          {resultText ? <div style={{ marginTop: 10, fontWeight: 900, color: "#ffe4b0" }}>{resultText}</div> : null}

          {inningsNo === 2 ? (
            <div style={{ marginTop: 8, color: "rgba(232,238,252,0.70)", fontWeight: 700 }}>
              Innings 1: <span style={{ fontWeight: 900, color: "#e8eefc" }}>{innings1Runs}/{innings1Wkts}</span>{" "}
              <span style={{ color: "rgba(232,238,252,0.60)" }}>({oversTextFromLegal(innings1Legal)} ov)</span>
            </div>
          ) : null}

          <div style={{ marginTop: 12, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <div style={{ fontWeight: 900, color: "rgba(232,238,252,0.75)" }}>Innings</div>
            <select
              value={inningsNo}
              onChange={(e) => setInningsNo(Number(e.target.value))}
              onFocus={(e) => e.target.scrollIntoView({ block: "center", behavior: "smooth" })} style={{
                padding: 10,
                borderRadius: 12,
                background: "rgba(255,255,255,0.06)",
                border: "1px solid rgba(255,255,255,0.12)",
                color: "#e8eefc",
                colorScheme: "dark",
              }}
            >
              <option value={1}>Innings 1 — {(match?.team_a?.short_name || match?.team_a?.name || "Team A")} batting</option>
              <option value={2}>Innings 2 — {(match?.team_b?.short_name || match?.team_b?.name || "Team B")} batting</option>
            </select>

            {innings?.completed ? (
              <span style={{ fontWeight: 900, color: "#ffb3b3" }}>Completed</span>
            ) : (
              <span style={{ fontWeight: 700, color: "rgba(232,238,252,0.65)" }}>Live scoring</span>
            )}

            <div style={{ marginLeft: "auto", display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button
                onClick={resetMatchData}
                disabled={saving}
                style={{
                  padding: "10px 12px",
                  borderRadius: 12,
                  background: "rgba(239, 68, 68, 0.14)",
                  border: "1px solid rgba(239,68,68,0.30)",
                  color: "#fecaca",
                  fontWeight: 900,
                  cursor: "pointer",
                }}
                title="Scorer only: wipe balls/innings and set match back to scheduled"
              >
                Reset match
              </button>

              {innings?.completed ? (
                <button onClick={reopenInnings} disabled={saving} style={modalBtnGhost}>
                  Reopen innings
                </button>
              ) : (
                <button
                  onClick={endInnings}
                  disabled={saving}
                  style={{
                    padding: "10px 12px",
                    borderRadius: 12,
                    background: "rgba(255, 204, 102, 0.14)",
                    border: "1px solid rgba(255,204,102,0.30)",
                    color: "#ffe4b0",
                    fontWeight: 900,
                    cursor: "pointer",
                  }}
                >
                  End innings
                </button>
              )}
            </div>
          </div>
        </div>

        {/* ICC-style tiles */}
        <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "1fr", gap: 12 }}>
          <details
            open
            style={{
              borderRadius: 16,
              overflow: "hidden",
              border: "1px solid rgba(255,255,255,0.10)",
              background: "rgba(255,255,255,0.03)",
            }}
          >
            <summary style={{ listStyle: "none", cursor: "pointer", padding: 12, fontWeight: 900, color: "rgba(232,238,252,0.85)" }}>
              At crease
              <span style={{ marginLeft: 10, fontWeight: 700, fontSize: 12, color: "rgba(232,238,252,0.55)" }}>
                (runs off bat • balls faced — wides don’t count)
              </span>
            </summary>

            <div style={{ padding: 12, paddingTop: 0, display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(240px,1fr))", gap: 10 }}>
              {[{ id: strikerId, strike: true }, { id: nonStrikerId, strike: false }].map(({ id, strike }) => {
                const turn = strike ? strikerTurn : nonStrikerTurn;
                const row = battingScorecardRows.find((r) => r.id === id && r.turn === turn);
                const name = row?.name || "Select batter";
                const runs = row?.runs ?? 0;
                const ballsF = row?.balls ?? 0;
                const fours = row?.fours ?? 0;
                const sixes = row?.sixes ?? 0;
                const sr = row?.sr ?? "0.0";
                const dismissals = row?.dismissals ?? 0;

                return (
                  <div key={strike ? "striker" : "non"} style={{ padding: 12, borderRadius: 16, border: "1px solid rgba(255,255,255,0.10)", background: "rgba(10,16,28,0.55)" }}>
                    <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                      <div
                        title={strike ? "On strike" : ""}
                        style={{
                          width: 10,
                          height: 10,
                          borderRadius: 999,
                          background: strike ? "#ffd166" : "rgba(255,255,255,0.18)",
                          boxShadow: strike ? "0 0 0 3px rgba(255,209,102,0.18)" : "none",
                        }}
                      />
                      <div style={{ fontWeight: 900, fontSize: 16 }}>{name}</div>
                      {id ? (
                        <div style={{ marginLeft: 10, fontSize: 12, color: "rgba(232,238,252,0.70)", fontWeight: 900 }}>
                          Turn {turn || 1}
                        </div>
                      ) : null}
                      <div style={{ marginLeft: "auto", fontWeight: 900, fontSize: 18 }}>
                        {runs}
                        <span style={{ fontSize: 12, color: "rgba(232,238,252,0.70)", marginLeft: 6 }}>({ballsF})</span>
                      </div>
                    </div>

                    <div style={{ marginTop: 10, display: "flex", gap: 14, flexWrap: "wrap", color: "rgba(232,238,252,0.75)", fontSize: 12 }}>
                      <div>
                        SR <span style={{ fontWeight: 900, color: "#e8eefc" }}>{sr}</span>
                      </div>
                      <div>
                        4s <span style={{ fontWeight: 900, color: "#e8eefc" }}>{fours}</span>
                      </div>
                      <div>
                        6s <span style={{ fontWeight: 900, color: "#e8eefc" }}>{sixes}</span>
                      </div>
                      <div>
                        Outs <span style={{ fontWeight: 900, color: "#e8eefc" }}>{dismissals}</span>
                      </div>
                    </div>

                    <div style={{ marginTop: 10 }}>
                      <select
                        value={id || ""}
                        onChange={(e) => (strike ? setStrikerSelection(e.target.value) : setNonStrikerSelection(e.target.value))}
                        onFocus={(e) => e.target.scrollIntoView({ block: "center", behavior: "smooth" })} style={selectStyle}
                      >
                        <option value="">Select…</option>
                        {battingPlayers.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                );
              })}
            </div>
          </details>

          <details
            open
            style={{
              borderRadius: 16,
              overflow: "hidden",
              border: "1px solid rgba(255,255,255,0.10)",
              background: "rgba(255,255,255,0.03)",
            }}
          >
            <summary style={{ listStyle: "none", cursor: "pointer", padding: 12, fontWeight: 900, color: "rgba(232,238,252,0.85)" }}>
              Current bowler
            </summary>

            <div style={{ padding: 12, paddingTop: 0, display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(240px,1fr))", gap: 10 }}>
              <div style={{ padding: 12, borderRadius: 16, border: "1px solid rgba(255,255,255,0.10)", background: "rgba(10,16,28,0.55)" }}>
                <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                  <div style={{ fontWeight: 900, fontSize: 16 }}>{currentBowlerRow?.name || "Select bowler"}</div>
                  <div style={{ marginLeft: "auto", fontWeight: 900, fontSize: 14, color: "rgba(232,238,252,0.75)" }}>
                    {currentBowlerRow ? `${currentBowlerRow.oversText} ov` : ""}
                  </div>
                </div>

                {currentBowlerRow ? (
                  <div style={{ marginTop: 10, display: "flex", gap: 14, flexWrap: "wrap", color: "rgba(232,238,252,0.75)", fontSize: 12 }}>
                    <div>
                      R <span style={{ fontWeight: 900, color: "#e8eefc" }}>{currentBowlerRow.runs}</span>
                    </div>
                    <div>
                      W <span style={{ fontWeight: 900, color: "#e8eefc" }}>{currentBowlerRow.wickets}</span>
                    </div>
                    <div>
                      Econ <span style={{ fontWeight: 900, color: "#e8eefc" }}>{currentBowlerRow.econ}</span>
                    </div>
                    <div>
                      M <span style={{ fontWeight: 900, color: "#e8eefc" }}>{currentBowlerRow.maidens}</span>
                    </div>
                  </div>
                ) : null}

                <div style={{ marginTop: 10 }}>
                  <select value={bowlerId || ""} onChange={(e) => setBowlerId(e.target.value)} onFocus={(e) => e.target.scrollIntoView({ block: "center", behavior: "smooth" })} style={selectStyle}>
                    <option value="">Select…</option>
                    {bowlingPlayers.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* last ball quick edit */}
              <div style={{ padding: 12, borderRadius: 16, border: "1px solid rgba(255,255,255,0.10)", background: "rgba(10,16,28,0.55)" }}>
                <div style={{ fontWeight: 900, marginBottom: 8 }}>Last delivery</div>
                {balls.length ? (
                  <>
                    <div style={{ color: "rgba(232,238,252,0.75)", fontSize: 13 }}>
                      Over {balls[balls.length - 1].over_no}.{balls[balls.length - 1].delivery_in_over} •{" "}
                      {balls[balls.length - 1].extra_type ? balls[balls.length - 1].extra_type.toUpperCase() : "LEGAL"} •{" "}
                      Bat {balls[balls.length - 1].runs_off_bat || 0} • Extras {balls[balls.length - 1].extra_runs || 0}
                      {balls[balls.length - 1].wicket ? " • WICKET" : ""}{" "}
                      {balls[balls.length - 1].dismissed_player_id ? " • OUT SET" : ""}
                      {balls[balls.length - 1].batting_turn ? `• Turn ${balls[balls.length - 1].batting_turn}` : ""}
                    </div>
                    <div style={{ marginTop: 10, display: "flex", gap: 10, flexWrap: "wrap" }}>
                      <button
                        onClick={() => {
                          const b = balls[balls.length - 1];
                          setEditBall(b);
                          setEditExtraType(b.extra_type);
                          setEditBatRuns(toInt(b.runs_off_bat, 0));
                          setEditExtraRuns(toInt(b.extra_runs, 0));
                          setEditIsWicket(!!b.wicket);
                          setEditDismissalKind(b.dismissal_kind || "bowled");
                          setEditDismissedPlayerId(b.dismissed_player_id || "");
                          setEditOpen(true);
                        }}
                        style={modalBtnGhost}
                      >
                        Edit last
                      </button>
                    </div>
                    <div style={{ marginTop: 8, fontSize: 12, color: "rgba(232,238,252,0.55)" }}>
                      Note: editing changes recorded totals. If strike/bowler selection becomes incorrect after edits, re-select them above.
                    </div>
                  </>
                ) : (
                  <div style={{ color: "rgba(232,238,252,0.65)" }}>No balls yet.</div>
                )}
              </div>
            </div>
          </details>

          {/* Ball-by-ball */}
          <details style={{ borderRadius: 16, overflow: "hidden", border: "1px solid rgba(255,255,255,0.10)", background: "rgba(255,255,255,0.03)" }}>
            <summary style={{ listStyle: "none", cursor: "pointer", padding: 12, fontWeight: 900, color: "rgba(232,238,252,0.85)" }}>
              Ball-by-ball
            </summary>
            <div style={{ padding: 12, paddingTop: 0 }}>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                {balls.slice(-18).reverse().map((b) => {
                  const label = b.extra_type
                    ? b.extra_type === "wide"
                      ? `Wd(${b.extra_runs || 0})`
                      : b.extra_type === "noball"
                      ? `NB(${(b.extra_runs || 0) + (b.runs_off_bat || 0)})`
                      : b.extra_type === "bye"
                      ? `B(${b.extra_runs || 0})`
                      : `LB(${b.extra_runs || 0})`
                    : `${b.runs_off_bat || 0}`;
                  return (
                    <div
                      key={b.id}
                      title={`Over ${b.over_no}.${b.delivery_in_over}`}
                      style={{
                        width: 76,
                        padding: "10px 8px",
                        borderRadius: 14,
                        textAlign: "center",
                        border: "1px solid rgba(255,255,255,0.12)",
                        background: "rgba(10,16,28,0.55)",
                        fontWeight: 900,
                      }}
                    >
                      <div style={{ fontSize: 14 }}>{label}</div>
                      <div style={{ marginTop: 4, fontSize: 11, color: "rgba(232,238,252,0.65)" }}>
                        {b.over_no}.{b.delivery_in_over}
                      </div>
                      {b.wicket ? <div style={{ marginTop: 4, fontSize: 11, color: "#ffb3b3" }}>W</div> : null}
                      {b.batting_turn ? (
                        <div style={{ marginTop: 4, fontSize: 11, color: "rgba(232,238,252,0.65)" }}>T{b.batting_turn}</div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>
          </details>
        </div>
      </div>

      {/* Bottom keypad */}
      <div
        style={{
          position: "fixed",
          left: 0,
          right: 0,
          bottom: 0,
          zIndex: 50,
          background: "rgba(10,16,28,0.92)",
          borderTop: "1px solid rgba(255,255,255,0.10)",
          backdropFilter: "blur(10px)",
        }}
      >
        <div style={{ maxWidth: 980, margin: "0 auto", padding: "10px 12px" }}>
          <div style={{ display: "flex", gap: 10, marginBottom: 10 }}>
            {[
              ["runs", "RUNS"],
              ["extras", "EXTRAS"],
              ["wicket", "WICKET"],
            ].map(([k, label]) => (
              <button
                key={k}
                onClick={() => setKeypadTab(k)}
                style={{
                  flex: 1,
                  padding: "10px 12px",
                  borderRadius: 14,
                  border: "1px solid rgba(255,255,255,0.14)",
                  background: keypadTab === k ? "rgba(255,255,255,0.10)" : "rgba(255,255,255,0.05)",
                  color: "#e8eefc",
                  fontWeight: 900,
                  cursor: "pointer",
                }}
              >
                {label}
              </button>
            ))}
          </div>

          {keypadTab === "runs" ? (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 10 }}>
              {[0, 1, 2, 3, 4, 5, 6].map((n) => (
                <button
                  key={n}
                  onClick={() => addRun(n)}
                  disabled={saving || inningsComplete}
                  style={{
                    padding: "14px 10px",
                    borderRadius: 16,
                    border: "1px solid rgba(255,255,255,0.14)",
                    background: "rgba(255,255,255,0.06)",
                    color: "#e8eefc",
                    fontWeight: 900,
                    fontSize: 16,
                    cursor: "pointer",
                  }}
                >
                  {n}
                </button>
              ))}
            </div>
          ) : null}

          {keypadTab === "extras" ? (
            <div style={{ display: "grid", gap: 12 }}>
              <div style={{ fontWeight: 900, opacity: 0.9 }}>WIDES (team only) • base = 2</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 10 }}>
                {[2, 3, 4, 5, 6].map((n) => (
                  <button key={`wd${n}`} onClick={() => addWide(n)} disabled={saving || inningsComplete} style={keyBtnStyle}>
                    {n}wd
                  </button>
                ))}
              </div>

              <div style={{ fontWeight: 900, opacity: 0.9 }}>NO BALLS (1 run penalty + bat runs)</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(6,1fr)", gap: 10 }}>
                {[0, 1, 2, 3, 4, 6].map((n) => (
                  <button key={`nb${n}`} onClick={() => addNoBall(n)} disabled={saving || inningsComplete} style={keyBtnStyle}>
                    NB+{n}
                  </button>
                ))}
              </div>

              <div style={{ fontWeight: 900, opacity: 0.9 }}>BYES (team only)</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 10 }}>
                {[1, 2, 3, 4, 5].map((n) => (
                  <button key={`b${n}`} onClick={() => addBye(n)} disabled={saving || inningsComplete} style={keyBtnStyle}>
                    {n}b
                  </button>
                ))}
              </div>

              <div style={{ fontWeight: 900, opacity: 0.9 }}>LEG BYES (team only)</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 10 }}>
                {[1, 2, 3, 4, 5].map((n) => (
                  <button key={`lb${n}`} onClick={() => addLegBye(n)} disabled={saving || inningsComplete} style={keyBtnStyle}>
                    {n}lb
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {keypadTab === "wicket" ? (
            <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 10 }}>
              <button
                onClick={addWicket}
                disabled={saving || inningsComplete}
                style={{
                  padding: "16px 12px",
                  borderRadius: 18,
                  border: "1px solid rgba(255,120,120,0.40)",
                  background: "rgba(255, 60, 60, 0.16)",
                  color: "#ffd6d6",
                  fontWeight: 900,
                  fontSize: 16,
                  cursor: "pointer",
                }}
              >
                WICKET
              </button>
            </div>
          ) : null}
        </div>
      </div>

      <style>{`
        summary::-webkit-details-marker { display: none; }
      `}</style>

      {/* Wicket modal */}
      {needsWicketModal ? (
        <div
          onClick={() => setNeedsWicketModal(false)}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 90,
            background: "rgba(0,0,0,0.55)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 14,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "100%",
              maxWidth: 520,
              borderRadius: 18,
              border: "1px solid rgba(255,255,255,0.14)",
              background: "rgba(10,16,28,0.98)",
              padding: 14,
              boxShadow: "0 20px 60px rgba(0,0,0,0.50)",
            }}
          >
            <div style={{ fontWeight: 900, fontSize: 16 }}>Wicket</div>

            <div style={{ marginTop: 12, display: "grid", gap: 10 }}>
              <div>
                <div style={{ fontSize: 12, color: "rgba(232,238,252,0.65)", marginBottom: 6 }}>Dismissal</div>
                <select value={dismissalKind} onChange={(e) => setDismissalKind(e.target.value)} style={modalSelectStyle}>
                  <option value="bowled">Bowled</option>
                  <option value="caught">Caught</option>
                  <option value="lbw">LBW</option>
                  <option value="run out">Run out</option>
                  <option value="stumped">Stumped</option>
                  <option value="hit wicket">Hit wicket</option>
                </select>
              </div>

              {/* ✅ NEW: who got out */}
              <div>
                <div style={{ fontSize: 12, color: "rgba(232,238,252,0.65)", marginBottom: 6 }}>Who is out?</div>
                <select value={dismissedPlayerId || ""} onChange={(e) => setDismissedPlayerId(e.target.value)} style={modalSelectStyle}>
                  <option value={strikerId || ""}>Striker</option>
                  <option value={nonStrikerId || ""}>Non-striker</option>
                </select>
              </div>

              <div>
                <div style={{ fontSize: 12, color: "rgba(232,238,252,0.65)", marginBottom: 6 }}>New batter</div>
                <select value={incomingBatterId} onChange={(e) => setIncomingBatterId(e.target.value)} style={modalSelectStyle}>
                  <option value="">Select…</option>
                  {availableIncomingBatters.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>

              <label style={{ display: "flex", gap: 10, alignItems: "center" }}>
                <input type="checkbox" checked={wicketCrossed} onChange={(e) => setWicketCrossed(e.target.checked)} />
                <span style={{ fontWeight: 900 }}>Batters crossed</span>
              </label>

              <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", flexWrap: "wrap" }}>
                <button onClick={() => setNeedsWicketModal(false)} style={modalBtnGhost}>
                  Cancel
                </button>
                <button onClick={confirmWicket} disabled={saving} style={modalBtnPrimary}>
                  Confirm wicket
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* Edit last delivery modal */}
      {editOpen && editBall ? (
        <div
          onClick={() => setEditOpen(false)}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 80,
            background: "rgba(0,0,0,0.55)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 14,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "100%",
              maxWidth: 520,
              borderRadius: 18,
              border: "1px solid rgba(255,255,255,0.14)",
              background: "rgba(10,16,28,0.98)",
              padding: 14,
              boxShadow: "0 20px 60px rgba(0,0,0,0.50)",
            }}
          >
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <div style={{ fontWeight: 900, fontSize: 16 }}>Edit last delivery</div>
              <div style={{ marginLeft: "auto", color: "rgba(232,238,252,0.65)", fontSize: 12 }}>
                {editBall.over_no}.{editBall.delivery_in_over}
              </div>
            </div>

            <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <div>
                <div style={{ fontSize: 12, color: "rgba(232,238,252,0.65)", marginBottom: 6 }}>Type</div>
                <select value={editExtraType || ""} onChange={(e) => setEditExtraType(e.target.value || null)} style={modalSelectStyle}>
                  <option value="">Legal</option>
                  <option value="wide">Wide</option>
                  <option value="noball">No-ball</option>
                  <option value="bye">Bye</option>
                  <option value="legbye">Leg bye</option>
                </select>
              </div>

              <div>
                <div style={{ fontSize: 12, color: "rgba(232,238,252,0.65)", marginBottom: 6 }}>Bat runs</div>
                <input
                  type="number"
                  min="0"
                  max="6"
                  value={editBatRuns}
                  onChange={(e) => setEditBatRuns(toInt(e.target.value, 0))}
                  disabled={editExtraType === "wide" || editExtraType === "bye" || editExtraType === "legbye"}
                  style={modalInputStyle}
                />
              </div>

              <div>
                <div style={{ fontSize: 12, color: "rgba(232,238,252,0.65)", marginBottom: 6 }}>Extra runs</div>
                <input type="number" min="0" value={editExtraRuns} onChange={(e) => setEditExtraRuns(toInt(e.target.value, 0))} style={modalInputStyle} />
                <div style={{ marginTop: 6, fontSize: 11, color: "rgba(232,238,252,0.55)" }}>
                  Wide base is 2 (e.g. wide = 2). No-ball base is 1.
                </div>
              </div>

              <div>
                <div style={{ fontSize: 12, color: "rgba(232,238,252,0.65)", marginBottom: 6 }}>Wicket</div>
                <label style={{ display: "flex", gap: 10, alignItems: "center" }}>
                  <input type="checkbox" checked={editIsWicket} onChange={(e) => setEditIsWicket(e.target.checked)} />
                  <span style={{ fontWeight: 900 }}>{editIsWicket ? "Yes" : "No"}</span>
                </label>

                {editIsWicket ? (
                  <>
                    <select value={editDismissalKind} onChange={(e) => setEditDismissalKind(e.target.value)} style={{ ...modalSelectStyle, marginTop: 8 }}>
                      <option value="bowled">Bowled</option>
                      <option value="caught">Caught</option>
                      <option value="lbw">LBW</option>
                      <option value="run out">Run out</option>
                      <option value="stumped">Stumped</option>
                      <option value="hit wicket">Hit wicket</option>
                    </select>

                    <div style={{ marginTop: 8, fontSize: 12, color: "rgba(232,238,252,0.65)", marginBottom: 6 }}>Dismissed player</div>
                    <select value={editDismissedPlayerId || ""} onChange={(e) => setEditDismissedPlayerId(e.target.value)} style={modalSelectStyle}>
                      <option value="">Select…</option>
                      <option value={editBall.striker_id || ""}>Striker</option>
                      <option value={editBall.non_striker_id || ""}>Non-striker</option>
                    </select>
                  </>
                ) : null}
              </div>
            </div>

            <div style={{ marginTop: 14, display: "flex", gap: 10, justifyContent: "flex-end", flexWrap: "wrap" }}>
              <button onClick={() => setEditOpen(false)} style={modalBtnGhost}>
                Cancel
              </button>
              <button
                onClick={async () => {
                  try {
                    setErr("");
                    setInfo("");
                    setSaving(true);

                    if (!innings) return;

                    let nextBatRuns =
                      editExtraType === "wide" || editExtraType === "bye" || editExtraType === "legbye"
                        ? 0
                        : toInt(editBatRuns, 0);

                    let nextExtraRuns = Math.max(0, toInt(editExtraRuns, 0));
                    if (editExtraType === "wide") {
                      nextBatRuns = 0;
                      nextExtraRuns = Math.max(2, nextExtraRuns);
                    } else if (editExtraType === "noball") {
                      nextExtraRuns = Math.max(1, nextExtraRuns);
                    } else if (!editExtraType) {
                      nextExtraRuns = 0;
                    }

                    await applySessionEvent(
                      {
                        created_at: new Date().toISOString(),
                        event_id: createEventId("edit-ball"),
                        event_type: "edit_ball",
                        innings_id: innings.id,
                        match_id: matchId,
                        payload: {
                          ball_id: editBall.id || null,
                          target_source_event_id: editBall.source_event_id || editBall.local_temp_id || null,
                          patch: {
                            runs_off_bat: nextBatRuns,
                            extra_type: editExtraType || null,
                            extra_runs: nextExtraRuns,
                            wicket: !!editIsWicket,
                            dismissal_kind: editIsWicket ? editDismissalKind : null,
                            dismissed_player_id: editIsWicket ? (editDismissedPlayerId || null) : null,
                          },
                        },
                      },
                      {
                        failurePrefix: "Edit delivery",
                        successInfo: "",
                        optimisticQueuedInfo: "Offline: delivery edit queued locally.",
                      }
                    );




                    if (!innings.completed) {
                      clearScorerState(matchId, innings.id, persistenceScope);
                      clearLiveSelections();
                      setInfo("Delivery updated. Re-select striker, non-striker, and bowler before scoring again.");
                    } else {
                      setInfo("Delivery updated.");
                    }
                    setEditOpen(false);
                  } finally {
                    setSaving(false);
                  }
                }}
                style={modalBtnPrimary}
              >
                Save changes
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  ); 
} 
