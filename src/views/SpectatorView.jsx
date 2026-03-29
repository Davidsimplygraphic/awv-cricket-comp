import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { supabase } from "../lib/supabase";

import LiveOutcomeBadge from "../components/LiveOutcomeBadge";
import {
  buildAutomaticMatchSummary,
  buildCompletedResultText,
  buildInningsTotals,
  countBattingExitsForPlayer,
  describeBallOutcomeBadge,
  didBatterFaceBall,
  deriveMatchDisplayStatus,
  isAdministrativeBall,
  isBattingSideWicket,
  isBowlerCreditedWicket,
  deriveRosterWicketCap,
  formatBallOutcomeToken,
  formatOverSummaryText,
  materializeAdministrativeStateBalls,
  oversTextFromLegal,
  resolveDisplayWicketCap,
  runsConcededByBowler,
  selectCurrentPartnership,
  selectCurrentOverSummary,
  sortBallsByPosition,
  sumRuns,
  toInt,
} from "../lib/scoring";

const BallByBall = lazy(() => import("../components/BallByBall"));
const Partnerships = lazy(() => import("../components/Partnerships"));
const WormGraph = lazy(() => import("../components/WormGraph"));
const ScorecardTables = lazy(() => import("../components/ScorecardTables"));

function currentTurnForPlayer(balls, playerId) {
  if (!playerId) return 1;
  return countBattingExitsForPlayer(balls, playerId) + 1;
}

function formatRate(value, digits = 2) {
  if (!Number.isFinite(value)) return "0.00";
  return value.toFixed(digits);
}

function formatStrikeRate(value) {
  if (!Number.isFinite(value)) return "0";
  return Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1);
}

function titleCaseWords(value) {
  return String(value || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => (part.toLowerCase() === "lbw" ? "LBW" : `${part[0].toUpperCase()}${part.slice(1).toLowerCase()}`))
    .join(" ");
}

function compactTeamName(team) {
  const full = String(team?.name || "").trim();
  const short = String(team?.short_name || "").trim();

  if (full && full.length <= 18) return full;
  if (short && short.length >= 3 && short.length <= 12) return short;
  if (!full) return short || "Team";

  const words = full.split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    const pair = `${words[0]} ${words[1]}`;
    if (pair.length <= 18) return pair;
  }

  return `${full.slice(0, 15).trim()}…`;
}

function batterStats(balls, batterId, turn = 1) {
  if (!batterId) return null;
  const t = toInt(turn, 1) || 1;
  const facedAsStriker = (balls || []).filter((b) => b.striker_id === batterId && toInt(b.batting_turn, 1) === t);
  const ballsFaced = facedAsStriker.filter((b) => didBatterFaceBall(b)).length;
  const runs = facedAsStriker.reduce((acc, b) => acc + toInt(b.runs_off_bat, 0), 0);
  const fours = facedAsStriker.filter((b) => toInt(b.runs_off_bat, 0) === 4).length;
  const sixes = facedAsStriker.filter((b) => toInt(b.runs_off_bat, 0) === 6).length;
  const sr = ballsFaced > 0 ? (runs / ballsFaced) * 100 : 0;
  return { r: runs, b: ballsFaced, sr, fours, sixes };
}

function bowlerStats(balls, bowlerId) {
  if (!bowlerId) return null;
  const by = (balls || []).filter((b) => b.bowler_id === bowlerId && !isAdministrativeBall(b));
  const legal = by.filter((b) => b.legal_ball !== false).length;
  const runs = by.reduce((acc, b) => acc + runsConcededByBowler(b), 0);
  const wkts = by.filter((b) => isBowlerCreditedWicket(b)).length;

  const byOver = new Map();
  for (const ball of by) {
    const overNo = toInt(ball.over_no, 0);
    if (!byOver.has(overNo)) {
      byOver.set(overNo, { deliveries: 0, legal: 0, runs: 0, hasIllegal: false });
    }

    const over = byOver.get(overNo);
    over.deliveries += 1;
    over.runs += runsConcededByBowler(ball);
    if (ball.legal_ball !== false) over.legal += 1;
    if (ball.legal_ball === false) over.hasIllegal = true;
  }

  const maidens = [...byOver.values()].filter((over) => {
    const finished = over.hasIllegal ? over.deliveries >= 7 : over.legal >= 6;
    return finished && over.runs === 0;
  }).length;

  const overs = oversTextFromLegal(legal);
  const oversForClassic = legal % 6 === 0 ? String(Math.floor(legal / 6)) : overs;
  const econ = legal > 0 ? (runs / (legal / 6)) : 0;
  return {
    overs,
    maidens,
    runs,
    wkts,
    econ,
    classic: `${oversForClassic}-${maidens}-${runs}-${wkts}`,
  };
}

function buildRecentHighlights(balls, playersById) {
  const sorted = sortBallsByPosition((balls || []).filter((ball) => !isAdministrativeBall(ball)));
  if (!sorted.length) return [];

  const highlights = [];

  const lastWicket = [...sorted].reverse().find((ball) => isBattingSideWicket(ball));
  if (lastWicket) {
    const batterName = playersById?.[lastWicket.dismissed_player_id]?.name || "Batter";
    const kind = titleCaseWords(lastWicket.dismissal_kind || "out");
    highlights.push(`Last wicket: ${batterName} ${kind}`);
  }

  const lastBoundary = [...sorted].reverse().find((ball) => {
    const batRuns = toInt(ball.runs_off_bat, 0);
    return batRuns === 4 || batRuns === 6;
  });
  if (lastBoundary) {
    const batterName = playersById?.[lastBoundary.striker_id]?.name || "Batter";
    highlights.push(`Last boundary: ${toInt(lastBoundary.runs_off_bat, 0)} by ${batterName}`);
  }

  const latestBall = sorted.at(-1);
  if (latestBall) {
    const overNo = toInt(latestBall.over_no, 0);
    const lastOverBalls = sorted.filter((ball) => toInt(ball.over_no, 0) === overNo);
    highlights.push(`Last over: ${sumRuns(lastOverBalls)} runs`);
  }

  return highlights;
}

async function loadFixtureWicketCap(fixtureId) {
  if (!fixtureId) return null;

  const cap = await supabase
    .from("fixture_wicket_caps")
    .select("wicket_cap")
    .eq("fixture_id", fixtureId)
    .maybeSingle();

  if (cap.error) return null;
  return cap.data?.wicket_cap ?? null;
}

async function loadAppliedSessionEvents(matchId, inningsId) {
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

function SpectatorStickyHeader({
  visible,
  teamLabel,
  score,
  oversText,
  context,
  isPhoneViewport = false,
}) {
  return (
    <div
      style={{
        position: "sticky",
        top: isPhoneViewport ? 6 : 10,
        zIndex: 30,
        height: visible ? (isPhoneViewport ? 68 : 62) : 0,
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
          borderRadius: isPhoneViewport ? 14 : 16,
          border: "1px solid rgba(255,255,255,0.10)",
          background: "rgba(8,14,26,0.88)",
          backdropFilter: "blur(12px)",
          boxShadow: "0 10px 28px rgba(0,0,0,0.28)",
          padding: isPhoneViewport ? "7px 9px" : "10px 12px",
          display: "grid",
          gap: isPhoneViewport ? 3 : 4,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
          <div
            style={{
              minWidth: 0,
              fontSize: isPhoneViewport ? 10.5 : 12,
              fontWeight: 900,
              color: "rgba(232,238,252,0.82)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {teamLabel}
          </div>
          <div style={{ fontSize: isPhoneViewport ? 18 : 19, fontWeight: 1050, whiteSpace: "nowrap", color: "rgba(255,255,255,0.96)" }}>
            {score}
          </div>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "auto minmax(0, 1fr)",
            alignItems: "start",
            gap: isPhoneViewport ? 8 : 12,
            fontSize: isPhoneViewport ? 10 : 11,
            color: "rgba(232,238,252,0.70)",
          }}
        >
          <span style={{ whiteSpace: "nowrap" }}>{oversText} overs</span>
          <span
            style={{
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: isPhoneViewport ? "normal" : "nowrap",
              textAlign: "right",
              display: isPhoneViewport ? "-webkit-box" : "block",
              WebkitLineClamp: isPhoneViewport ? 2 : undefined,
              WebkitBoxOrient: isPhoneViewport ? "vertical" : undefined,
              lineHeight: isPhoneViewport ? 1.2 : undefined,
            }}
          >
            {context}
          </span>
        </div>
      </div>
    </div>
  );
}

function TabSectionFallback({
  title = "Loading...",
  detail = "Preparing this section.",
  dark = true,
  compact = false,
}) {
  const text = dark ? "rgba(255,255,255,0.92)" : "#0f172a";
  const subText = dark ? "rgba(232,238,252,0.70)" : "rgba(15,23,42,0.65)";
  const border = dark ? "1px solid rgba(255,255,255,0.10)" : "1px solid rgba(15,23,42,0.10)";
  const background = dark ? "rgba(255,255,255,0.04)" : "rgba(15,23,42,0.03)";

  return (
    <div
      style={{
        borderRadius: compact ? 14 : 16,
        border,
        background,
        padding: compact ? 12 : 14,
        display: "grid",
        gap: 6,
        color: text,
      }}
    >
      <div style={{ fontWeight: 1000 }}>{title}</div>
      <div style={{ fontSize: 13, color: subText }}>{detail}</div>
    </div>
  );
}

export default function SpectatorView() {
  const { fixtureId } = useParams();
  const heroRef = useRef(null);

  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  const [match, setMatch] = useState(null);
  const [fixtureWicketCap, setFixtureWicketCap] = useState(null);
  const [inningsByNo, setInningsByNo] = useState({});
  const [ballsByInnings, setBallsByInnings] = useState({});
  const [sessionEventsByInnings, setSessionEventsByInnings] = useState({});
  const [players, setPlayers] = useState([]);
  const [activeTab, setActiveTab] = useState("live");
  const [activeInnings, setActiveInnings] = useState(1);
  const [showStickyHeader, setShowStickyHeader] = useState(false);
  const [isCompactViewport, setIsCompactViewport] = useState(
    typeof window !== "undefined" ? window.innerWidth <= 960 : false
  );
  const [isPhoneViewport, setIsPhoneViewport] = useState(
    typeof window !== "undefined" ? window.innerWidth <= 720 : false
  );
  const [liveOutcomeBadge, setLiveOutcomeBadge] = useState(null);
  const latestOutcomeBallKeyRef = useRef("");
  const liveOutcomeTimerRef = useRef(null);

  const clearLiveOutcomeBadge = () => {
    if (liveOutcomeTimerRef.current) {
      window.clearTimeout(liveOutcomeTimerRef.current);
      liveOutcomeTimerRef.current = null;
    }
  };

  const showLiveOutcomeBadge = (outcome) => {
    if (!outcome) return;
    clearLiveOutcomeBadge();
    setLiveOutcomeBadge(outcome);
    liveOutcomeTimerRef.current = window.setTimeout(() => {
      liveOutcomeTimerRef.current = null;
      setLiveOutcomeBadge(null);
    }, 1600);
  };

  useEffect(() => {
    let alive = true;

    (async () => {
      setLoading(true);
      setErr("");

      const m = await supabase
        .from("matches")
        .select(
          `
          id,
          fixture_id,
          scheduled_at,
          status,
          overs_limit,
          wicket_cap,
          team_a:teams!matches_team_a_id_fkey(id,name,short_name),
          team_b:teams!matches_team_b_id_fkey(id,name,short_name)
          `
        )
        .eq("fixture_id", fixtureId)
        .order("scheduled_at", { ascending: true, nullsFirst: false })
        .limit(1)
        .maybeSingle();

      if (!alive) return;

      if (m.error) {
        setErr(`Match load error: ${m.error.message}`);
        setLoading(false);
        return;
      }

      if (!m.data) {
        setErr("No match found for this fixture.");
        setLoading(false);
        return;
      }

      setMatch(m.data);
      setFixtureWicketCap(await loadFixtureWicketCap(m.data.fixture_id || fixtureId));

      const teamIds = [m.data?.team_a?.id, m.data?.team_b?.id].filter(Boolean);
      if (teamIds.length) {
        const p = await supabase
          .from("players")
          .select("id,name,team_id,active")
          .in("team_id", teamIds)
          .order("name", { ascending: true });

        if (!p.error) setPlayers(p.data || []);
      }

      const inn = await supabase
        .from("innings")
        .select("*")
        .eq("match_id", m.data.id)
        .order("innings_no", { ascending: true });

      if (inn.error) {
        setErr(`Innings load error: ${inn.error.message}`);
        setLoading(false);
        return;
      }

      const byNo = {};
      (inn.data || []).forEach((row) => {
        byNo[toInt(row.innings_no, 0)] = row;
      });
      setInningsByNo(byNo);

      const ballsMap = {};
      const sessionEventMap = {};
      for (const row of inn.data || []) {
        const b = await supabase
          .from("balls")
          .select("*")
          .eq("match_id", m.data.id)
          .eq("innings_id", row.id)
          .order("over_no", { ascending: true })
          .order("delivery_in_over", { ascending: true });

        if (!b.error) ballsMap[row.id] = sortBallsByPosition(b.data || []);
        sessionEventMap[row.id] = await loadAppliedSessionEvents(m.data.id, row.id);
      }
      setBallsByInnings(ballsMap);
      setSessionEventsByInnings(sessionEventMap);

      const inn1 = byNo[1] ? ballsMap[byNo[1].id] || [] : [];
      const inn2 = byNo[2] ? ballsMap[byNo[2].id] || [] : [];
      const raw = String(m.data.status || "").toLowerCase();
      const defaultInn = (raw === "completed" || inn2.length) ? 2 : 1;
      setActiveInnings(defaultInn);

      setLoading(false);
    })();

    return () => {
      alive = false;
    };
  }, [fixtureId]);

  useEffect(() => {
    if (!match?.id) return;
    const inn1 = inningsByNo?.[1] || null;
    const inn2 = inningsByNo?.[2] || null;
    const ids = [inn1?.id, inn2?.id].filter(Boolean);
    if (!ids.length) return;

    const chans = ids.map((inningsId) => (
      supabase
        .channel(`spectator-balls-${fixtureId}-${inningsId}`)
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "balls", filter: `innings_id=eq.${inningsId}` },
          async () => {
            const b = await supabase
              .from("balls")
              .select("*")
              .eq("match_id", match.id)
              .eq("innings_id", inningsId)
              .order("over_no", { ascending: true })
              .order("delivery_in_over", { ascending: true });

            if (!b.error) setBallsByInnings((prev) => ({ ...prev, [inningsId]: sortBallsByPosition(b.data || []) }));
          }
        )
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "match_session_events", filter: `innings_id=eq.${inningsId}` },
          async () => {
            const events = await loadAppliedSessionEvents(match.id, inningsId);
            setSessionEventsByInnings((prev) => ({ ...prev, [inningsId]: events }));
          }
        )
        .subscribe()
    ));

    return () => {
      chans.forEach((channel) => supabase.removeChannel(channel));
    };
  }, [fixtureId, match?.id, inningsByNo]);

  useEffect(() => {
    if (!match?.id) return;

    const ch = supabase
      .channel(`spectator-match-${fixtureId}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "matches", filter: `id=eq.${match.id}` },
        async () => {
          const m = await supabase
            .from("matches")
            .select(
              `
              id,
              fixture_id,
              scheduled_at,
              status,
              overs_limit,
              wicket_cap,
              team_a:teams!matches_team_a_id_fkey(id,name,short_name),
              team_b:teams!matches_team_b_id_fkey(id,name,short_name)
              `
            )
            .eq("id", match.id)
            .maybeSingle();

          if (!m.error && m.data) {
            setMatch(m.data);
            setFixtureWicketCap(await loadFixtureWicketCap(m.data.fixture_id || fixtureId));
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(ch);
    };
  }, [fixtureId, match?.id]);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;

    const handleResize = () => {
      setIsCompactViewport(window.innerWidth <= 960);
      setIsPhoneViewport(window.innerWidth <= 720);
    };

    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  useEffect(() => {
    if (loading || !isCompactViewport) {
      setShowStickyHeader(false);
      return undefined;
    }

    const heroEl = heroRef.current;
    if (!heroEl || typeof window === "undefined") return undefined;

    if ("IntersectionObserver" in window) {
      const observer = new IntersectionObserver(
        ([entry]) => {
          setShowStickyHeader(!entry.isIntersecting);
        },
        { threshold: 0.2 }
      );
      observer.observe(heroEl);
      return () => observer.disconnect();
    }

    const onScroll = () => {
      const rect = heroEl.getBoundingClientRect();
      setShowStickyHeader(rect.bottom < 88);
    };

    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [isCompactViewport, loading]);

  useEffect(() => {
    return () => {
      clearLiveOutcomeBadge();
    };
  }, []);

  const playersById = useMemo(() => {
    const map = {};
    (players || []).forEach((player) => {
      map[player.id] = player;
    });
    return map;
  }, [players]);

  const teamA = match?.team_a || null;
  const teamB = match?.team_b || null;
  const teamLabel = `${teamA?.name || teamA?.short_name || "Team A"} vs ${teamB?.name || teamB?.short_name || "Team B"}`;
  const rosterWicketCap = useMemo(
    () => deriveRosterWicketCap(players, [teamA?.id, teamB?.id]),
    [players, teamA?.id, teamB?.id]
  );
  const teamById = useMemo(() => {
    const map = new Map();
    if (teamA?.id) map.set(teamA.id, teamA);
    if (teamB?.id) map.set(teamB.id, teamB);
    return map;
  }, [teamA, teamB]);

  const inn1Row = inningsByNo?.[1] || null;
  const inn2Row = inningsByNo?.[2] || null;

  const inn1SourceBalls = inn1Row ? (ballsByInnings?.[inn1Row.id] || []) : [];
  const inn2SourceBalls = inn2Row ? (ballsByInnings?.[inn2Row.id] || []) : [];
  const inn1SessionEvents = inn1Row ? (sessionEventsByInnings?.[inn1Row.id] || []) : [];
  const inn2SessionEvents = inn2Row ? (sessionEventsByInnings?.[inn2Row.id] || []) : [];
  const inn1Balls = useMemo(() => materializeAdministrativeStateBalls({
    balls: inn1SourceBalls,
    sessionEvents: inn1SessionEvents,
  }), [inn1SessionEvents, inn1SourceBalls]);
  const inn2Balls = useMemo(() => materializeAdministrativeStateBalls({
    balls: inn2SourceBalls,
    sessionEvents: inn2SessionEvents,
  }), [inn2SessionEvents, inn2SourceBalls]);

  const tabBalls = activeInnings === 2 ? inn2Balls : inn1Balls;

  const oversLimit = toInt(match?.overs_limit, 20);
  const wicketCap = resolveDisplayWicketCap({
    fixtureWicketCap,
    matchWicketCap: match?.wicket_cap,
    rosterWicketCap,
    fallback: 10,
  });

  const innings1Totals = useMemo(() => buildInningsTotals(inn1Row, inn1Balls), [inn1Row, inn1Balls]);
  const innings2Totals = useMemo(() => buildInningsTotals(inn2Row, inn2Balls), [inn2Row, inn2Balls]);
  const innings1Team = inn1Row?.batting_team_id ? teamById.get(inn1Row.batting_team_id) : teamA;
  const innings2Team = inn2Row?.batting_team_id ? teamById.get(inn2Row.batting_team_id) : teamB;

  const derivedStatus = useMemo(() => (
    deriveMatchDisplayStatus({
      matchStatus: match?.status,
      innings1Row: inn1Row,
      innings2Row: inn2Row,
      innings1Balls: inn1Balls,
      innings2Balls: inn2Balls,
      oversLimit: match?.overs_limit,
      wicketCap,
    })
  ), [match?.status, match?.overs_limit, wicketCap, inn1Row, inn2Row, inn1Balls, inn2Balls]);

  const liveInnings = useMemo(() => {
    if (inn2Row && (String(derivedStatus).toLowerCase() === "completed" || inn2Balls.length || inn2Row.completed)) {
      return 2;
    }
    return 1;
  }, [derivedStatus, inn2Balls.length, inn2Row, inn2Row?.completed]);

  const liveRow = liveInnings === 2 ? inn2Row : inn1Row;
  const liveBalls = liveInnings === 2 ? inn2Balls : inn1Balls;
  const liveTotals = useMemo(() => buildInningsTotals(liveRow, liveBalls), [liveRow, liveBalls]);
  const latestCompetitiveBall = useMemo(() => [...liveBalls].reverse().find((ball) => !isAdministrativeBall(ball)) || null, [liveBalls]);
  const currentOverSummary = useMemo(() => selectCurrentOverSummary(liveBalls), [liveBalls]);
  const liveOversText = oversTextFromLegal(liveTotals.legalBalls);
  const crr = liveTotals.legalBalls ? (liveTotals.runs / (liveTotals.legalBalls / 6)) : 0;

  const target = innings1Totals.runs + 1;
  const runsNeeded = Math.max(0, target - innings2Totals.runs);
  const ballsRemaining = Math.max(0, oversLimit * 6 - innings2Totals.legalBalls);
  const rrr = ballsRemaining > 0 ? (runsNeeded / (ballsRemaining / 6)) : 0;

  const resultText = useMemo(() => {
    return buildCompletedResultText({
      matchStatus: derivedStatus,
      innings1Team,
      innings2Team,
      innings1: innings1Totals,
      innings2: innings2Totals,
      wicketCap,
    });
  }, [derivedStatus, innings1Team, innings2Team, innings1Totals, innings2Totals, wicketCap]);
  const matchSummary = useMemo(() => buildAutomaticMatchSummary({
    matchStatus: derivedStatus,
    innings1Team,
    innings2Team,
    innings1: innings1Totals,
    innings2: innings2Totals,
    innings1Balls: inn1Balls,
    innings2Balls: inn2Balls,
    playersById,
    wicketCap,
  }), [derivedStatus, innings1Team, innings2Team, innings1Totals, innings2Totals, inn1Balls, inn2Balls, playersById, wicketCap]);

  const lastLiveBall = liveBalls.length ? liveBalls[liveBalls.length - 1] : null;
  const striker = lastLiveBall ? playersById[lastLiveBall.striker_id] : null;
  const nonStriker = lastLiveBall ? playersById[lastLiveBall.non_striker_id] : null;
  const bowler = lastLiveBall ? playersById[lastLiveBall.bowler_id] : null;

  const strikerTurnNow = striker?.id ? (lastLiveBall?.batting_turn || currentTurnForPlayer(liveBalls, striker.id)) : 1;
  const nonStrikerTurnNow = nonStriker?.id ? currentTurnForPlayer(liveBalls, nonStriker.id) : 1;

  const strikerStats = batterStats(liveBalls, striker?.id, strikerTurnNow);
  const nonStrikerStats = batterStats(liveBalls, nonStriker?.id, nonStrikerTurnNow);
  const bowlerS = bowlerStats(liveBalls, bowler?.id);
  const partnership = useMemo(() => selectCurrentPartnership(liveBalls), [liveBalls]);
  const highlights = useMemo(() => buildRecentHighlights(liveBalls, playersById), [liveBalls, playersById]);
  const stickyTeamLabel = `${compactTeamName(teamA)} vs ${compactTeamName(teamB)}`;
  const stickyContext = useMemo(() => {
    if (String(derivedStatus || "").toLowerCase() === "completed" && resultText) {
      return resultText;
    }
    if (liveInnings === 2) {
      return runsNeeded > 0 ? `Need ${runsNeeded} off ${ballsRemaining}` : `Target ${target}`;
    }
    return `Innings ${liveInnings}`;
  }, [ballsRemaining, derivedStatus, liveInnings, resultText, runsNeeded, target]);

  const progress = useMemo(() => {
    const totalLegal = oversLimit * 6;
    const pct = totalLegal > 0 ? Math.min(100, Math.max(0, (liveTotals.legalBalls / totalLegal) * 100)) : 0;
    return {
      label: `${liveOversText} / ${oversLimit}.0 overs`,
      subLabel: `${Math.max(0, totalLegal - liveTotals.legalBalls)} balls remaining`,
      pct,
    };
  }, [liveOversText, liveTotals.legalBalls, oversLimit]);

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

  const themeText = "rgba(255,255,255,0.92)";
  const subText = "rgba(232,238,252,0.72)";
  const surface = "rgba(255,255,255,0.05)";
  const surfaceStrong = "rgba(255,255,255,0.08)";
  const border = "1px solid rgba(255,255,255,0.10)";
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
    return { background: "rgba(255,255,255,0.10)", color: themeText, border: "1px solid rgba(255,255,255,0.12)" };
  };

  const liveCardStyle = {
    borderRadius: isPhoneViewport ? 14 : 16,
    border,
    background: surface,
    padding: isPhoneViewport ? 12 : 14,
  };
  const infoPillStyle = {
    borderRadius: 999,
    border,
    background: "rgba(255,255,255,0.06)",
    padding: isPhoneViewport ? "6px 10px" : "7px 11px",
    fontSize: isPhoneViewport ? 11 : 12,
    fontWeight: 900,
    color: themeText,
    whiteSpace: "nowrap",
  };
  const tabButtonBaseStyle = {
    borderRadius: 999,
    padding: isPhoneViewport ? "11px 10px" : "8px 12px",
    minHeight: isPhoneViewport ? 42 : undefined,
    cursor: "pointer",
    border,
    color: themeText,
    fontWeight: 900,
    fontSize: isPhoneViewport ? 13 : 12,
    textAlign: "center",
  };

  if (loading) {
    return (
      <div style={{ minHeight: "100vh", padding: 16, color: "rgba(255,255,255,0.88)", background: "#0b1220" }}>
        <div style={{ maxWidth: 980, margin: "0 auto" }}>
          <div style={{ borderRadius: 16, border: "1px solid rgba(255,255,255,0.10)", background: "rgba(255,255,255,0.04)", padding: 14, display: "grid", gap: 6 }}>
            <div style={{ fontWeight: 1000 }}>Loading match...</div>
            <div style={{ fontSize: 13, color: "rgba(232,238,252,0.70)" }}>Preparing live score, current batters, and commentary.</div>
          </div>
        </div>
      </div>
    );
  }

  if (err) {
    return (
      <div style={{ minHeight: "100vh", padding: 16, color: "rgba(255,255,255,0.88)", background: "#0b1220" }}>
        <div style={{ maxWidth: 980, margin: "0 auto" }}>
          <div style={{ borderRadius: 16, border: "1px solid rgba(248,113,113,0.22)", background: "rgba(127,29,29,0.18)", padding: 14, display: "grid", gap: 6 }}>
            <div style={{ fontWeight: 900 }}>Error</div>
            <div style={{ opacity: 0.85 }}>{err}</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: isPhoneViewport ? 12 : 18, color: themeText, background: "#0b1220", minHeight: "100vh" }}>
      <div style={{ maxWidth: 980, margin: "0 auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: isPhoneViewport ? "flex-start" : "baseline", gap: 10, flexWrap: "wrap" }}>
          <div>
            <div style={{ fontWeight: 1000, fontSize: isPhoneViewport ? 20 : 22, lineHeight: 1.2 }}>{teamLabel}</div>
            <div style={{ opacity: 0.72, marginTop: 4, fontSize: isPhoneViewport ? 11 : 12 }}>
              Spectator view • Innings {liveInnings}
            </div>
          </div>

          <Link
            to="/fixtures"
            style={{
              color: "rgba(180,210,255,0.95)",
              fontWeight: 900,
              fontSize: 12,
              padding: "8px 12px",
              borderRadius: 999,
              border,
              background: "rgba(255,255,255,0.04)",
              textDecoration: "none",
            }}
          >
            Back
          </Link>
        </div>

        <SpectatorStickyHeader
          visible={showStickyHeader}
          teamLabel={stickyTeamLabel}
          score={`${liveTotals.runs} / ${liveTotals.wkts}`}
          oversText={liveOversText}
          context={stickyContext}
          isPhoneViewport={isPhoneViewport}
        />

        <div
          ref={heroRef}
          style={{
            marginTop: 14,
            borderRadius: isPhoneViewport ? 18 : 20,
            padding: isPhoneViewport ? 16 : 18,
            border,
            background: "linear-gradient(180deg, rgba(19,31,61,0.96) 0%, rgba(10,18,32,0.96) 100%)",
            boxShadow: "0 18px 40px rgba(0,0,0,0.30)",
            position: "relative",
            overflow: "hidden",
          }}
        >
          {isPhoneViewport ? (
            <div style={{ display: "flex", justifyContent: "flex-start", marginBottom: liveOutcomeBadge ? 6 : 0 }}>
              <LiveOutcomeBadge outcome={liveOutcomeBadge} visible={!!liveOutcomeBadge} />
            </div>
          ) : (
            <div style={{ position: "absolute", top: 14, right: 14, pointerEvents: "none" }}>
              <LiveOutcomeBadge outcome={liveOutcomeBadge} visible={!!liveOutcomeBadge} />
            </div>
          )}

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
            <div style={{ display: "grid", gap: 8, flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: isPhoneViewport ? 12 : 13, fontWeight: 900, color: subText }}>
                {String(derivedStatus || "live").toUpperCase()}
              </div>
              <div style={{ fontSize: "clamp(3.2rem, 9vw, 5rem)", lineHeight: 0.96, fontWeight: 1100, letterSpacing: -1.5 }}>
                {liveTotals.runs} <span style={{ opacity: 0.82 }}>/</span> {liveTotals.wkts}
              </div>
              <div style={{ fontSize: "clamp(1rem, 2.8vw, 1.45rem)", fontWeight: 900 }}>{liveOversText} overs</div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", fontSize: isPhoneViewport ? 12 : 14 }}>
                CRR {formatRate(crr, 2)} • Wicket cap {wicketCap}
              </div>
            </div>

            {liveInnings === 2 ? (
              <div
                style={{
                  flexShrink: 0,
                  display: "grid",
                  gap: 0,
                  borderRadius: 16,
                  overflow: "hidden",
                  background: "rgba(255,255,255,0.055)",
                  border: "1px solid rgba(255,255,255,0.11)",
                  minWidth: isPhoneViewport ? 76 : 90,
                  textAlign: "center",
                }}
              >
                {[
                  { label: "Target", value: target, valueStyle: { fontSize: isPhoneViewport ? 20 : 24, fontWeight: 1100, lineHeight: 1.1 } },
                  { label: "Need", value: <>{runsNeeded} <span style={{ fontSize: isPhoneViewport ? 10 : 11, fontWeight: 700, opacity: 0.65 }}>/ {ballsRemaining}</span></>, valueStyle: { fontSize: isPhoneViewport ? 15 : 17, fontWeight: 1000, lineHeight: 1.1 } },
                  { label: "RRR", value: formatRate(rrr, 2), valueStyle: { fontSize: isPhoneViewport ? 15 : 17, fontWeight: 1000, lineHeight: 1.1 } },
                ].map(({ label, value, valueStyle }, i) => (
                  <div
                    key={label}
                    style={{
                      padding: isPhoneViewport ? "8px 10px" : "10px 14px",
                      borderTop: i > 0 ? "1px solid rgba(255,255,255,0.08)" : "none",
                    }}
                  >
                    <div style={{ fontSize: 9, fontWeight: 900, color: subText, textTransform: "uppercase", letterSpacing: "0.10em", marginBottom: 3 }}>
                      {label}
                    </div>
                    <div style={valueStyle}>{value}</div>
                  </div>
                ))}
              </div>
            ) : null}
          </div>

          <div style={{ marginTop: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 12, color: subText, marginBottom: 6, flexWrap: "wrap" }}>
              <span>Match progress</span>
              <span>{progress.label}</span>
            </div>
            <div style={{ height: 8, borderRadius: 999, background: "rgba(255,255,255,0.10)", overflow: "hidden" }}>
              <div
                style={{
                  width: `${progress.pct}%`,
                  height: "100%",
                  borderRadius: 999,
                  background: "linear-gradient(90deg, #38bdf8 0%, #22c55e 100%)",
                }}
              />
            </div>
            <div style={{ marginTop: 6, fontSize: 12, color: subText }}>{progress.subLabel}</div>
          </div>

          {resultText ? (
            <div style={{ marginTop: 14, fontSize: 13, fontWeight: 900, color: "rgba(255,228,176,0.95)" }}>
              {resultText}
            </div>
          ) : null}

          {matchSummary ? (
            <div
              style={{
                marginTop: 12,
                display: "grid",
                gap: 4,
                padding: isPhoneViewport ? 11 : 12,
                borderRadius: isPhoneViewport ? 12 : 14,
                border: "1px solid rgba(255,255,255,0.10)",
                background: "rgba(255,255,255,0.04)",
              }}
            >
              <div style={{ fontSize: 12, fontWeight: 900, color: subText }}>Match summary</div>
              <div style={{ fontSize: 13, fontWeight: 900 }}>{matchSummary.headline}</div>
              {matchSummary.topBatter ? <div style={{ fontSize: 13, color: themeText }}>{matchSummary.topBatter}</div> : null}
              {matchSummary.bestBowler ? <div style={{ fontSize: 13, color: themeText }}>{matchSummary.bestBowler}</div> : null}
              {matchSummary.turningPoint ? <div style={{ fontSize: 13, color: subText }}>{matchSummary.turningPoint}</div> : null}
            </div>
          ) : null}
        </div>

        <div
          style={{
            display: isPhoneViewport ? "grid" : "flex",
            gridTemplateColumns: isPhoneViewport ? "repeat(2, minmax(0, 1fr))" : undefined,
            gap: 10,
            marginTop: 14,
            flexWrap: "wrap",
          }}
        >
          {[
            { key: "live", label: "Live" },
            { key: "scorecard", label: "Scorecard" },
            { key: "commentary", label: "Commentary" },
            { key: "stats", label: "Stats" },
          ].map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              style={{
                background: activeTab === tab.key ? surfaceStrong : "rgba(0,0,0,0.18)",
                ...tabButtonBaseStyle,
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {(activeTab === "commentary" || activeTab === "stats" || activeTab === "scorecard") ? (
          <div
            style={{
              display: isPhoneViewport ? "grid" : "flex",
              gridTemplateColumns: isPhoneViewport ? "repeat(2, minmax(0, 1fr))" : undefined,
              gap: 10,
              marginTop: 12,
              flexWrap: "wrap",
            }}
          >
            {[1, 2].map((inningsNo) => {
              const enabled = inningsNo === 1 || !!inn2Row;
              return (
                <button
                  key={inningsNo}
                  onClick={() => enabled && setActiveInnings(inningsNo)}
                  disabled={!enabled}
                  style={{
                    cursor: enabled ? "pointer" : "not-allowed",
                    background: activeInnings === inningsNo ? surfaceStrong : "rgba(0,0,0,0.18)",
                    color: enabled ? themeText : "rgba(255,255,255,0.45)",
                    ...tabButtonBaseStyle,
                  }}
                >
                  Innings {inningsNo}
                </button>
              );
            })}
          </div>
        ) : null}

        <div style={{ marginTop: 14 }}>
          {activeTab === "live" ? (
            <div style={{ display: "grid", gap: 14 }}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
                <div style={liveCardStyle}>
                  <div style={{ display: "grid", gap: 10 }}>
                    {[
                      {
                        key: "striker",
                        name: striker?.name ? `${striker.name}*` : "—",
                        stats: strikerStats,
                        note: "On strike",
                      },
                      {
                        key: "non-striker",
                        name: nonStriker?.name || "—",
                        stats: nonStrikerStats,
                        note: "Partner",
                      },
                    ].map((batter, index) => (
                      <div
                        key={batter.key}
                        style={{
                          display: "grid",
                          gap: 8,
                          padding: "10px 12px",
                          borderTop: index === 0 ? "none" : "1px solid rgba(255,255,255,0.10)",
                          borderRadius: 12,
                          background: index === 0 ? "rgba(56,189,248,0.12)" : "transparent",
                          boxShadow: index === 0 ? "inset 0 0 0 1px rgba(56,189,248,0.22)" : "none",
                        }}
                      >
                        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
                          <div style={{ minWidth: 0 }}>
                            <div
                              style={{
                                fontSize: isPhoneViewport ? 17 : 18,
                                fontWeight: index === 0 ? 1050 : 950,
                                minWidth: 0,
                                display: "-webkit-box",
                                WebkitLineClamp: isPhoneViewport ? 2 : 1,
                                WebkitBoxOrient: "vertical",
                                overflow: "hidden",
                                lineHeight: 1.15,
                              }}
                            >
                              {batter.name}
                            </div>
                            <div style={{ marginTop: 4, fontSize: 11, fontWeight: 900, color: subText }}>{batter.note}</div>
                          </div>

                          <div style={{ textAlign: "right", flexShrink: 0 }}>
                            <div style={{ fontSize: 18, fontWeight: 1000, color: themeText }}>
                              {batter.stats ? `${batter.stats.r} (${batter.stats.b})` : "0 (0)"}
                            </div>
                            <div style={{ marginTop: 3, fontSize: 12, color: subText }}>
                              {batter.stats ? `SR ${formatStrikeRate(batter.stats.sr)}` : "Waiting for first ball"}
                            </div>
                          </div>
                        </div>
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                          <div style={infoPillStyle}>4s {batter.stats ? batter.stats.fours : 0}</div>
                          <div style={infoPillStyle}>6s {batter.stats ? batter.stats.sixes : 0}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div style={liveCardStyle}>
                  <div style={{ fontSize: 12, fontWeight: 900, color: subText, marginBottom: 8 }}>Bowler</div>
                  <div
                    style={{
                      fontSize: 20,
                      fontWeight: 1000,
                      minWidth: 0,
                      display: "-webkit-box",
                      WebkitLineClamp: isPhoneViewport ? 2 : 1,
                      WebkitBoxOrient: "vertical",
                      overflow: "hidden",
                    }}
                  >
                    {bowler?.name || "—"}
                  </div>
                  <div style={{ marginTop: 8, fontSize: 16, fontWeight: 900, color: themeText }}>
                    {bowlerS ? bowlerS.classic : "—"}
                  </div>
                  <div style={{ marginTop: 4, fontSize: 12, color: subText }}>
                    Econ {bowlerS ? formatRate(bowlerS.econ, 2) : "0.00"}
                  </div>
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
                <div style={liveCardStyle}>
                  <div style={{ fontSize: 12, fontWeight: 900, color: subText, marginBottom: 8 }}>Partnership</div>
                  <div style={{ fontSize: 18, fontWeight: 1000 }}>
                    {partnership ? `${partnership.runs} runs • ${partnership.balls} balls` : "New stand"}
                  </div>
                </div>

                <div style={liveCardStyle}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 10, marginBottom: 8, flexWrap: "wrap" }}>
                    <div style={{ fontSize: 12, fontWeight: 900, color: subText }}>This over</div>
                    <div style={{ fontSize: 12, color: subText }}>{formatOverSummaryText(currentOverSummary)}</div>
                  </div>
                  {currentOverSummary?.balls?.length ? (
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      {currentOverSummary.balls.map((ball) => (
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
                            ...ballTokenStyle(ball),
                          }}
                        >
                          {formatBallOutcomeToken(ball)}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div style={{ fontSize: 14, color: subText }}>No balls yet</div>
                  )}
                </div>
              </div>

              {highlights.length ? (
                <div style={{ ...liveCardStyle, display: "grid", gap: 6 }}>
                  {highlights.map((item) => (
                    <div
                      key={item}
                      style={{
                        fontSize: 13,
                        color: themeText,
                        borderRadius: 12,
                        border,
                        background: "rgba(255,255,255,0.03)",
                        padding: "10px 12px",
                      }}
                    >
                      {item}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          {activeTab === "scorecard" ? (
            <Suspense
              fallback={<TabSectionFallback title="Loading scorecard..." detail={`Preparing innings ${activeInnings} scorecard.`} dark compact={isPhoneViewport} />}
            >
              {activeInnings === 1 ? (
                <ScorecardTables
                  key="scorecard-1"
                  theme="dark"
                  title={`Innings 1${innings1Team?.name ? `: ${innings1Team.name}` : ""}`}
                  balls={inn1Balls}
                  playersById={playersById}
                />
              ) : (
                inn2Row ? (
                  <ScorecardTables
                    key="scorecard-2"
                    theme="dark"
                    title={`Innings 2${innings2Team?.name ? `: ${innings2Team.name}` : ""}`}
                    balls={inn2Balls}
                    playersById={playersById}
                  />
                ) : null
              )}
            </Suspense>
          ) : null}

          {activeTab === "commentary" ? (
            <Suspense
              fallback={<TabSectionFallback title="Loading commentary..." detail={`Preparing innings ${activeInnings} over groups.`} dark compact={isPhoneViewport} />}
            >
              <div style={{ ...liveCardStyle, padding: isPhoneViewport ? 12 : 14 }}>
                <div style={{ fontWeight: 1000, marginBottom: 8 }}>Commentary</div>
                <div style={{ fontSize: 12, color: subText, marginBottom: 12 }}>
                  Grouped by over for innings {activeInnings}
                </div>
                <BallByBall balls={tabBalls} groupByOver />
              </div>
            </Suspense>
          ) : null}

          {activeTab === "stats" ? (
            <Suspense
              fallback={(
                <div style={{ display: "grid", gap: 12 }}>
                  <TabSectionFallback title="Loading partnerships..." detail="Preparing stand summaries." dark compact={isPhoneViewport} />
                  <TabSectionFallback title="Loading run flow..." detail="Preparing worm graph." dark compact={isPhoneViewport} />
                </div>
              )}
            >
              <div style={{ display: "grid", gap: 12 }}>
                <div style={liveCardStyle}>
                  <Partnerships balls={tabBalls} playersById={playersById} theme="dark" compact />
                </div>
                <div style={liveCardStyle}>
                  <WormGraph
                    innings1Balls={inn1Balls}
                    innings2Balls={inn2Balls}
                    playersById={playersById}
                    target={inn1Balls.length ? innings1Totals.runs + 1 : null}
                    theme="dark"
                    maxOvers={oversLimit}
                    compact
                  />
                </div>
              </div>
            </Suspense>
          ) : null}
        </div>
      </div>
    </div>
  );
}
