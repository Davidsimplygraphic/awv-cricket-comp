import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { supabase } from "../lib/supabase";
import LiveOutcomeBadge from "../components/LiveOutcomeBadge";
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
import {
  ADMINISTRATIVE_STATE_CHANGED_EVENT_TYPE,
  buildScorerPostState,
  computeNextPosition,
  countLegalBallsBowledBy,
  describeBallOutcomeBadge,
  DELIVERY_RECORDED_EVENT_TYPE,
  deriveRosterWicketCap,
  reconcileLatestBallEditSelectionState,
  deriveWicketPostState,
  didBatterFaceBall,
  formatBallOutcomeToken,
  formatOverSummaryText,
  getOverCounts,
  isChaseCompleteForScoring,
  isAdministrativeBall,
  isBattingSideWicket,
  isBowlerCreditedWicket,
  isOverFinished,
  legalBallsCount,
  materializeAdministrativeStateBalls,
  mergeBallIntoList,
  normalizeDeliveryOutcome,
  oversTextFromLegal,
  resolveDisplayWicketCap,
  resolveWicketCap,
  runsConcededByBowler,
  selectBatterStatus,
  selectCurrentOverSummary,
  sortBallsByPosition,
  sumRuns,
  sumWkts,
  toInt,
  validateWicketDeliveryInput,
} from "../lib/scoring";
import {
  applyEventOptimistically,
  applyRpcResultToState,
  canAutoFlushPendingQueue,
  createEventId,
  deriveQueuedScorerState,
  enqueuePendingEvent,
  isAuthoritativeScoringRejection,
  isLockConflictError,
  isMissingRpcError,
  isNetworkLikeError,
  missingRequiredRpcMessage,
  removePendingEvent,
  removePendingEventsForInnings,
  replayPendingEventsOnState,
} from "../lib/scoringSync";

const PENDING_SYNC_RETRY_DELAY_MS = 3000;
const LIVE_OUTCOME_BADGE_DURATION_MS = 1600;
const SAVE_FEEDBACK_DURATION_MS = 1200;

function isScorerOwnershipError(error) {
  return /Only the assigned scorer can/i.test(String(error?.message || error || ""));
}

async function getOrCreateInnings({ matchId, inningsNo }) {
  const { data, error } = await supabase.rpc("get_or_create_match_innings", {
    p_match_id: matchId,
    p_innings_no: inningsNo,
  });

  if (error) {
    if (isMissingRpcError(error)) {
      return {
        data: null,
        error: new Error(missingRequiredRpcMessage("get_or_create_match_innings", "Innings load/create")),
      };
    }

    return { data: null, error };
  }

  return { data, error: null };
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

async function loadAppliedSessionEvents({ matchId, inningsId }) {
  if (!matchId || !inningsId) return [];

  const response = await supabase
    .from("match_session_events")
    .select("event_id,event_type,created_at,applied_at,payload,result,status,innings_id,match_id")
    .eq("match_id", matchId)
    .eq("innings_id", inningsId)
    .eq("status", "applied")
    .order("applied_at", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: true });

  if (response.error) return [];
  return response.data || [];
}

function ScoreViewLoadingShell() {
  return (
    <div style={{ minHeight: "100vh", background: "linear-gradient(180deg,#0b1220,#060a12)", color: "#e8eefc" }}>
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
        <div style={{ maxWidth: 980, margin: "0 auto", padding: "10px 12px", display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ color: "#cfe0ff", fontWeight: 700 }}>Scorer</div>
        </div>
      </div>

      <div style={{ maxWidth: 980, margin: "0 auto", padding: "12px" }}>
        <div
          style={{
            marginTop: 12,
            padding: 12,
            borderRadius: 16,
            border: "1px solid rgba(255,255,255,0.10)",
            background: "rgba(255,255,255,0.04)",
            boxShadow: "0 10px 30px rgba(0,0,0,0.25)",
          }}
        >
          <div style={{ fontSize: 14, fontWeight: 800, color: "rgba(232,238,252,0.78)" }}>Loading scorer...</div>
          <div style={{ marginTop: 8, fontSize: 13, color: "rgba(232,238,252,0.62)" }}>
            Preparing match, scorer lock, innings, and recovery state.
          </div>
        </div>
      </div>
    </div>
  );
}

export function ScorerStickyHeader({
  visible,
  score,
  oversText,
  context,
  strikerLabel,
  bowlerLabel,
  badges = [],
  isPhoneViewport = false,
}) {
  const displayBadges = badges.slice(0, 2);

  return (
    <div
      style={{
        position: "sticky",
        top: isPhoneViewport ? 52 : 56,
        zIndex: 19,
        height: visible ? (isPhoneViewport ? 82 : 64) : 0,
        overflow: "hidden",
        transition: "height 180ms ease",
        pointerEvents: visible ? "auto" : "none",
      }}
    >
      <div
        style={{
          opacity: visible ? 1 : 0,
          transform: visible ? "translateY(0)" : "translateY(-8px)",
          transition: "opacity 180ms ease, transform 180ms ease",
          marginTop: isPhoneViewport ? 6 : 8,
          borderRadius: 14,
          border: "1px solid rgba(255,255,255,0.10)",
          background: "rgba(8,14,26,0.92)",
          backdropFilter: "blur(12px)",
          boxShadow: "0 12px 28px rgba(0,0,0,0.28)",
          padding: isPhoneViewport ? "8px 9px" : "9px 10px",
          display: "grid",
          gap: isPhoneViewport ? 5 : 6,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "flex-start" }}>
          <div style={{ minWidth: 0, display: "grid", gap: 3 }}>
            <div style={{ fontSize: isPhoneViewport ? 17 : 18, fontWeight: 1000, color: "#f8fafc" }}>{score}</div>
            <div
              style={{
                minWidth: 0,
                fontSize: isPhoneViewport ? 10.5 : 11,
                color: "rgba(232,238,252,0.72)",
                whiteSpace: isPhoneViewport ? "normal" : "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {oversText} ov{isPhoneViewport && context ? ` • ${context}` : ""}
            </div>
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
            {displayBadges.map((badge) => (
              <span
                key={badge}
                style={{
                  padding: "2px 7px",
                  borderRadius: 999,
                  fontSize: 10,
                  fontWeight: 900,
                  border: "1px solid rgba(255,255,255,0.12)",
                  background: "rgba(255,255,255,0.06)",
                  color: "#e8eefc",
                  whiteSpace: "nowrap",
                }}
              >
                {badge}
              </span>
            ))}
          </div>
        </div>

        {isPhoneViewport ? (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 6 }}>
            {[
              { label: "Bat", value: strikerLabel },
              { label: "Bowl", value: bowlerLabel },
            ].map((item) => (
              <div
                key={item.label}
                style={{
                  minWidth: 0,
                  borderRadius: 11,
                  border: "1px solid rgba(255,255,255,0.10)",
                  background: "rgba(255,255,255,0.05)",
                  padding: "6px 8px",
                }}
              >
                <div style={{ fontSize: 10, fontWeight: 900, color: "rgba(232,238,252,0.62)" }}>{item.label}</div>
                <div
                  style={{
                    marginTop: 3,
                    minWidth: 0,
                    fontSize: 11,
                    fontWeight: 900,
                    color: "#e8eefc",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {item.value}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: 10, alignItems: "center" }}>
            <div style={{ minWidth: 0, fontSize: 11, color: "rgba(232,238,252,0.74)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {strikerLabel} | {bowlerLabel}
            </div>
            <div style={{ fontSize: 11, color: "rgba(232,238,252,0.68)", fontWeight: 800 }}>{context}</div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function ScoreView() {
  const { fixtureId } = useParams();


  // Single match per fixture_id; each match has two innings rows (innings_no 1 & 2).
  const [matchId, setMatchId] = useState("");
  const [canonicalFixtureId, setCanonicalFixtureId] = useState("");

  const [match, setMatch] = useState(null);
  const [fixtureDisplayWicketCap, setFixtureDisplayWicketCap] = useState(null);
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
  const [sessionEvents, setSessionEvents] = useState([]);
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
  const [wicketBatRuns, setWicketBatRuns] = useState(0);
  const [wicketExtraType, setWicketExtraType] = useState(null);
  const [wicketExtraRuns, setWicketExtraRuns] = useState(0);

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
  const [startupLoading, setStartupLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [isOnline, setIsOnline] = useState(typeof navigator === "undefined" ? true : navigator.onLine);
  const [pendingEvents, setPendingEvents] = useState([]);
  const [isFlushingQueue, setIsFlushingQueue] = useState(false);
  const [pendingSyncRetryTick, setPendingSyncRetryTick] = useState(0);
  const [lockReady, setLockReady] = useState(false);
  const [scoringLocked, setScoringLocked] = useState(false);
  const [activeScorerSession, setActiveScorerSession] = useState(null);
  const [lockFeatureAvailable, setLockFeatureAvailable] = useState(true);
  const [takingControl, setTakingControl] = useState(false);
  const [claimingScorerRole, setClaimingScorerRole] = useState(false);
  const [currentUser, setCurrentUser] = useState(null);
  const [ownershipRefreshKey, setOwnershipRefreshKey] = useState(0);
  const [reopenedForContinuation, setReopenedForContinuation] = useState(false);
  const [liveOutcomeBadge, setLiveOutcomeBadge] = useState(null);
  const [saveFeedbackBadge, setSaveFeedbackBadge] = useState(null);
  const [isCompactViewport, setIsCompactViewport] = useState(
    typeof window !== "undefined" ? window.innerWidth <= 860 : false
  );
  const [isPhoneViewport, setIsPhoneViewport] = useState(
    typeof window !== "undefined" ? window.innerWidth <= 720 : false
  );
  const [showStickyScoreHeader, setShowStickyScoreHeader] = useState(false);

  const ballsRef = useRef([]);
  const inningsRef = useRef(null);
  const strikerIdRef = useRef("");
  const nonStrikerIdRef = useRef("");
  const strikerTurnRef = useRef(1);
  const nonStrikerTurnRef = useRef(1);
  const bowlerIdRef = useRef("");
  const reopenedForContinuationRef = useRef(false);
  const pendingEventsRef = useRef([]);
  const savingRef = useRef(false);
  const flushingQueueRef = useRef(false);
  const pendingSyncRetryTimerRef = useRef(null);
  const latestOutcomeBallKeyRef = useRef("");
  const liveOutcomeBadgeTimerRef = useRef(null);
  const saveFeedbackTimerRef = useRef(null);
  const scoreHeroRef = useRef(null);
  const matchSnapshotScope = fixtureId || canonicalFixtureId || matchId || "unknown";
  const persistenceScope = clientSessionId || "shared";

  useEffect(() => {
    let alive = true;

    supabase.auth.getSession().then(({ data }) => {
      if (!alive) return;
      setCurrentUser(data?.session?.user || null);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setCurrentUser(session?.user || null);
    });

    return () => {
      alive = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;

    const handleResize = () => {
      setIsCompactViewport(window.innerWidth <= 860);
      setIsPhoneViewport(window.innerWidth <= 720);
    };

    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  useEffect(() => {
    if (!isCompactViewport || loading || startupLoading) {
      setShowStickyScoreHeader(false);
      return undefined;
    }

    const heroEl = scoreHeroRef.current;
    if (!heroEl || typeof window === "undefined") return undefined;

    if ("IntersectionObserver" in window) {
      const observer = new IntersectionObserver(
        ([entry]) => {
          setShowStickyScoreHeader(!entry.isIntersecting);
        },
        { threshold: 0.2 }
      );
      observer.observe(heroEl);
      return () => observer.disconnect();
    }

    const onScroll = () => {
      const rect = heroEl.getBoundingClientRect();
      setShowStickyScoreHeader(rect.bottom < 96);
    };

    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [isCompactViewport, loading, startupLoading]);

  const displaySessionEvents = useMemo(() => {
    const merged = new Map();

    (sessionEvents || []).forEach((event) => {
      if (event?.event_id) merged.set(event.event_id, event);
    });

    (pendingEvents || []).forEach((event) => {
      if (!event?.event_id) return;
      if (innings?.id && event.innings_id !== innings.id) return;
      merged.set(event.event_id, event);
    });

    return [...merged.values()];
  }, [innings?.id, pendingEvents, sessionEvents]);

  const displayBalls = useMemo(() => materializeAdministrativeStateBalls({
    balls,
    sessionEvents: displaySessionEvents,
  }), [balls, displaySessionEvents]);

  // CURRENT innings totals
  const totalRuns = useMemo(() => sumRuns(displayBalls), [displayBalls]);
  const wickets = useMemo(() => sumWkts(displayBalls), [displayBalls]);
  const legalBalls = useMemo(() => legalBallsCount(displayBalls), [displayBalls]);

  const oversLimit = useMemo(() => {
    const v = toInt(match?.overs_limit, 20);
    return v > 0 ? v : 20;
  }, [match]);

  const maxLegal = useMemo(() => oversLimit * 6, [oversLimit]);
  const oversText = useMemo(() => oversTextFromLegal(legalBalls), [legalBalls]);

  const wicketCap = useMemo(() => {
    return resolveWicketCap(match?.wicket_cap, 10);
  }, [match]);
  const displayWicketCap = useMemo(() => resolveDisplayWicketCap({
    fixtureWicketCap: fixtureDisplayWicketCap,
    matchWicketCap: match?.wicket_cap,
    rosterWicketCap: deriveRosterWicketCap(
      [...(battingPlayers || []), ...(bowlingPlayers || [])],
      [match?.team_a_id, match?.team_b_id]
    ),
    fallback: 10,
  }), [fixtureDisplayWicketCap, match?.wicket_cap, match?.team_a_id, match?.team_b_id, battingPlayers, bowlingPlayers]);
  const currentUserId = currentUser?.id || "";
  const scorerAssignmentState = useMemo(() => {
    if (!currentUserId) return "unauthenticated";
    if (!match?.scorer_user_id) return "unassigned";
    if (match.scorer_user_id === currentUserId) return "mine";
    return "assigned_elsewhere";
  }, [currentUserId, match?.scorer_user_id]);
  const canClaimScorerRole = scorerAssignmentState === "unassigned" || scorerAssignmentState === "assigned_elsewhere";
  const scorerStatusBanner = useMemo(() => {
    if (!match) return null;

    let title = "Assigned to you";
    let tone = {
      background: "rgba(0, 200, 120, 0.10)",
      border: "1px solid rgba(0,200,120,0.25)",
      color: "#d8ffee",
    };
    let message = "You are the assigned scorer for this match.";

    if (scorerAssignmentState === "unauthenticated") {
      title = "Sign in required";
      tone = {
        background: "rgba(255, 204, 102, 0.10)",
        border: "1px solid rgba(255,204,102,0.25)",
        color: "#ffe4b0",
      };
      message = "You must be signed in before you can claim scorer ownership or start scoring.";
    } else if (scorerAssignmentState === "unassigned") {
      title = "Unassigned";
      tone = {
        background: "rgba(96, 165, 250, 0.10)",
        border: "1px solid rgba(96,165,250,0.28)",
        color: "#dbeafe",
      };
      message = "No scorer is assigned yet. Assign yourself before scoring this match.";
    } else if (scorerAssignmentState === "assigned_elsewhere") {
      title = "Assigned to another scorer";
      tone = {
        background: "rgba(96, 165, 250, 0.10)",
        border: "1px solid rgba(96,165,250,0.28)",
        color: "#dbeafe",
      };
      message = "This match is assigned to another scorer account. Take over explicitly if you need to score it from this account.";
    }

    if (scorerAssignmentState === "mine" && scoringLocked) {
      title = "Lock held elsewhere";
      tone = {
        background: "rgba(255, 204, 102, 0.10)",
        border: "1px solid rgba(255,204,102,0.25)",
        color: "#ffe4b0",
      };
      message = activeScorerSession
        ? `Another active scorer session currently holds the lock: ${activeScorerSession.device_label || activeScorerSession.client_session_id || "another browser"}.`
        : "Another active scorer session currently holds the match lock.";
    }

    const badges = [];
    badges.push(!isOnline ? "Offline" : scoringLocked ? "Locked elsewhere" : "Ready");
    if (isOnline && pendingEvents.length) badges.push(`${pendingEvents.length} pending sync`);
    if (isFlushingQueue) badges.push("Syncing");

    return {
      title,
      message,
      tone,
      badges,
    };
  }, [activeScorerSession, isFlushingQueue, isOnline, match, pendingEvents.length, scorerAssignmentState, scoringLocked]);

  const allOut = useMemo(() => wickets >= wicketCap, [wickets, wicketCap]);
  const oversDone = useMemo(() => legalBalls >= maxLegal, [legalBalls, maxLegal]);
  const chaseComplete = useMemo(() => {
    return isChaseCompleteForScoring({
      inningsNo,
      innings1Ready: !!innings1Row?.completed || innings1Legal > 0,
      innings1Runs,
      totalRuns,
      reopenedForContinuation,
    });
  }, [innings1Legal, innings1Row?.completed, innings1Runs, inningsNo, reopenedForContinuation, totalRuns]);
  const inningsCompletedFlag = useMemo(() => !!innings?.completed, [innings]);
  const inningsComplete = useMemo(
    () => oversDone || allOut || chaseComplete || inningsCompletedFlag,
    [oversDone, allOut, chaseComplete, inningsCompletedFlag]
  );

  const nextPos = useMemo(() => computeNextPosition(balls), [balls]);
  const latestCompetitiveBall = useMemo(() => [...displayBalls].reverse().find((ball) => !isAdministrativeBall(ball)) || null, [displayBalls]);
  const currentOverSummary = useMemo(() => selectCurrentOverSummary(displayBalls), [displayBalls]);

  const lastOverBowlerId = useMemo(() => {
    const competitive = [...displayBalls].reverse().find((b) => !isAdministrativeBall(b));
    return competitive?.bowler_id || "";
  }, [displayBalls]);

  const currentRR = useMemo(() => {
    if (legalBalls <= 0) return "0.00";
    return (totalRuns / (legalBalls / 6)).toFixed(2);
  }, [legalBalls, totalRuns]);

  const ballTokenStyle = (ball) => {
    const tone = describeBallOutcomeBadge(ball)?.tone;

    if (tone === "wicket") {
      return { background: "#b91c1c", color: "#fff7f7", border: "1px solid rgba(254,202,202,0.22)" };
    }
    if (tone === "boundary") {
      return { background: "rgba(22,163,74,0.94)", color: "#f0fdf4", border: "1px solid rgba(187,247,208,0.22)" };
    }
    if (tone === "extra") {
      return { background: "rgba(37,99,235,0.94)", color: "#eff6ff", border: "1px solid rgba(191,219,254,0.22)" };
    }
    if (tone === "dot") {
      return { background: "rgba(71,85,105,0.68)", color: "#f8fafc", border: "1px solid rgba(203,213,225,0.18)" };
    }
    return { background: "rgba(255,255,255,0.08)", color: "#f8fafc", border: "1px solid rgba(255,255,255,0.12)" };
  };

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
const battingExitsByBatter = useMemo(() => {
  const map = new Map();
  displayBalls.forEach((b) => {
    if (b.wicket && b.dismissed_player_id) {
      map.set(
        b.dismissed_player_id,
        (map.get(b.dismissed_player_id) || 0) + 1
      );
    }
  });
  return map;
}, [displayBalls]);

const dismissalsByBatter = useMemo(() => {
  const map = new Map();
  displayBalls.forEach((b) => {
    if (!isBattingSideWicket(b) || !b.dismissed_player_id) return;
    map.set(
      b.dismissed_player_id,
      (map.get(b.dismissed_player_id) || 0) + 1
    );
  });
  return map;
}, [displayBalls]);

// batting_turn is tracked per appearance. Retired hurt advances the next stint
// if a batter returns later, but should not render as a dismissal.
const getTurnFor = (playerId) => (playerId ? (battingExitsByBatter.get(playerId) || 0) + 1 : 1);

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

const applyLocalScorerSelections = ({
  strikerId: nextStrikerId = "",
  nonStrikerId: nextNonStrikerId = "",
  bowlerId: nextBowlerId = "",
  needsNextBowler: nextNeedsNextBowler = false,
  battingAmbiguous = false,
  bowlerAmbiguous = false,
} = {}) => {
  if (battingAmbiguous) {
    setStrikerSelection("");
    setNonStrikerSelection("");
  } else {
    setStrikerSelection(nextStrikerId || "");
    setNonStrikerSelection(nextNonStrikerId || "");
  }

  if (bowlerAmbiguous) {
    setBowlerId("");
    setNeedsNextBowler(false);
  } else {
    setBowlerId(nextBowlerId || "");
    setNeedsNextBowler(!!nextNeedsNextBowler);
  }
};

const describeLatestEditResolution = ({ battingAmbiguous = false, bowlerAmbiguous = false, needsNextBowler: nextNeedsNextBowler = false } = {}) => {
  if (battingAmbiguous && bowlerAmbiguous) {
    return "Delivery updated. Re-select striker, non-striker, and bowler before scoring again.";
  }

  if (battingAmbiguous) {
    return "Delivery updated. Re-select striker and non-striker before scoring again.";
  }

  if (bowlerAmbiguous) {
    return "Delivery updated. Select the bowler before scoring again.";
  }

  if (nextNeedsNextBowler) {
    return "Delivery updated. Over complete - select a new bowler.";
  }

  return "Delivery updated.";
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
    return { recoveryState: null, stateInvalidated: false, reopenedForContinuation: false, missing: false };
  }

  const [{ data, error }, { data: reopenData, error: reopenError }] = await Promise.all([
    supabase.rpc("get_innings_recovery_state", {
      p_match_id: resolvedMatchId,
      p_innings_id: resolvedInningsId,
    }),
    supabase.rpc("get_innings_reopen_status", {
      p_match_id: resolvedMatchId,
      p_innings_id: resolvedInningsId,
    }),
  ]);

  if (error) {
    if (isMissingRpcError(error)) {
      return { recoveryState: null, stateInvalidated: false, reopenedForContinuation: false, missing: true };
    }

    if (isNetworkLikeError(error)) {
      return { recoveryState: null, stateInvalidated: false, reopenedForContinuation: false, missing: false };
    }

    setErr(`Recovery state error: ${error.message}`);
    return { recoveryState: null, stateInvalidated: false, reopenedForContinuation: false, missing: false };
  }

  const reopenedForContinuation =
    !reopenError && reopenData?.reopened_for_continuation === true;

  return {
    recoveryState: data?.recovery_state && typeof data.recovery_state === "object" ? data.recovery_state : null,
    stateInvalidated: data?.state_invalidated === true,
    reopenedForContinuation,
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
  setReopenedForContinuation(!!snapshot.reopenedForContinuation);
  setPendingEvents(Array.isArray(snapshot.pendingEvents) ? snapshot.pendingEvents : readStoredPendingQueue(snapshot.matchId));
  setInfo("Offline snapshot restored. Pending scoring changes will sync when the connection returns.");
  return true;
};

const reconcileLatestEditSelections = ({
  originalBall = null,
  editedBall = null,
  nextBalls = [],
  nextInnings = null,
  preEditPostState = null,
} = {}) => {
  const resolution = reconcileLatestBallEditSelectionState({
    originalBall,
    editedBall,
    ballsAfterEdit: nextBalls,
    preEditPostState,
    inningsCompleted: !!nextInnings?.completed,
  });

  applyLocalScorerSelections(resolution);
  return resolution;
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

  ballsRef.current = nextState.balls;
  inningsRef.current = nextState.innings;

  return nextState;
};

const clearPendingSyncRetry = () => {
  if (pendingSyncRetryTimerRef.current) {
    window.clearTimeout(pendingSyncRetryTimerRef.current);
    pendingSyncRetryTimerRef.current = null;
  }
};

const schedulePendingSyncRetry = () => {
  if (pendingSyncRetryTimerRef.current || !pendingEventsRef.current.length) return;

  pendingSyncRetryTimerRef.current = window.setTimeout(() => {
    pendingSyncRetryTimerRef.current = null;
    setPendingSyncRetryTick((value) => value + 1);
  }, PENDING_SYNC_RETRY_DELAY_MS);
};

const clearLiveOutcomeBadge = () => {
  if (liveOutcomeBadgeTimerRef.current) {
    window.clearTimeout(liveOutcomeBadgeTimerRef.current);
    liveOutcomeBadgeTimerRef.current = null;
  }
};

const showLiveOutcomeBadge = (outcome) => {
  if (!outcome) return;
  clearLiveOutcomeBadge();
  setLiveOutcomeBadge(outcome);
  liveOutcomeBadgeTimerRef.current = window.setTimeout(() => {
    liveOutcomeBadgeTimerRef.current = null;
    setLiveOutcomeBadge(null);
  }, LIVE_OUTCOME_BADGE_DURATION_MS);
};

const clearSaveFeedbackBadge = () => {
  if (saveFeedbackTimerRef.current) {
    window.clearTimeout(saveFeedbackTimerRef.current);
    saveFeedbackTimerRef.current = null;
  }
};

const showSaveFeedbackBadge = (badge) => {
  if (!badge) return;
  clearSaveFeedbackBadge();
  setSaveFeedbackBadge(badge);

  if (badge.tone === "success" && typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
    navigator.vibrate(12);
  }

  saveFeedbackTimerRef.current = window.setTimeout(() => {
    saveFeedbackTimerRef.current = null;
    setSaveFeedbackBadge(null);
  }, SAVE_FEEDBACK_DURATION_MS);
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

  ballsRef.current = nextState.balls;
  inningsRef.current = nextState.innings;

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
    const optimisticState = applyOptimisticEventState(normalizedEvent);
    setInfo(optimisticQueuedInfo);
    return { queued: true, result: null, event: normalizedEvent, state: optimisticState };
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
      const optimisticState = applyOptimisticEventState(normalizedEvent);
      setInfo(optimisticQueuedInfo);
      return { queued: true, result: null, event: normalizedEvent, state: optimisticState };
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

  const nextState = applyServerEventState(normalizedEvent, data || {});
  setPendingEvents((prev) => removePendingEvent(prev, normalizedEvent.event_id));
  if (successInfo) setInfo(successInfo);
  return { queued: false, result: data || null, event: normalizedEvent, state: nextState };
};

const flushPendingQueue = async () => {
  if (
    !canAutoFlushPendingQueue({
      matchId,
      isOnline,
      pendingCount: pendingEventsRef.current.length,
      lockFeatureAvailable,
      scoringLocked,
      isFlushing: flushingQueueRef.current,
    })
  ) {
    return;
  }

  clearPendingSyncRetry();
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
        if (isNetworkLikeError(error)) {
          schedulePendingSyncRetry();
          break;
        }
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
          clearPendingSyncRetry();
          const nextQueue = removePendingEventsForInnings(pendingEventsRef.current, event.innings_id);
          setPendingEvents(nextQueue);
          await reloadCurrentInningsState(event.innings_id);
          if (event.innings_id === inningsRef.current?.id) {
            const recovery = await loadCanonicalRecoveryState(matchId, event.innings_id);
            setReopenedForContinuation(!!recovery.reopenedForContinuation);
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

        clearPendingSyncRetry();
        setErr(`Pending sync failed: ${message}`);
        break;
      }

      const nextState = applyServerEventState(event, data || {});
      if (event.innings_id === inningsRef.current?.id) {
        if (nextState.invalidatesPostState) {
          if (event.event_type === "edit_ball") {
            const nextBalls = nextState.balls || ballsRef.current;
            const editedBall = sortBallsByPosition(nextBalls).slice(-1)[0] || null;
            const resolution = reconcileLatestEditSelections({
              originalBall: event.payload?.original_ball || null,
              editedBall,
              nextBalls,
              nextInnings: nextState.innings || inningsRef.current,
              preEditPostState: event.payload?.pre_edit_post_state || null,
            });
            setInfo(`A pending delivery edit synced. ${describeLatestEditResolution(resolution)}`);
          } else {
            clearScorerState(matchId, event.innings_id, persistenceScope);
            clearLiveSelections();
            setInfo("A pending delivery edit synced. Re-select striker, non-striker, and bowler before scoring again.");
          }
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

    if (isScorerOwnershipError(error)) {
      setLockReady(false);
      setScoringLocked(false);
      setActiveScorerSession(null);
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

const claimScorerRole = async ({ force = false } = {}) => {
  if (!matchId) return false;
  if (!currentUserId) {
    setErr("You must be logged in to claim scorer access for this match.");
    return false;
  }

  setClaimingScorerRole(true);
  setErr("");
  setInfo("");

  try {
    const { data, error } = await supabase.rpc("claim_match_scorer_ownership", {
      p_match_id: matchId,
      p_force: force,
    });

    if (error) {
      if (isMissingRpcError(error)) {
        throw new Error(missingRequiredRpcMessage("claim_match_scorer_ownership", "Scorer assignment"));
      }
      throw error;
    }

    const claimedMatch = data?.match && typeof data.match === "object" ? data.match : null;
    if (claimedMatch) {
      setMatch((prev) => (prev ? { ...prev, ...claimedMatch } : claimedMatch));
    }

    setScoringLocked(false);
    setLockReady(false);
    setOwnershipRefreshKey((value) => value + 1);

    const action = String(data?.action || "");
    let nextInfo = "Scorer assignment updated.";
    if (action === "assigned_self") nextInfo = "You are now the assigned scorer for this match.";
    if (action === "took_over") nextInfo = "You took over scorer ownership for this match.";
    if (action === "already_assigned") nextInfo = "You are already the assigned scorer for this match.";

    const lockAcquired = await acquireScorerLock(force);
    if (lockAcquired) {
      setInfo(
        action === "took_over"
          ? "You took over scorer ownership and control for this match."
          : `${nextInfo} Scorer control is ready.`
      );
      flushPendingQueue();
    } else {
      setInfo(nextInfo);
    }

    return true;
  } catch (error) {
    setErr(`Scorer assignment error: ${error?.message || error}`);
    return false;
  } finally {
    setClaimingScorerRole(false);
  }
};

const assignSelfAsScorer = async () => claimScorerRole({ force: false });

const takeOverScorerRole = async () => {
  // eslint-disable-next-line no-restricted-globals
  if (!confirm("Take over scoring for this match? This will reassign scorer ownership to your account and can supersede another active scorer session.")) {
    return;
  }
  await claimScorerRole({ force: true });
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
    setStartupLoading(true);

    (async () => {
      setLoading(true);
      setErr("");
      setInfo("");
      setSessionEvents([]);

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
          setStartupLoading(false);
          setLoading(false);
          return;
        }
        setErr(`Match load error: ${m.error.message}`);
        setMatch(null);
        setMatchId("");
        setStartupLoading(false);
        setLoading(false);
        return;
      }

      if (!m.data) {
        if (restoreSnapshot(storedSnapshot)) {
          setStartupLoading(false);
          setLoading(false);
          return;
        }
        setErr("No match found for this fixture.");
        setMatch(null);
        setMatchId("");
        setStartupLoading(false);
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

      const cap = await supabase
        .from("fixture_wicket_caps")
        .select("wicket_cap")
        .eq("fixture_id", m.data.fixture_id || m.data.id)
        .maybeSingle();
      if (alive && !cap.error) setFixtureDisplayWicketCap(cap.data?.wicket_cap ?? null);

      // If this match has no fixture_id (older data), normalise it so all routes work consistently.
      if (!m.data.fixture_id) {
        await supabase.from("matches").update({ fixture_id: m.data.id }).eq("id", m.data.id);
      }

      const restoredQueue = readStoredPendingQueue(m.data.id);
      if (alive) {
        setPendingEvents(restoredQueue);
      }

      if (!alive) return;
    })();

    return () => {
      alive = false;
    };
  }, [fixtureId]);

  // Always compute innings 1 totals for target/result
  useEffect(() => {
    if (!matchId) return;

    (async () => {
      const inn1Res = await getOrCreateInnings({ matchId, inningsNo: 1 });
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
  }, [matchId, ownershipRefreshKey]);

  // Also compute innings 2 totals for a reliable result calculation
  useEffect(() => {
    if (!matchId) return;

    (async () => {
      const inn2Res = await getOrCreateInnings({ matchId, inningsNo: 2 });
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
  }, [matchId, ownershipRefreshKey]);

  // If innings 1 is completed, auto-jump to innings 2 (unless user already chose otherwise)
  useEffect(() => {
    if (!matchId) return;
    if (!innings1Row?.completed) return;
    if (inningsNo !== 1) return;
    setInningsNo(2);
  }, [matchId, innings1Row?.completed, inningsNo]);

  // Load selected innings
  useEffect(() => {
    if (!matchId) return;

    if (inningsNo === 2 && innings1Row && !innings1Row.completed) {
      setErr("You can only start Innings 2 after Innings 1 is ended/completed.");
      setInningsNo(1);
      return;
    }

    let alive = true;
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

      const inn = await getOrCreateInnings({ matchId, inningsNo });
      if (!alive) return;
      if (inn.error) {
        if (isScorerOwnershipError(inn.error)) {
          setStartupLoading(false);
          setLoading(false);
          return;
        }
        setErr(`Innings load/create error: ${inn.error.message}`);
        setStartupLoading(false);
        setLoading(false);
        return;
      }
      setInnings(inn.data);

      const batPlayersRes = await loadSquadPlayers({ fixtureId: canonicalFixtureId || fixtureId, teamId: inn.data.batting_team_id });
      if (!alive) return;
      if (batPlayersRes.error) {
        if (isNetworkLikeError(batPlayersRes.error) && Array.isArray(storedSnapshot?.battingPlayers)) {
          setBattingPlayers(storedSnapshot.battingPlayers);
        } else {
          setErr(`Batting roster error: ${batPlayersRes.error.message}`);
          setStartupLoading(false);
          setLoading(false);
          return;
        }
      }

      const bowlPlayersRes = await loadSquadPlayers({ fixtureId: canonicalFixtureId || fixtureId, teamId: inn.data.bowling_team_id });
      if (!alive) return;
      if (bowlPlayersRes.error) {
        if (isNetworkLikeError(bowlPlayersRes.error) && Array.isArray(storedSnapshot?.bowlingPlayers)) {
          setBowlingPlayers(storedSnapshot.bowlingPlayers);
        } else {
          setErr(`Bowling roster error: ${bowlPlayersRes.error.message}`);
          setStartupLoading(false);
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
      if (!alive) return;

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
          setSessionEvents([]);
          setInfo("Offline snapshot restored for this innings. Pending events will sync when the network returns.");
          setStartupLoading(false);
          setLoading(false);
          return;
        }

        setErr(`Balls load error: ${b.error.message}`);
        setStartupLoading(false);
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
      const appliedEvents = await loadAppliedSessionEvents({ matchId, inningsId: inn.data.id });
      if (!alive) return;
      setSessionEvents(appliedEvents);
      const recovery = await loadCanonicalRecoveryState(matchId, inn.data.id);
      if (!alive) return;
      setReopenedForContinuation(!!recovery.reopenedForContinuation);

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
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "match_session_events", filter: `innings_id=eq.${inn.data.id}` },
          async () => {
            const nextEvents = await loadAppliedSessionEvents({ matchId, inningsId: inn.data.id });
            if (!alive) return;
            setSessionEvents(nextEvents);
          }
        )
        .subscribe();

      setStartupLoading(false);
      setLoading(false);
    })();

    return () => {
      alive = false;
      if (channel) supabase.removeChannel(channel);
    };
  }, [matchId, inningsNo, fixtureId, canonicalFixtureId, ownershipRefreshKey]);

  useEffect(() => {
    if (!innings) return;

    const runs = sumRuns(displayBalls);
    const wkts = sumWkts(displayBalls);
    const legal = legalBallsCount(displayBalls);

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
  }, [displayBalls, innings]);

  useEffect(() => {
    ballsRef.current = balls;
  }, [balls]);

  useEffect(() => {
    inningsRef.current = innings;
  }, [innings]);

  useEffect(() => {
    if (innings?.innings_no !== 2 || innings?.completed) {
      setReopenedForContinuation(false);
    }
  }, [innings?.completed, innings?.innings_no, matchId]);

  useEffect(() => {
    reopenedForContinuationRef.current = reopenedForContinuation;
  }, [reopenedForContinuation]);

  useEffect(() => {
    strikerIdRef.current = strikerId;
    nonStrikerIdRef.current = nonStrikerId;
    strikerTurnRef.current = strikerTurn;
    nonStrikerTurnRef.current = nonStrikerTurn;
    bowlerIdRef.current = bowlerId;
  }, [bowlerId, nonStrikerId, nonStrikerTurn, strikerId, strikerTurn]);

  useEffect(() => {
    pendingEventsRef.current = pendingEvents;
    if (!pendingEvents.length) clearPendingSyncRetry();
    if (matchId) {
      writePendingEvents(matchId, pendingEvents, persistenceScope);
    }
  }, [matchId, pendingEvents, persistenceScope]);

  useEffect(() => {
    savingRef.current = saving;
  }, [saving]);

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => {
      clearPendingSyncRetry();
      setIsOnline(false);
    };

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
      reopenedForContinuation,
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
    reopenedForContinuation,
    strikerId,
    strikerTurn,
  ]);

  useEffect(() => {
    return () => {
      clearPendingSyncRetry();
      clearLiveOutcomeBadge();
      clearSaveFeedbackBadge();
    };
  }, []);

  useEffect(() => {
    const nextKey = latestCompetitiveBall
      ? String(latestCompetitiveBall.id || latestCompetitiveBall.source_event_id || latestCompetitiveBall.local_temp_id || `${latestCompetitiveBall.over_no}.${latestCompetitiveBall.delivery_in_over}`)
      : "";

    if (!nextKey) {
      latestOutcomeBallKeyRef.current = "";
      return;
    }

    if (!latestOutcomeBallKeyRef.current) {
      latestOutcomeBallKeyRef.current = nextKey;
      return;
    }

    if (latestOutcomeBallKeyRef.current === nextKey) return;

    latestOutcomeBallKeyRef.current = nextKey;
    showLiveOutcomeBadge(describeBallOutcomeBadge(latestCompetitiveBall));
  }, [latestCompetitiveBall]);

  useEffect(() => {
    if (!matchId || !lockFeatureAvailable || !isOnline) return;
    acquireScorerLock(false);
  }, [isOnline, lockFeatureAvailable, matchId, ownershipRefreshKey]);

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
    if (
      !canAutoFlushPendingQueue({
        matchId,
        isOnline,
        pendingCount: pendingEvents.length,
        lockFeatureAvailable,
        scoringLocked,
        isFlushing: isFlushingQueue,
      })
    ) {
      return;
    }
    flushPendingQueue();
  }, [isFlushingQueue, isOnline, lockFeatureAvailable, lockReady, matchId, pendingEvents.length, pendingSyncRetryTick, scoringLocked]);

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
  const exitsSeen = new Map();
  displayBalls.forEach((b) => {
    pushAppearance(b.striker_id, b.batting_turn || 1);
    pushAppearance(b.non_striker_id, (exitsSeen.get(b.non_striker_id) || 0) + 1);

    if (b.wicket && b.dismissed_player_id) {
      const nextExit = (exitsSeen.get(b.dismissed_player_id) || 0) + 1;
      exitsSeen.set(b.dismissed_player_id, nextExit);
      pushAppearance(b.dismissed_player_id, nextExit);
    }
  });

  // Ensure current crease stints are always included.
  pushAppearance(strikerId, strikerTurn);
  pushAppearance(nonStrikerId, nonStrikerTurn);

  for (const ap of appearances) {
    const p = battingPlayers.find((x) => x.id === ap.playerId);
    if (!p) continue;

    const facedAsStriker = displayBalls.filter((b) => b.striker_id === ap.playerId && toInt(b.batting_turn, 1) === ap.turn);
    const ballsFaced = facedAsStriker.filter((b) => didBatterFaceBall(b)).length;
    const runs = facedAsStriker.reduce((acc, b) => acc + (b.runs_off_bat || 0), 0);
    const fours = facedAsStriker.filter((b) => (b.runs_off_bat || 0) === 4).length;
    const sixes = facedAsStriker.filter((b) => (b.runs_off_bat || 0) === 6).length;
    const sr = ballsFaced > 0 ? ((runs / ballsFaced) * 100).toFixed(1) : "0.0";

    const atCreaseThisStint =
      (ap.playerId === strikerId && ap.turn === strikerTurn) || (ap.playerId === nonStrikerId && ap.turn === nonStrikerTurn);

    const dismissals = dismissalsByBatter.get(ap.playerId) || 0;
    const batterStatus = selectBatterStatus({
      balls: displayBalls,
      playerId: ap.playerId,
      turn: ap.turn,
      isAtCrease: atCreaseThisStint,
    });

    const status = batterStatus.label;

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
      statusTone: batterStatus.tone,
    });
  }

  // Only show stints that have started or are currently at the crease.
  return rows.filter((r) => r.isAtCrease || r.balls > 0);
}, [battingPlayers, displayBalls, strikerId, nonStrikerId, strikerTurn, nonStrikerTurn, dismissalsByBatter]);

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
      const lastCompetitive = [...balls].reverse().find((b) => !isAdministrativeBall(b));
      if (lastCompetitive?.bowler_id && bowlerId !== lastCompetitive.bowler_id) {
        return { ok: false, msg: "Bowler cannot change mid-over." };
      }
    }

    return { ok: true, msg: "" };
  };

  const canScore = ({ requireBowler = true } = {}) => {
    const currentInnings = inningsRef.current;
    const currentBalls = ballsRef.current;
    const currentStrikerId = strikerIdRef.current;
    const currentNonStrikerId = nonStrikerIdRef.current;
    const currentBowlerId = bowlerIdRef.current;
    const currentNextPos = computeNextPosition(currentBalls);
    const currentLastOverBowlerId = currentBalls[currentBalls.length - 1]?.bowler_id || "";
    const currentChaseComplete =
      isChaseCompleteForScoring({
        inningsNo: currentInnings?.innings_no || 1,
        innings1Ready: !!innings1Row?.completed,
        innings1Runs,
        totalRuns: sumRuns(currentBalls),
        reopenedForContinuation: reopenedForContinuationRef.current,
      });
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

    if (requireBowler) {
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
    }

    return { ok: true, msg: "" };
  };

  const insertBall = async ({
    runs_off_bat = 0,
    extra_type = null,
    extra_runs = null,
    wicket = false,
    dismissal_kind = null,
    dismissed_player_id = null,
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
      const priorOverBalls = currentBalls.filter(
        (ball) => toInt(ball?.over_no, 0) === pos.over_no && toInt(ball?.delivery_in_over, 0) < pos.delivery_in_over
      );
      const normalizedDelivery = normalizeDeliveryOutcome({
        runsOffBat: runs_off_bat,
        extraType: extra_type,
        extraRuns: extra_runs,
        priorOverBalls,
      });
      const legal_ball = normalizedDelivery.legalBall;

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

      const batting_turn = getTurnFor(currentStrikerId);

      const payload = {
        match_id: matchId,
        innings_id: currentInnings.id,
        over_no: pos.over_no,
        delivery_in_over: pos.delivery_in_over,
        legal_ball,
        runs_off_bat: normalizedDelivery.runsOffBat,
        extra_type: normalizedDelivery.extraType,
        extra_runs: normalizedDelivery.extraRuns,
        wicket,
        dismissal_kind: wicket ? dismissal_kind : null,
        dismissed_player_id: wicket ? (dismissed_player_id || currentStrikerId) : null,
        striker_id: currentStrikerId,
        non_striker_id: currentNonStrikerId,
        bowler_id: currentBowlerId,
        batting_turn,
      };

      const previewEvent = {
        created_at: new Date().toISOString(),
        event_id: "preview-ball",
        event_type: DELIVERY_RECORDED_EVENT_TYPE,
        innings_id: currentInnings.id,
        match_id: matchId,
        payload: {
          delivery: payload,
        },
      };

      const nextBalls = applyEventOptimistically({
        balls: currentBalls,
        innings: currentInnings,
        event: previewEvent,
      }).balls;

      // No ball penalty run (extra_runs=1) is awarded automatically and doesn't
      // represent physical running between the wickets, so exclude it from rotation.
      const runsForRotation = payload.extra_type === "noball"
        ? (payload.runs_off_bat || 0)
        : (payload.runs_off_bat || 0) + (payload.extra_runs || 0);
      let nextStrikerId = currentStrikerId;
      let nextNonStrikerId = currentNonStrikerId;

      if (!payload.wicket && runsForRotation % 2 === 1) {
        [nextStrikerId, nextNonStrikerId] = [nextNonStrikerId, nextStrikerId];
      }

      const overCountsAfter = getOverCounts(nextBalls, payload.over_no);
      const overFinishedAfter = isOverFinished(overCountsAfter);
      const projectedRuns = sumRuns(nextBalls);
      const projectedWickets = sumWkts(nextBalls);
      const projectedLegalBalls = legalBallsCount(nextBalls);
      const projectedChaseComplete =
        isChaseCompleteForScoring({
          inningsNo: currentInnings?.innings_no || 1,
          innings1Ready: !!innings1Row?.completed,
          innings1Runs,
          totalRuns: projectedRuns,
          reopenedForContinuation: reopenedForContinuationRef.current,
        });
      const projectedInningsComplete =
        projectedLegalBalls >= maxLegal ||
        projectedWickets >= wicketCap ||
        projectedChaseComplete ||
        !!currentInnings?.completed;
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
        event_type: DELIVERY_RECORDED_EVENT_TYPE,
        innings_id: currentInnings.id,
        match_id: matchId,
        payload: {
          delivery: payload,
          post_state: postState,
        },
      };

      const saveResult = await applySessionEvent(event, {
        failurePrefix: "Ball save",
        successInfo: "Saved.",
      });

      showSaveFeedbackBadge(
        saveResult.queued
          ? { label: "Queued offline", tone: "queued" }
          : { label: "Saved", tone: "success" }
      );

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
    setWicketCrossed(false);
    setIncomingBatterId("");
    setDismissalKind("bowled");
    setDismissedPlayerId(strikerId || "");
    setWicketBatRuns(0);
    setWicketExtraType(null);
    setWicketExtraRuns(0);
    setNeedsWicketModal(true);
  };

  const addRetiredHurt = async () => {
    setErr("");
    setInfo("");

    const ok = canScore({ requireBowler: false });
    if (!ok.ok) {
      setErr(ok.msg);
      return;
    }

    const currentInnings = inningsRef.current;
    const currentStrikerId = strikerIdRef.current;
    const currentNonStrikerId = nonStrikerIdRef.current;

    if (!currentInnings?.id) {
      setErr("Innings not loaded.");
      return;
    }
    if (!dismissedPlayerId) {
      setErr("Select who is retired hurt (striker/non-striker).");
      return;
    }
    if (!incomingBatterId) {
      setErr("Select the replacement batter.");
      return;
    }
    if (dismissedPlayerId !== currentStrikerId && dismissedPlayerId !== currentNonStrikerId) {
      setErr("Retired hurt must apply to the current striker or non-striker.");
      return;
    }

    const outWasStriker = dismissedPlayerId === currentStrikerId;
    const retiredHurtPostState = buildScorerPostState({
      strikerId: outWasStriker ? incomingBatterId : currentStrikerId,
      nonStrikerId: outWasStriker ? currentNonStrikerId : incomingBatterId,
      strikerTurn: getTurnFor(outWasStriker ? incomingBatterId : currentStrikerId),
      nonStrikerTurn: getTurnFor(outWasStriker ? currentNonStrikerId : incomingBatterId),
      bowlerId: needsNextBowler ? "" : (bowlerIdRef.current || ""),
      needsNextBowler: !!needsNextBowler,
    });

    await applySessionEvent(
      {
        created_at: new Date().toISOString(),
        event_id: createEventId("admin-state"),
        event_type: ADMINISTRATIVE_STATE_CHANGED_EVENT_TYPE,
        innings_id: currentInnings.id,
        match_id: matchId,
        payload: {
          action_type: "retired_hurt",
          dismissed_player_id: dismissedPlayerId,
          replacement_player_id: incomingBatterId,
          post_state: retiredHurtPostState,
        },
      },
      {
        failurePrefix: "Retired hurt",
        successInfo: "Retired hurt recorded.",
        optimisticQueuedInfo: "Offline: retired hurt queued locally.",
      }
    );

    setStrikerSelection(retiredHurtPostState.striker_id || "");
    setNonStrikerSelection(retiredHurtPostState.non_striker_id || "");
    setBowlerId(retiredHurtPostState.bowler_id || "");
    setNeedsNextBowler(!!retiredHurtPostState.needs_next_bowler);
    setNeedsWicketModal(false);
    setDismissalKind("bowled");
    setDismissedPlayerId("");
    setIncomingBatterId("");
    setWicketBatRuns(0);
    setWicketExtraType(null);
    setWicketExtraRuns(0);
    setWicketCrossed(false);
  };

  // Incoming batters:
  // - allow ANY squad player not currently at crease (even if dismissed before),
  //   because players may bat twice under wicket cap rule.
  const availableIncomingBatters = useMemo(() => {
    return battingPlayers.filter((p) => p.id !== strikerId && p.id !== nonStrikerId);
  }, [battingPlayers, strikerId, nonStrikerId]);

  const confirmWicket = async () => {
    setErr("");

    if (!dismissedPlayerId) {
      setErr("Select who was dismissed (striker/non-striker).");
      return;
    }
    if (dismissedPlayerId !== strikerId && dismissedPlayerId !== nonStrikerId) {
      setErr("Dismissed player must be striker or non-striker.");
      return;
    }

    const wicketInput = validateWicketDeliveryInput({
      dismissalKind,
      runsOffBat: wicketBatRuns,
      extraType: wicketExtraType,
      extraRuns: wicketExtraRuns,
    });

    if (!wicketInput.ok) {
      setErr(wicketInput.message);
      return;
    }

    const currentBalls = ballsRef.current;
    const currentInnings = inningsRef.current;
    const currentStrikerId = strikerIdRef.current;
    const currentNonStrikerId = nonStrikerIdRef.current;
    const currentBowlerId = bowlerIdRef.current;
    const position = computeNextPosition(currentBalls);
    const priorOverBalls = currentBalls.filter(
      (ball) => toInt(ball?.over_no, 0) === position.over_no && toInt(ball?.delivery_in_over, 0) < position.delivery_in_over
    );
    const normalizedDelivery = normalizeDeliveryOutcome({
      runsOffBat: wicketInput.runsOffBat,
      extraType: wicketInput.extraType,
      extraRuns: wicketInput.extraRuns,
      priorOverBalls,
    });

    const previewPayload = {
      over_no: position.over_no,
      delivery_in_over: position.delivery_in_over,
      legal_ball: normalizedDelivery.legalBall,
      runs_off_bat: normalizedDelivery.runsOffBat,
      extra_type: normalizedDelivery.extraType,
      extra_runs: normalizedDelivery.extraRuns,
      wicket: true,
      dismissal_kind: wicketInput.dismissalKind,
      dismissed_player_id: dismissedPlayerId,
      striker_id: currentStrikerId,
      non_striker_id: currentNonStrikerId,
      bowler_id: currentBowlerId,
    };
    const previewEvent = {
      created_at: new Date().toISOString(),
      event_id: "preview-wicket",
      event_type: DELIVERY_RECORDED_EVENT_TYPE,
      innings_id: currentInnings?.id || "",
      match_id: matchId,
      payload: { delivery: previewPayload },
    };
    const nextBalls = applyEventOptimistically({
      balls: currentBalls,
      innings: currentInnings,
      event: previewEvent,
    }).balls;

    const projectedLegalBalls = legalBallsCount(nextBalls);
    const projectedWickets = sumWkts(nextBalls);
    const projectedRuns = sumRuns(nextBalls);
    const projectedChaseComplete =
      isChaseCompleteForScoring({
        inningsNo: currentInnings?.innings_no || 1,
        innings1Ready: !!innings1Row?.completed,
        innings1Runs,
        totalRuns: projectedRuns,
        reopenedForContinuation: reopenedForContinuationRef.current,
      });
    const projectedInningsComplete =
      projectedLegalBalls >= maxLegal ||
      projectedWickets >= wicketCap ||
      projectedChaseComplete ||
      !!currentInnings?.completed;
    const overCountsAfter = getOverCounts(nextBalls, previewPayload.over_no);
    const overFinishedAfter = isOverFinished(overCountsAfter);

    if (!projectedInningsComplete && !incomingBatterId) {
      setErr("Select the incoming batter.");
      return;
    }

    let wicketPostState;
    try {
      wicketPostState = deriveWicketPostState({
        strikerId: currentStrikerId,
        nonStrikerId: currentNonStrikerId,
        incomingBatterId,
        dismissedPlayerId,
        dismissalKind: wicketInput.dismissalKind,
        totalRunsOnBall: normalizedDelivery.extraType === "noball"
          ? normalizedDelivery.runsOffBat
          : normalizedDelivery.runsOffBat + normalizedDelivery.extraRuns,
        crossed: wicketCrossed,
        overFinishedAfter,
        inningsComplete: projectedInningsComplete,
        bowlerId: currentBowlerId,
        getTurnFor,
      });
    } catch (error) {
      setErr(String(error?.message || error || "Invalid wicket state."));
      return;
    }

    const { postState, saved } = await insertBall({
      runs_off_bat: normalizedDelivery.runsOffBat,
      extra_type: normalizedDelivery.extraType,
      extra_runs: normalizedDelivery.extraRuns,
      wicket: true,
      dismissal_kind: wicketInput.dismissalKind,
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
    setDismissalKind("bowled");
    setDismissedPlayerId("");
    setIncomingBatterId("");
    setWicketBatRuns(0);
    setWicketExtraType(null);
    setWicketExtraRuns(0);
    setWicketCrossed(false);

    if (resolvedPostState.needs_next_bowler) {
      setInfo("Over complete - select a new bowler.");
    }
  };

  const endInnings = async () => {
    if (!innings?.id) return;
    if (scoringLocked) {
      setErr("Another scorer session currently holds this match. Use override to take control.");
      return;
    }
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
      setReopenedForContinuation(false);
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
    if (scoringLocked) {
      setErr("Another scorer session currently holds this match. Use override to take control.");
      return;
    }
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
      setReopenedForContinuation(innings?.innings_no === 2);
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

    try {
      const { error } = await supabase.rpc("reset_match_state", {
        p_match_id: match.id,
        p_client_session_id: clientSessionId,
        p_clear_squads: true,
      });

      if (error) {
        if (isMissingRpcError(error)) {
          throw new Error(missingRequiredRpcMessage("reset_match_state", "Match reset"));
        }
        throw new Error(`Reset failed: ${error.message}`);
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
      if (isBowlerCreditedWicket(b)) s.wickets += 1;

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

  const currentStrikerRow = useMemo(
    () => battingScorecardRows.find((row) => row.id === strikerId && row.turn === strikerTurn) || null,
    [battingScorecardRows, strikerId, strikerTurn]
  );
  const currentNonStrikerRow = useMemo(
    () => battingScorecardRows.find((row) => row.id === nonStrikerId && row.turn === nonStrikerTurn) || null,
    [battingScorecardRows, nonStrikerId, nonStrikerTurn]
  );
  const scorerQuickBadges = useMemo(() => {
    const badges = [];

    if (!isOnline) {
      badges.push("Offline");
    } else if (isFlushingQueue) {
      badges.push("Syncing");
    } else if (pendingEvents.length) {
      badges.push(`${pendingEvents.length} queued`);
    } else {
      badges.push("Ready");
    }

    if (scoringLocked) badges.push("Locked");
    if (innings?.completed) badges.push("Completed");

    return badges;
  }, [innings?.completed, isFlushingQueue, isOnline, pendingEvents.length, scoringLocked]);
  const quickContextText = useMemo(() => {
    if (inningsNo === 2) {
      return `Need ${runsRemaining ?? 0} off ${ballsRemaining}`;
    }
    return `Innings ${inningsNo}`;
  }, [ballsRemaining, inningsNo, runsRemaining]);
  const primaryStrikerLabel = currentStrikerRow?.name || "Select striker";
  const primaryBowlerLabel = currentBowlerRow?.name || "Select bowler";
  const bottomDockReserve = isPhoneViewport
    ? (keypadTab === "extras" ? 344 : 300)
    : 288;

  const keyBtnStyle = {
    minHeight: isPhoneViewport ? 52 : 48,
    padding: isPhoneViewport ? "14px 10px" : "12px 10px",
    borderRadius: 16,
    border: "1px solid rgba(255,255,255,0.14)",
    background: "rgba(255,255,255,0.06)",
    color: "#e8eefc",
    fontWeight: 900,
    fontSize: isPhoneViewport ? 15 : 14,
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
    minHeight: isPhoneViewport ? 46 : undefined,
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
    minHeight: 44,
    padding: "10px 12px",
    borderRadius: 12,
    background: "rgba(255,255,255,0.06)",
    border: "1px solid rgba(255,255,255,0.14)",
    color: "#e8eefc",
    fontWeight: 900,
    cursor: "pointer",
  };

  const modalBtnPrimary = {
    minHeight: 44,
    padding: "10px 12px",
    borderRadius: 12,
    background: "rgba(255,255,255,0.10)",
    border: "1px solid rgba(255,255,255,0.18)",
    color: "#e8eefc",
    fontWeight: 900,
    cursor: "pointer",
  };

  if ((loading || startupLoading) && !err) return <ScoreViewLoadingShell />;

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
        <div style={{ maxWidth: 980, margin: "0 auto", padding: isPhoneViewport ? "10px 12px" : "12px 14px", display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
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

      <div
        style={{
          maxWidth: 980,
          margin: "0 auto",
          padding: `14px 14px calc(${bottomDockReserve}px + env(safe-area-inset-bottom))`,
          scrollPaddingBottom: `calc(${bottomDockReserve}px + env(safe-area-inset-bottom))`,
        }}
      >
        <ScorerStickyHeader
          visible={showStickyScoreHeader}
          score={`${totalRuns}/${wickets}`}
          oversText={oversText}
          context={quickContextText}
          strikerLabel={primaryStrikerLabel}
          bowlerLabel={primaryBowlerLabel}
          badges={scorerQuickBadges}
          isPhoneViewport={isPhoneViewport}
        />

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

        {scorerStatusBanner ? (
          <div
            style={{
              marginTop: 10,
              padding: isPhoneViewport ? 11 : 12,
              borderRadius: 12,
              background: scorerStatusBanner.tone.background,
              border: scorerStatusBanner.tone.border,
              color: scorerStatusBanner.tone.color,
              display: isPhoneViewport ? "grid" : "flex",
              gap: 12,
              alignItems: "flex-start",
              flexWrap: "wrap",
            }}
          >
            <div style={{ minWidth: isPhoneViewport ? 0 : 160 }}>
              <div style={{ fontWeight: 900 }}>{scorerStatusBanner.title}</div>
              <div style={{ marginTop: 6, display: "flex", gap: 6, flexWrap: "wrap" }}>
                {scorerStatusBanner.badges.map((badge) => (
                  <span
                    key={badge}
                    style={{
                      padding: "3px 8px",
                      borderRadius: 999,
                      fontSize: 11,
                      fontWeight: 800,
                      background: "rgba(255,255,255,0.08)",
                      border: "1px solid rgba(255,255,255,0.12)",
                      color: "inherit",
                    }}
                  >
                    {badge}
                  </span>
                ))}
              </div>
            </div>
            <div style={{ flex: "1 1 320px", color: "rgba(255,255,255,0.82)" }}>
              {scorerStatusBanner.message}
              {!isOnline ? (
                <div style={{ marginTop: 6, fontSize: 12, color: "rgba(255,255,255,0.68)" }}>
                  {pendingEvents.length
                    ? `${pendingEvents.length} queued event${pendingEvents.length === 1 ? "" : "s"} will replay when the connection returns.`
                    : "You can view the scorer, but new online actions will wait for connectivity."}
                </div>
              ) : null}
            </div>
            {scorerAssignmentState === "unassigned" ? (
              <button onClick={assignSelfAsScorer} disabled={claimingScorerRole || !isOnline} style={{ ...modalBtnGhost, width: isPhoneViewport ? "100%" : undefined }}>
                {claimingScorerRole ? "Assigning..." : "Assign myself"}
              </button>
            ) : null}
            {scorerAssignmentState === "assigned_elsewhere" ? (
              <button onClick={takeOverScorerRole} disabled={claimingScorerRole || !isOnline} style={{ ...modalBtnGhost, width: isPhoneViewport ? "100%" : undefined }}>
                {claimingScorerRole ? "Taking over..." : "Take over scoring"}
              </button>
            ) : null}
            {scorerAssignmentState === "mine" && scoringLocked ? (
              <button onClick={takeScorerControl} disabled={takingControl || !isOnline} style={{ ...modalBtnGhost, width: isPhoneViewport ? "100%" : undefined }}>
                {takingControl ? "Taking control..." : "Take control"}
              </button>
            ) : null}
          </div>
        ) : null}

        {/* Score header */}
        <div
          ref={scoreHeroRef}
          style={{
            marginTop: 12,
            padding: isPhoneViewport ? 12 : 14,
            borderRadius: 16,
            border: "1px solid rgba(255,255,255,0.10)",
            background: "rgba(255,255,255,0.04)",
            boxShadow: "0 10px 30px rgba(0,0,0,0.25)",
            position: "relative",
            overflow: "hidden",
          }}
        >
          {isPhoneViewport ? (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: liveOutcomeBadge || saveFeedbackBadge ? 10 : 0 }}>
              <LiveOutcomeBadge outcome={liveOutcomeBadge} visible={!!liveOutcomeBadge} />
              <LiveOutcomeBadge outcome={saveFeedbackBadge} visible={!!saveFeedbackBadge} style={{ minHeight: 30, fontSize: 11, letterSpacing: 0.3 }} />
            </div>
          ) : (
            <div style={{ position: "absolute", top: 12, right: 12, display: "grid", gap: 8, justifyItems: "end", pointerEvents: "none" }}>
              <LiveOutcomeBadge outcome={liveOutcomeBadge} visible={!!liveOutcomeBadge} />
              <LiveOutcomeBadge outcome={saveFeedbackBadge} visible={!!saveFeedbackBadge} style={{ minHeight: 30, fontSize: 11, letterSpacing: 0.3 }} />
            </div>
          )}

          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <div style={{ fontSize: isPhoneViewport ? 38 : 34, fontWeight: 900, letterSpacing: -0.5, lineHeight: 1 }}>
              {totalRuns}/{wickets}
              <span style={{ display: isPhoneViewport ? "block" : "inline", fontSize: 14, fontWeight: 700, marginLeft: isPhoneViewport ? 0 : 10, marginTop: isPhoneViewport ? 8 : 0, color: "rgba(232,238,252,0.75)" }}>
                ({oversText} / {oversLimit} ov) • 7-ball overs rule • Wicket cap {displayWicketCap}
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

          {currentOverSummary?.balls?.length ? (
            <div style={{ marginTop: 12, display: "grid", gap: 8 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", fontSize: 12, color: "rgba(232,238,252,0.72)", fontWeight: 900 }}>
                <span>This over</span>
                <span>{formatOverSummaryText(currentOverSummary)}</span>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {currentOverSummary.balls.map((ball) => {
                  const toneStyle = ballTokenStyle(ball);
                  return (
                    <div
                      key={ball.id || ball.source_event_id || ball.local_temp_id || `${ball.over_no}.${ball.delivery_in_over}`}
                      style={{
                        minWidth: isPhoneViewport ? 38 : 34,
                        height: isPhoneViewport ? 38 : 34,
                        padding: "0 10px",
                        borderRadius: 999,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontWeight: 1000,
                        fontSize: isPhoneViewport ? 14 : 13,
                        ...toneStyle,
                      }}
                    >
                      {formatBallOutcomeToken(ball)}
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}

          <div style={{ marginTop: 12, display: "grid", gap: 10 }}>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
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
            </div>

            <div style={{ display: "grid", gridTemplateColumns: isPhoneViewport ? "repeat(2, minmax(0, 1fr))" : "repeat(2, max-content)", gap: 10, justifyContent: isPhoneViewport ? "stretch" : "end" }}>
              <button
                onClick={resetMatchData}
                disabled={saving}
                style={{
                  minHeight: 44,
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
                <button onClick={reopenInnings} disabled={saving} style={{ ...modalBtnGhost, width: "100%" }}>
                  Reopen innings
                </button>
              ) : (
                <button
                  onClick={endInnings}
                  disabled={saving}
                  style={{
                    minHeight: 44,
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
                    <div style={{ display: "grid", gridTemplateColumns: "auto minmax(0, 1fr) auto", gap: 10, alignItems: "start" }}>
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
                      <div style={{ minWidth: 0, display: "grid", gap: 4 }}>
                        <div
                          style={{
                            fontWeight: 900,
                            fontSize: 16,
                            minWidth: 0,
                            display: "-webkit-box",
                            WebkitLineClamp: isPhoneViewport ? 2 : 1,
                            WebkitBoxOrient: "vertical",
                            overflow: "hidden",
                            lineHeight: 1.2,
                          }}
                        >
                          {name}
                        </div>
                        {id ? (
                          <div style={{ fontSize: 12, color: "rgba(232,238,252,0.70)", fontWeight: 900 }}>
                            Turn {turn || 1}
                          </div>
                        ) : null}
                      </div>
                      <div style={{ textAlign: "right", fontWeight: 900, fontSize: 18 }}>
                        {runs}
                        <span style={{ fontSize: 12, color: "rgba(232,238,252,0.70)", marginLeft: 6 }}>({ballsF})</span>
                      </div>
                    </div>

                    <div style={{ marginTop: 10, display: "flex", gap: isPhoneViewport ? 10 : 14, flexWrap: "wrap", color: "rgba(232,238,252,0.75)", fontSize: 12 }}>
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

            {strikerId && nonStrikerId ? (
              <div style={{ padding: "0 12px 12px" }}>
                <button
                  onClick={() => {
                    const prevStrikerId = strikerId;
                    const prevStrikerTurn = strikerTurn;
                    setStrikerId(nonStrikerId);
                    setStrikerTurn(nonStrikerTurn);
                    setNonStrikerId(prevStrikerId);
                    setNonStrikerTurn(prevStrikerTurn);
                  }}
                  disabled={saving || innings?.completed}
                  style={{
                    width: "100%",
                    minHeight: 40,
                    padding: "8px 12px",
                    borderRadius: 12,
                    background: "rgba(56,189,248,0.10)",
                    border: "1px solid rgba(56,189,248,0.28)",
                    color: "#7dd3fc",
                    fontWeight: 900,
                    fontSize: 13,
                    cursor: saving || innings?.completed ? "not-allowed" : "pointer",
                    letterSpacing: "0.02em",
                  }}
                >
                  ⇄ Swap strike
                </button>
              </div>
            ) : null}
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
                <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                  <div
                    style={{
                      fontWeight: 900,
                      fontSize: 16,
                      minWidth: 0,
                      flex: 1,
                      display: "-webkit-box",
                      WebkitLineClamp: isPhoneViewport ? 2 : 1,
                      WebkitBoxOrient: "vertical",
                      overflow: "hidden",
                      lineHeight: 1.2,
                    }}
                  >
                    {currentBowlerRow?.name || "Select bowler"}
                  </div>
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
                        style={{ ...modalBtnGhost, width: isPhoneViewport ? "100%" : undefined }}
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
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(72px, 1fr))", gap: 10 }}>
                {balls.slice(-18).reverse().map((b) => {
                  const label = isAdministrativeBall(b)
                    ? "RH"
                    : b.extra_type
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
                      key={b.id || b.local_temp_id}
                      title={`Over ${b.over_no}.${b.delivery_in_over}`}
                      style={{
                        width: "100%",
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
                      {b.wicket ? <div style={{ marginTop: 4, fontSize: 11, color: "#ffb3b3" }}>{isAdministrativeBall(b) ? "RH" : "W"}</div> : null}
                      {!b.id && b.local_temp_id ? (
                        <div style={{ marginTop: 4, fontSize: 10, color: "#ffe4b0" }}>Pending</div>
                      ) : null}
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
          boxShadow: "0 -16px 32px rgba(0,0,0,0.28)",
        }}
      >
        <div style={{ maxWidth: 980, margin: "0 auto", padding: "8px 10px calc(10px + env(safe-area-inset-bottom))", maxHeight: isPhoneViewport ? "58vh" : "none", overflowY: "auto" }}>
          <div style={{ display: "grid", gap: 8, marginBottom: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "flex-start", flexWrap: "wrap" }}>
              <div style={{ minWidth: 0, display: "grid", gap: 4 }}>
                <div style={{ fontSize: isPhoneViewport ? 17 : 18, fontWeight: 1000, color: "#f8fafc" }}>
                  {totalRuns}/{wickets}
                  <span style={{ marginLeft: 8, fontSize: 12, fontWeight: 800, color: "rgba(232,238,252,0.72)" }}>
                    {oversText} ov
                  </span>
                </div>
                <div style={{ fontSize: 11, color: "rgba(232,238,252,0.68)" }}>{quickContextText}</div>
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
                {scorerQuickBadges.map((badge) => (
                  <span
                    key={badge}
                    style={{
                      padding: "3px 8px",
                      borderRadius: 999,
                      fontSize: 11,
                      fontWeight: 900,
                      border: "1px solid rgba(255,255,255,0.12)",
                      background: "rgba(255,255,255,0.06)",
                      color: "#e8eefc",
                    }}
                  >
                    {badge}
                  </span>
                ))}
              </div>
            </div>
            <div style={{ display: isPhoneViewport ? "grid" : "flex", gridTemplateColumns: isPhoneViewport ? "repeat(2, minmax(0, 1fr))" : undefined, gap: 8, flexWrap: "wrap" }}>
              {[
                { label: "Striker", value: primaryStrikerLabel },
                { label: "Bowler", value: primaryBowlerLabel },
              ].map((item) => (
                <div
                  key={item.label}
                  style={{
                    minWidth: 0,
                    borderRadius: 12,
                    border: "1px solid rgba(255,255,255,0.10)",
                    background: "rgba(255,255,255,0.04)",
                    padding: "7px 9px",
                  }}
                >
                  <div style={{ fontSize: 10, fontWeight: 900, color: "rgba(232,238,252,0.62)" }}>{item.label}</div>
                  <div
                    style={{
                      marginTop: 3,
                      fontSize: 12,
                      fontWeight: 900,
                      color: "#e8eefc",
                      minWidth: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {item.value}
                  </div>
                </div>
              ))}
            </div>
          </div>

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
                  minHeight: 46,
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
                    minHeight: isPhoneViewport ? 56 : 50,
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
              <div style={{ display: "grid", gridTemplateColumns: isPhoneViewport ? "repeat(3,1fr)" : "repeat(5,1fr)", gap: 10 }}>
                {[2, 3, 4, 5, 6].map((n) => (
                  <button key={`wd${n}`} onClick={() => addWide(n)} disabled={saving || inningsComplete} style={keyBtnStyle}>
                    {n}wd
                  </button>
                ))}
              </div>

              <div style={{ fontWeight: 900, opacity: 0.9 }}>NO BALLS (1 run penalty + bat runs)</div>
              <div style={{ display: "grid", gridTemplateColumns: isPhoneViewport ? "repeat(3,1fr)" : "repeat(6,1fr)", gap: 10 }}>
                {[0, 1, 2, 3, 4, 6].map((n) => (
                  <button key={`nb${n}`} onClick={() => addNoBall(n)} disabled={saving || inningsComplete} style={keyBtnStyle}>
                    NB+{n}
                  </button>
                ))}
              </div>

              <div style={{ fontWeight: 900, opacity: 0.9 }}>BYES (team only)</div>
              <div style={{ display: "grid", gridTemplateColumns: isPhoneViewport ? "repeat(3,1fr)" : "repeat(5,1fr)", gap: 10 }}>
                {[1, 2, 3, 4, 5].map((n) => (
                  <button key={`b${n}`} onClick={() => addBye(n)} disabled={saving || inningsComplete} style={keyBtnStyle}>
                    {n}b
                  </button>
                ))}
              </div>

              <div style={{ fontWeight: 900, opacity: 0.9 }}>LEG BYES (team only)</div>
              <div style={{ display: "grid", gridTemplateColumns: isPhoneViewport ? "repeat(3,1fr)" : "repeat(5,1fr)", gap: 10 }}>
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
                  minHeight: 56,
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
            alignItems: isPhoneViewport ? "flex-end" : "center",
            justifyContent: "center",
            padding: isPhoneViewport ? "12px 12px calc(12px + env(safe-area-inset-bottom))" : 14,
            overflowY: "auto",
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "100%",
              maxWidth: 520,
              maxHeight: isPhoneViewport ? "min(78vh, calc(100vh - 24px - env(safe-area-inset-bottom)))" : "min(88vh, 760px)",
              overflowY: "auto",
              borderRadius: isPhoneViewport ? 20 : 18,
              border: "1px solid rgba(255,255,255,0.14)",
              background: "rgba(10,16,28,0.98)",
              padding: isPhoneViewport ? 12 : 14,
              boxShadow: "0 20px 60px rgba(0,0,0,0.50)",
            }}
          >
            <div style={{ fontWeight: 900, fontSize: 16 }}>Wicket</div>

            <div style={{ marginTop: 12, display: "grid", gap: 10 }}>
              <div>
                <div style={{ fontSize: 12, color: "rgba(232,238,252,0.65)", marginBottom: 6 }}>Dismissal</div>
                <select
                  value={dismissalKind}
                  onChange={(e) => {
                    const nextKind = e.target.value;
                    setDismissalKind(nextKind);
                    // Stumped only supports no extras or a base wide — clear incompatible extra selections.
                    if (nextKind === "stumped" && wicketExtraType !== null && wicketExtraType !== "wide") {
                      setWicketExtraType(null);
                      setWicketExtraRuns(0);
                    }
                  }}
                  style={modalSelectStyle}
                >
                  <option value="bowled">Bowled</option>
                  <option value="caught">Caught</option>
                  <option value="lbw">LBW</option>
                  <option value="run out">Run out</option>
                  <option value="stumped">Stumped</option>
                  <option value="hit wicket">Hit wicket</option>
                  <option value="retired hurt">Retired hurt</option>
                </select>
              </div>

              <div>
                <div style={{ fontSize: 12, color: "rgba(232,238,252,0.65)", marginBottom: 6 }}>Who is out?</div>
                <select value={dismissedPlayerId || ""} onChange={(e) => setDismissedPlayerId(e.target.value)} style={modalSelectStyle}>
                  <option value={strikerId || ""}>Striker</option>
                  <option value={nonStrikerId || ""}>Non-striker</option>
                </select>
              </div>

              <div>
                <div style={{ fontSize: 12, color: "rgba(232,238,252,0.65)", marginBottom: 6 }}>Replacement batter</div>
                <select value={incomingBatterId} onChange={(e) => setIncomingBatterId(e.target.value)} style={modalSelectStyle}>
                  <option value="">Select...</option>
                  {availableIncomingBatters.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>

              {dismissalKind === "run out" || dismissalKind === "stumped" ? (
                <>
                  <div>
                    <div style={{ fontSize: 12, color: "rgba(232,238,252,0.65)", marginBottom: 6 }}>Extra type</div>
                    <select
                      value={wicketExtraType || ""}
                      onChange={(e) => {
                        const next = e.target.value || null;
                        setWicketExtraType(next);
                        // A stumped wide must have exactly 2 extra runs (base wide only).
                        if (dismissalKind === "stumped" && next === "wide") setWicketExtraRuns(2);
                        if (!next) setWicketExtraRuns(0);
                      }}
                      style={modalSelectStyle}
                    >
                      <option value="">None</option>
                      <option value="wide">Wide</option>
                      {dismissalKind === "run out" && <option value="noball">No ball</option>}
                      {dismissalKind === "run out" && <option value="bye">Bye</option>}
                      {dismissalKind === "run out" && <option value="legbye">Leg bye</option>}
                    </select>
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: isPhoneViewport ? "1fr" : "1fr 1fr", gap: 10 }}>
                    <div>
                      <div style={{ fontSize: 12, color: "rgba(232,238,252,0.65)", marginBottom: 6 }}>Bat runs</div>
                      <input
                        type="number"
                        min="0"
                        max="6"
                        value={wicketBatRuns}
                        onChange={(e) => setWicketBatRuns(toInt(e.target.value, 0))}
                        disabled={dismissalKind === "stumped" || wicketExtraType === "wide" || wicketExtraType === "bye" || wicketExtraType === "legbye"}
                        style={modalInputStyle}
                      />
                    </div>

                    <div>
                      <div style={{ fontSize: 12, color: "rgba(232,238,252,0.65)", marginBottom: 6 }}>Extra runs</div>
                      <input
                        type="number"
                        min="0"
                        value={wicketExtraRuns}
                        onChange={(e) => setWicketExtraRuns(toInt(e.target.value, 0))}
                        disabled={dismissalKind === "stumped" && wicketExtraType === "wide"}
                        style={modalInputStyle}
                      />
                    </div>
                  </div>

                  <div style={{ fontSize: 12, color: "rgba(232,238,252,0.60)" }}>
                    {dismissalKind === "run out"
                      ? "Run out deliveries can include completed runs and extras."
                      : "Stumped currently supports either a standard wicket or a base wide only."}
                  </div>
                </>
              ) : null}

              {dismissalKind !== "retired hurt" && dismissalKind !== "run out" && dismissalKind !== "stumped" ? (
                <div style={{ fontSize: 12, color: "rgba(232,238,252,0.60)" }}>
                  This dismissal type is currently recorded as a zero-run, no-extra delivery.
                </div>
              ) : null}

              {dismissalKind !== "retired hurt" && dismissalKind !== "run out" && dismissalKind !== "stumped" ? (
                <label style={{ display: "flex", gap: 10, alignItems: "center" }}>
                  <input type="checkbox" checked={wicketCrossed} onChange={(e) => setWicketCrossed(e.target.checked)} />
                  <span style={{ fontWeight: 900 }}>Batters crossed</span>
                </label>
              ) : dismissalKind === "retired hurt" ? (
                <div style={{ fontSize: 12, color: "rgba(232,238,252,0.60)" }}>
                  Retired hurt is recorded without consuming a ball.
                </div>
              ) : null}

              <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", flexWrap: "wrap" }}>
                <button onClick={() => setNeedsWicketModal(false)} style={modalBtnGhost}>
                  Cancel
                </button>
                <button
                  onClick={dismissalKind === "retired hurt" ? addRetiredHurt : confirmWicket}
                  disabled={saving}
                  style={modalBtnPrimary}
                >
                  {dismissalKind === "retired hurt" ? "Confirm retired hurt" : "Confirm wicket"}
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
            alignItems: isPhoneViewport ? "flex-end" : "center",
            justifyContent: "center",
            padding: isPhoneViewport ? "12px 12px calc(12px + env(safe-area-inset-bottom))" : 14,
            overflowY: "auto",
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "100%",
              maxWidth: 520,
              maxHeight: isPhoneViewport ? "min(78vh, calc(100vh - 24px - env(safe-area-inset-bottom)))" : "min(88vh, 760px)",
              overflowY: "auto",
              borderRadius: isPhoneViewport ? 20 : 18,
              border: "1px solid rgba(255,255,255,0.14)",
              background: "rgba(10,16,28,0.98)",
              padding: isPhoneViewport ? 12 : 14,
              boxShadow: "0 20px 60px rgba(0,0,0,0.50)",
            }}
          >
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <div style={{ fontWeight: 900, fontSize: 16 }}>Edit last delivery</div>
              <div style={{ marginLeft: "auto", color: "rgba(232,238,252,0.65)", fontSize: 12 }}>
                {editBall.over_no}.{editBall.delivery_in_over}
              </div>
            </div>

            <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: isPhoneViewport ? "1fr" : "1fr 1fr", gap: 10 }}>
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
                      <option value="retired hurt" disabled>Retired hurt (record separately, not via ball edit)</option>
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

                    if (editIsWicket) {
                      const wicketValidation = validateWicketDeliveryInput({
                        dismissalKind: editDismissalKind,
                        runsOffBat: nextBatRuns,
                        extraType: editExtraType,
                        extraRuns: nextExtraRuns,
                      });

                      if (!wicketValidation.ok) {
                        throw new Error(wicketValidation.message);
                      }

                      nextBatRuns = wicketValidation.runsOffBat;
                      nextExtraRuns = wicketValidation.extraRuns;
                    }

                    const preEditPostState = buildScorerPostState({
                      strikerId: strikerIdRef.current,
                      nonStrikerId: nonStrikerIdRef.current,
                      strikerTurn: strikerTurnRef.current,
                      nonStrikerTurn: nonStrikerTurnRef.current,
                      bowlerId: bowlerIdRef.current,
                      needsNextBowler,
                    });

                    const editResponse = await applySessionEvent(
                      {
                        created_at: new Date().toISOString(),
                        event_id: createEventId("edit-ball"),
                        event_type: "edit_ball",
                        innings_id: innings.id,
                        match_id: matchId,
                        payload: {
                          ball_id: editBall.id || null,
                          target_source_event_id: editBall.source_event_id || editBall.local_temp_id || null,
                          original_ball: editBall,
                          pre_edit_post_state: preEditPostState,
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

                    const nextBalls = editResponse.state?.balls || ballsRef.current;
                    const editedBall = sortBallsByPosition(nextBalls).slice(-1)[0] || null;
                    const resolution = reconcileLatestEditSelections({
                      originalBall: editBall,
                      editedBall,
                      nextBalls,
                      nextInnings: editResponse.result?.innings || editResponse.state?.innings || inningsRef.current,
                      preEditPostState,
                    });

                    setInfo(describeLatestEditResolution(resolution));
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

