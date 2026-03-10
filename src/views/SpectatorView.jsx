import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { supabase } from "../lib/supabase";

import BallByBall from "../components/BallByBall";
import Partnerships from "../components/Partnerships";
import WormGraph from "../components/WormGraph";
import ScorecardTables from "../components/ScorecardTables";
import {
  buildCompletedResultText,
  buildInningsTotals,
  didBatterFaceBall,
  deriveMatchDisplayStatus,
  isAdministrativeBall,
  isBattingSideWicket,
  isBowlerCreditedWicket,
  deriveRosterWicketCap,
  legalBallsCount,
  oversTextFromLegal,
  resolveDisplayWicketCap,
  runsConcededByBowler,
  sortBallsByPosition,
  sumRuns,
  toInt,
} from "../lib/scoring";

function currentTurnForPlayer(balls, playerId) {
  if (!playerId) return 1;
  const outs = (balls || []).filter((b) => b.wicket && b.dismissed_player_id === playerId).length;
  return outs + 1;
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

function describeBallValue(ball) {
  if (!ball) return "";
  if (ball.wicket) return "W";
  return String(toInt(ball.runs_off_bat, 0) + toInt(ball.extra_runs, 0));
}

function batterStats(balls, batterId, turn = 1) {
  if (!batterId) return null;
  const t = toInt(turn, 1) || 1;
  const facedAsStriker = (balls || []).filter((b) => b.striker_id === batterId && toInt(b.batting_turn, 1) === t);
  const ballsFaced = facedAsStriker.filter((b) => didBatterFaceBall(b)).length;
  const runs = facedAsStriker.reduce((acc, b) => acc + toInt(b.runs_off_bat, 0), 0);
  const sr = ballsFaced > 0 ? (runs / ballsFaced) * 100 : 0;
  return { r: runs, b: ballsFaced, sr };
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

function buildLastBallsStrip(balls, limit = 6) {
  const recent = sortBallsByPosition((balls || []).filter((ball) => !isAdministrativeBall(ball))).slice(-limit);
  return recent.map((ball) => ({
    id: ball.id || `${ball.over_no}.${ball.delivery_in_over}.${ball.created_at || ""}`,
    label: describeBallValue(ball),
    wicket: !!ball.wicket,
    runs: toInt(ball.runs_off_bat, 0) + toInt(ball.extra_runs, 0),
    extraType: ball.extra_type || null,
  }));
}

function buildCurrentPartnership(balls) {
  const sorted = sortBallsByPosition((balls || []).filter((ball) => !isAdministrativeBall(ball)));
  let standStart = 0;

  for (let i = 0; i < sorted.length; i += 1) {
    if (isBattingSideWicket(sorted[i])) standStart = i + 1;
  }

  const standBalls = sorted.slice(standStart);
  if (!standBalls.length) return null;

  return {
    runs: sumRuns(standBalls),
    balls: legalBallsCount(standBalls),
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

export default function SpectatorView() {
  const { fixtureId } = useParams();

  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  const [match, setMatch] = useState(null);
  const [fixtureWicketCap, setFixtureWicketCap] = useState(null);
  const [inningsByNo, setInningsByNo] = useState({});
  const [ballsByInnings, setBallsByInnings] = useState({});
  const [players, setPlayers] = useState([]);
  const [activeTab, setActiveTab] = useState("live");
  const [activeInnings, setActiveInnings] = useState(1);

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
      for (const row of inn.data || []) {
        const b = await supabase
          .from("balls")
          .select("*")
          .eq("match_id", m.data.id)
          .eq("innings_id", row.id)
          .order("over_no", { ascending: true })
          .order("delivery_in_over", { ascending: true });

        if (!b.error) ballsMap[row.id] = sortBallsByPosition(b.data || []);
      }
      setBallsByInnings(ballsMap);

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

  const inn1Balls = inn1Row ? (ballsByInnings?.[inn1Row.id] || []) : [];
  const inn2Balls = inn2Row ? (ballsByInnings?.[inn2Row.id] || []) : [];

  const tabRow = activeInnings === 2 ? inn2Row : inn1Row;
  const tabBalls = tabRow ? (ballsByInnings?.[tabRow.id] || []) : [];

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

  const lastLiveBall = liveBalls.length ? liveBalls[liveBalls.length - 1] : null;
  const striker = lastLiveBall ? playersById[lastLiveBall.striker_id] : null;
  const nonStriker = lastLiveBall ? playersById[lastLiveBall.non_striker_id] : null;
  const bowler = lastLiveBall ? playersById[lastLiveBall.bowler_id] : null;

  const strikerTurnNow = striker?.id ? (lastLiveBall?.batting_turn || currentTurnForPlayer(liveBalls, striker.id)) : 1;
  const nonStrikerTurnNow = nonStriker?.id ? currentTurnForPlayer(liveBalls, nonStriker.id) : 1;

  const strikerStats = batterStats(liveBalls, striker?.id, strikerTurnNow);
  const nonStrikerStats = batterStats(liveBalls, nonStriker?.id, nonStrikerTurnNow);
  const bowlerS = bowlerStats(liveBalls, bowler?.id);
  const lastBalls = useMemo(() => buildLastBallsStrip(liveBalls, 6), [liveBalls]);
  const partnership = useMemo(() => buildCurrentPartnership(liveBalls), [liveBalls]);
  const highlights = useMemo(() => buildRecentHighlights(liveBalls, playersById), [liveBalls, playersById]);

  const progress = useMemo(() => {
    const totalLegal = oversLimit * 6;
    const pct = totalLegal > 0 ? Math.min(100, Math.max(0, (liveTotals.legalBalls / totalLegal) * 100)) : 0;
    return {
      label: `${liveOversText} / ${oversLimit}.0 overs`,
      subLabel: `${Math.max(0, totalLegal - liveTotals.legalBalls)} balls remaining`,
      pct,
    };
  }, [liveOversText, liveTotals.legalBalls, oversLimit]);

  const themeText = "rgba(255,255,255,0.92)";
  const subText = "rgba(232,238,252,0.72)";
  const surface = "rgba(255,255,255,0.05)";
  const surfaceStrong = "rgba(255,255,255,0.08)";
  const border = "1px solid rgba(255,255,255,0.10)";

  const liveCardStyle = {
    borderRadius: 16,
    border,
    background: surface,
    padding: 14,
  };

  if (loading) {
    return (
      <div style={{ padding: 18, color: "rgba(255,255,255,0.88)" }}>
        <div style={{ opacity: 0.8 }}>Loading…</div>
      </div>
    );
  }

  if (err) {
    return (
      <div style={{ padding: 18, color: "rgba(255,255,255,0.88)" }}>
        <div style={{ fontWeight: 900, marginBottom: 8 }}>Error</div>
        <div style={{ opacity: 0.85 }}>{err}</div>
      </div>
    );
  }

  return (
    <div style={{ padding: 18, color: themeText, background: "#0b1220", minHeight: "100vh" }}>
      <div style={{ maxWidth: 980, margin: "0 auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
          <div>
            <div style={{ fontWeight: 1000, fontSize: 22, lineHeight: 1.2 }}>{teamLabel}</div>
            <div style={{ opacity: 0.72, marginTop: 4, fontSize: 12 }}>
              Spectator view • Innings {liveInnings}
            </div>
          </div>

          <Link to="/fixtures" style={{ color: "rgba(180,210,255,0.95)", fontWeight: 900, fontSize: 12 }}>
            Back
          </Link>
        </div>

        <div
          style={{
            marginTop: 14,
            borderRadius: 20,
            padding: 18,
            border,
            background: "linear-gradient(180deg, rgba(19,31,61,0.96) 0%, rgba(10,18,32,0.96) 100%)",
            boxShadow: "0 18px 40px rgba(0,0,0,0.30)",
          }}
        >
          <div style={{ display: "grid", gap: 8 }}>
            <div style={{ fontSize: 13, fontWeight: 900, color: subText }}>
              {String(derivedStatus || "live").toUpperCase()}
            </div>
            <div style={{ fontSize: "clamp(3.6rem, 10vw, 5rem)", lineHeight: 0.96, fontWeight: 1100, letterSpacing: -1.5 }}>
              {liveTotals.runs} <span style={{ opacity: 0.82 }}>/</span> {liveTotals.wkts}
            </div>
            <div style={{ fontSize: "clamp(1.15rem, 2.8vw, 1.45rem)", fontWeight: 900 }}>{liveOversText} overs</div>
            <div style={{ fontSize: 12, color: subText, letterSpacing: 0.2 }}>
              CRR {formatRate(crr, 2)} • Wicket cap {wicketCap}
            </div>
          </div>

          {liveInnings === 2 ? (
            <div style={{ marginTop: 14, display: "grid", gap: 4, fontSize: 15 }}>
              <div><span style={{ color: subText }}>Target</span> <strong>{target}</strong></div>
              <div><span style={{ color: subText }}>Need</span> <strong>{runsNeeded} from {ballsRemaining}</strong></div>
              <div><span style={{ color: subText }}>RRR</span> <strong>{formatRate(rrr, 2)}</strong></div>
            </div>
          ) : null}

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
        </div>

        <div style={{ display: "flex", gap: 10, marginTop: 14, flexWrap: "wrap" }}>
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
                borderRadius: 999,
                padding: "8px 12px",
                cursor: "pointer",
                border,
                background: activeTab === tab.key ? surfaceStrong : "rgba(0,0,0,0.18)",
                color: themeText,
                fontWeight: 900,
                fontSize: 12,
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {(activeTab === "commentary" || activeTab === "stats") ? (
          <div style={{ display: "flex", gap: 10, marginTop: 12, flexWrap: "wrap" }}>
            {[1, 2].map((inningsNo) => {
              const enabled = inningsNo === 1 || !!inn2Row;
              return (
                <button
                  key={inningsNo}
                  onClick={() => enabled && setActiveInnings(inningsNo)}
                  disabled={!enabled}
                  style={{
                    borderRadius: 999,
                    padding: "8px 12px",
                    cursor: enabled ? "pointer" : "not-allowed",
                    border,
                    background: activeInnings === inningsNo ? surfaceStrong : "rgba(0,0,0,0.18)",
                    color: enabled ? themeText : "rgba(255,255,255,0.45)",
                    fontWeight: 900,
                    fontSize: 12,
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
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 }}>
                <div style={liveCardStyle}>
                  <div style={{ display: "grid", gap: 10 }}>
                    {[
                      {
                        key: "striker",
                        name: striker?.name ? `${striker.name}*` : "—",
                        stats: strikerStats ? `${strikerStats.r} (${strikerStats.b}) SR ${formatStrikeRate(strikerStats.sr)}` : "Waiting for first ball",
                      },
                      {
                        key: "non-striker",
                        name: nonStriker?.name || "—",
                        stats: nonStrikerStats ? `${nonStrikerStats.r} (${nonStrikerStats.b}) SR ${formatStrikeRate(nonStrikerStats.sr)}` : "Waiting for first ball",
                      },
                    ].map((batter, index) => (
                      <div
                        key={batter.key}
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          gap: 12,
                          flexWrap: "nowrap",
                          padding: "10px 12px",
                          borderTop: index === 0 ? "none" : "1px solid rgba(255,255,255,0.10)",
                          borderRadius: 12,
                          background: index === 0 ? "rgba(56,189,248,0.12)" : "transparent",
                          boxShadow: index === 0 ? "inset 0 0 0 1px rgba(56,189,248,0.22)" : "none",
                        }}
                      >
                        <div
                          style={{
                            fontSize: 18,
                            fontWeight: index === 0 ? 1050 : 950,
                            minWidth: 0,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {batter.name}
                        </div>
                        <div style={{ fontSize: 14, color: themeText, whiteSpace: "nowrap", flexShrink: 0 }}>
                          {batter.stats}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div style={liveCardStyle}>
                  <div style={{ fontSize: 12, fontWeight: 900, color: subText, marginBottom: 8 }}>Bowler</div>
                  <div style={{ fontSize: 20, fontWeight: 1000 }}>{bowler?.name || "—"}</div>
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
                  <div style={{ fontSize: 12, fontWeight: 900, color: subText, marginBottom: 8 }}>Last 6 balls</div>
                  {lastBalls.length ? (
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      {lastBalls.map((ball) => (
                        <div
                          key={ball.id}
                          style={{
                            minWidth: 34,
                            height: 34,
                            padding: "0 10px",
                            borderRadius: 999,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            fontWeight: 1000,
                            fontSize: 13,
                            background: ball.wicket
                              ? "#b91c1c"
                              : ball.extraType
                                ? "rgba(59,130,246,0.95)"
                                : ball.runs === 4 || ball.runs === 6
                                  ? "rgba(34,197,94,0.95)"
                                  : ball.runs === 0
                                    ? "rgba(148,163,184,0.45)"
                                    : "rgba(255,255,255,0.10)",
                            color: ball.wicket
                              ? "white"
                              : (ball.extraType || ball.runs === 4 || ball.runs === 6 ? "#0b1220" : themeText),
                          }}
                        >
                          {ball.label}
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
                    <div key={item} style={{ fontSize: 13, color: themeText }}>
                      {item}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          {activeTab === "scorecard" ? (
            <div style={{ display: "grid", gap: 12 }}>
              {(liveInnings === 2
                ? [
                    { inningsNo: 2, team: innings2Team, balls: inn2Balls },
                    { inningsNo: 1, team: innings1Team, balls: inn1Balls },
                  ]
                : [
                    { inningsNo: 1, team: innings1Team, balls: inn1Balls },
                    { inningsNo: 2, team: innings2Team, balls: inn2Balls },
                  ]
              ).filter((entry) => entry.inningsNo === 1 || inn2Row).map((entry) => (
                <ScorecardTables
                  key={`scorecard-${entry.inningsNo}`}
                  theme="dark"
                  title={`Innings ${entry.inningsNo}${entry.team?.name ? `: ${entry.team.name}` : ""}`}
                  balls={entry.balls}
                  playersById={playersById}
                />
              ))}
            </div>
          ) : null}

          {activeTab === "commentary" ? (
            <div style={{ ...liveCardStyle, padding: 14 }}>
              <div style={{ fontWeight: 1000, marginBottom: 8 }}>Commentary</div>
              <div style={{ fontSize: 12, color: subText, marginBottom: 12 }}>
                Grouped by over for innings {activeInnings}
              </div>
              <BallByBall balls={tabBalls} groupByOver />
            </div>
          ) : null}

          {activeTab === "stats" ? (
            <div style={{ display: "grid", gap: 12 }}>
              <div style={liveCardStyle}>
                <Partnerships balls={tabBalls} playersById={playersById} theme="dark" compact />
              </div>
              <div style={liveCardStyle}>
                <WormGraph
                  innings1Balls={inn1Balls}
                  innings2Balls={inn2Balls}
                  target={inn1Balls.length ? innings1Totals.runs + 1 : null}
                  theme="dark"
                  maxOvers={oversLimit}
                  compact
                />
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
