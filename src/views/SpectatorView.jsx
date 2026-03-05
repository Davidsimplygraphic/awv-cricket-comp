import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { supabase } from "../lib/supabase";

import BallByBall from "../components/BallByBall";
import Partnerships from "../components/Partnerships";
import WormGraph from "../components/WormGraph";
import ScorecardTables from "../components/ScorecardTables";

function toInt(n, fallback = 0) {
  const x = Number(n);
  return Number.isFinite(x) ? x : fallback;
}

function sortBalls(balls) {
  return (balls || [])
    .slice()
    .sort((a, b) => (a.over_no - b.over_no) || (a.delivery_in_over - b.delivery_in_over) || 0);
}

function sumRuns(balls) {
  return (balls || []).reduce((acc, b) => acc + toInt(b.runs_off_bat, 0) + toInt(b.extra_runs, 0), 0);
}

function sumWkts(balls) {
  return (balls || []).reduce((acc, b) => acc + (b.wicket ? 1 : 0), 0);
}

function legalBallsCount(balls) {
  // Treat NULL as legal (legacy rows); only explicit false is illegal
  return (balls || []).filter((b) => b.legal_ball !== false).length;
}

function oversTextFromLegal(legalBalls) {
  const overs = Math.floor(legalBalls / 6);
  const ballsInOver = legalBalls % 6;
  return `${overs}.${ballsInOver}`;
}

function playerName(playersById, playerId) {
  if (!playerId) return null;
  return playersById[playerId]?.name || null;
}

function currentTurnForPlayer(balls, playerId) {
  if (!playerId) return 1;
  const outs = (balls || []).filter((b) => b.wicket && b.dismissed_player_id === playerId).length;
  // Tournament rule allows batting again; each dismissal increments the "turn".
  return outs + 1;
}

function batterStats(balls, batterId, turn = 1) {
  if (!batterId) return null;
  const t = toInt(turn, 1) || 1;

  // This app records striker contributions on each ball (striker_id + batting_turn).
  const facedAsStriker = (balls || []).filter(
    (b) => b.striker_id === batterId && toInt(b.batting_turn, 1) === t
  );

  // Balls faced: legal deliveries faced by this batsman; wides do not count as faced balls.
  // (Older rows may not have is_wide; extra_type === 'wide' is also supported.)
  const ballsFaced = facedAsStriker.filter(
    (b) => b.legal_ball !== false && !b.is_wide && b.extra_type !== "wide"
  ).length;

  const runs = facedAsStriker.reduce((acc, b) => acc + toInt(b.runs_off_bat, 0), 0);
  const fours = facedAsStriker.filter((b) => toInt(b.runs_off_bat, 0) === 4).length;
  const sixes = facedAsStriker.filter((b) => toInt(b.runs_off_bat, 0) === 6).length;

  const sr = ballsFaced > 0 ? (runs / ballsFaced) * 100 : 0;
  return { r: runs, b: ballsFaced, fours, sixes, sr };
}

function bowlerStats(balls, bowlerId) {
  if (!bowlerId) return null;
  const by = (balls || []).filter((b) => b.bowler_id === bowlerId);
  const legal = by.filter((b) => b.legal_ball !== false).length;

  // runs conceded includes extras; keep it simple: extra_runs + runs_off_bat
  const runs = by.reduce((acc, b) => acc + toInt(b.runs_off_bat, 0) + toInt(b.extra_runs, 0), 0);
  const wkts = by.filter((b) => !!b.wicket).length;

  const overs = oversTextFromLegal(legal);
  const econ = legal > 0 ? (runs / (legal / 6)) : 0;
  return { overs, runs, wkts, econ };
}

export default function SpectatorView() {
  const { fixtureId } = useParams();

  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  const [match, setMatch] = useState(null);
  const [inningsByNo, setInningsByNo] = useState({});
  const [ballsByInnings, setBallsByInnings] = useState({});
  const [players, setPlayers] = useState([]);

  // No Ball-by-ball tab in spectator (Recent balls is shown)
  const [activeTab, setActiveTab] = useState("scorecard"); // scorecard | partnership | worm
  const [activeInnings, setActiveInnings] = useState(1);

  // Load match, innings, balls, players
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

      // players for both teams
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
      (inn.data || []).forEach((r) => {
        byNo[toInt(r.innings_no, 0)] = r;
      });
      setInningsByNo(byNo);

      const ballsMap = {};
      for (const r of inn.data || []) {
        const b = await supabase
          .from("balls")
          .select("*")
          .eq("match_id", m.data.id)
          .eq("innings_id", r.id)
          .order("over_no", { ascending: true })
          .order("delivery_in_over", { ascending: true });

        if (!b.error) ballsMap[r.id] = sortBalls(b.data || []);
      }
      setBallsByInnings(ballsMap);

      // choose a sensible default innings
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

  // Realtime subscribe to balls changes
  useEffect(() => {
    if (!match?.id) return;
    const inn1 = inningsByNo?.[1] || null;
    const inn2 = inningsByNo?.[2] || null;
    const ids = [inn1?.id, inn2?.id].filter(Boolean);
    if (!ids.length) return;

    const chans = ids.map((inningsId) =>
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

            if (!b.error) setBallsByInnings((prev) => ({ ...prev, [inningsId]: sortBalls(b.data || []) }));
          }
        )
        .subscribe()
    );

    return () => {
      chans.forEach((c) => supabase.removeChannel(c));
    };
  }, [fixtureId, match?.id, inningsByNo]);

  // Realtime subscribe to match updates
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

          if (!m.error && m.data) setMatch(m.data);
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(ch);
    };
  }, [fixtureId, match?.id]);

  const playersById = useMemo(() => {
    const map = {};
    (players || []).forEach((p) => {
      map[p.id] = p;
    });
    return map;
  }, [players]);

  const teamA = match?.team_a || null;
  const teamB = match?.team_b || null;

  const inn1Row = inningsByNo?.[1] || null;
  const inn2Row = inningsByNo?.[2] || null;

  const inn1Balls = inn1Row ? (ballsByInnings?.[inn1Row.id] || []) : [];
  const inn2Balls = inn2Row ? (ballsByInnings?.[inn2Row.id] || []) : [];

  const activeRow = activeInnings === 2 ? inn2Row : inn1Row;
  const activeBalls = activeRow ? (ballsByInnings?.[activeRow.id] || []) : [];

  const oversLimit = toInt(match?.overs_limit, 20);
  const wicketCap = toInt(match?.wicket_cap, 0);

  const innings1Totals = useMemo(() => {
    const legal = legalBallsCount(inn1Balls);
    return { runs: sumRuns(inn1Balls), wkts: sumWkts(inn1Balls), legal };
  }, [inn1Balls]);

  const innings2Totals = useMemo(() => {
    const legal = legalBallsCount(inn2Balls);
    return { runs: sumRuns(inn2Balls), wkts: sumWkts(inn2Balls), legal };
  }, [inn2Balls]);

  const activeTotals = useMemo(() => {
    const legal = legalBallsCount(activeBalls);
    return { runs: sumRuns(activeBalls), wkts: sumWkts(activeBalls), legal };
  }, [activeBalls]);

  const oversText = oversTextFromLegal(activeTotals.legal);
  const crr = activeTotals.legal ? (activeTotals.runs / (activeTotals.legal / 6)) : 0;

  const target = innings1Totals.runs + 1;
  const runsNeeded = Math.max(0, target - innings2Totals.runs);
  const ballsRemaining = Math.max(0, oversLimit * 6 - innings2Totals.legal);
  const rrr = (ballsRemaining > 0) ? (runsNeeded / (ballsRemaining / 6)) : 0;

  const derivedStatus = useMemo(() => {
    const raw = String(match?.status || "").toLowerCase();

    // If DB says completed but 2nd innings has not started and there are balls in innings1, show "live"
    if (raw === "completed" && inn2Balls.length === 0 && inn1Balls.length > 0) return "live";
    return raw || "scheduled";
  }, [match?.status, inn1Balls.length, inn2Balls.length]);

  // Latest ball for striker/non-striker/bowler
  const lastBall = activeBalls.length ? activeBalls[activeBalls.length - 1] : null;
  const striker = lastBall ? playersById[lastBall.striker_id] : null;
  const nonStriker = lastBall ? playersById[lastBall.non_striker_id] : null;
  const bowler = lastBall ? playersById[lastBall.bowler_id] : null;

  const strikerTurnNow = striker?.id ? (lastBall?.batting_turn || currentTurnForPlayer(activeBalls, striker.id)) : 1;
  const nonStrikerTurnNow = nonStriker?.id ? currentTurnForPlayer(activeBalls, nonStriker.id) : 1;

  const strikerStats = batterStats(activeBalls, striker?.id, strikerTurnNow);
  const nonStrikerStats = batterStats(activeBalls, nonStriker?.id, nonStrikerTurnNow);
  const bowlerS = bowlerStats(activeBalls, bowler?.id);

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
    <div style={{ padding: 18, color: "rgba(255,255,255,0.92)", background: "#0b1220", minHeight: "100vh" }}>
      <div style={{ maxWidth: 980, margin: "0 auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
          <div>
            <div style={{ fontWeight: 1000, fontSize: 18 }}>
              {(teamA?.short_name || teamA?.name || "Team A")} vs {(teamB?.short_name || teamB?.name || "Team B")}
            </div>
            <div style={{ opacity: 0.75, marginTop: 2, fontSize: 12 }}>Spectator</div>
          </div>

          <Link to="/fixtures" style={{ color: "rgba(180,210,255,0.95)", fontWeight: 900, fontSize: 12 }}>
            Back
          </Link>
        </div>

        {/* Top summary */}
        <div
          style={{
            marginTop: 14,
            borderRadius: 18,
            padding: 16,
            border: "1px solid rgba(255,255,255,0.10)",
            background: "#0b1220",
            overflow: "hidden",
          }}
        >
          <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 12, alignItems: "start" }}>
            <div>
              <div style={{ opacity: 0.75, fontSize: 12, fontWeight: 900 }}>Innings {activeInnings}</div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", marginTop: 6 }}>
                <div style={{ fontSize: 32, fontWeight: 1100, letterSpacing: -0.5 }}>
                  {activeTotals.runs}/{activeTotals.wkts}
                </div>
                <div style={{ opacity: 0.8, fontWeight: 900 }}>({oversText} ov)</div>
              </div>
            </div>

            <div style={{ display: "grid", gap: 6, textAlign: "right", fontSize: 12, opacity: 0.9 }}>
              <div>
                <span style={{ opacity: 0.75 }}>Status</span>{" "}
                <span style={{ fontWeight: 1000 }}>{String(derivedStatus).toUpperCase()}</span>
              </div>
              <div>
                <span style={{ opacity: 0.75 }}>CRR</span> <span style={{ fontWeight: 900 }}>{crr.toFixed(2)}</span>
              </div>

              {activeInnings === 2 ? (
                <div style={{ display: "contents" }}>
                  <div>
                    <span style={{ opacity: 0.75 }}>Target</span> <span style={{ fontWeight: 900 }}>{target}</span>
                  </div>
                  <div>
                    <span style={{ opacity: 0.75 }}>Need</span>{" "}
                    <span style={{ fontWeight: 900 }}>
                      {runsNeeded} in {ballsRemaining}
                    </span>
                  </div>
                  <div>
                    <span style={{ opacity: 0.75 }}>RRR</span>{" "}
                    <span style={{ fontWeight: 900 }}>{Number.isFinite(rrr) ? rrr.toFixed(2) : "0.00"}</span>
                  </div>
                </div>
              ) : (
                <div>
                  <span style={{ opacity: 0.75 }}>Wicket cap</span> <span style={{ fontWeight: 900 }}>{wicketCap}</span>
                </div>
              )}
            </div>
          </div>

          {/* Innings toggle */}
          <div style={{ display: "flex", gap: 10, marginTop: 12, flexWrap: "wrap" }}>
            <button
              onClick={() => setActiveInnings(1)}
              style={{
                borderRadius: 10,
                padding: "6px 10px",
                cursor: "pointer",
                border: "1px solid rgba(255,255,255,0.16)",
                background: activeInnings === 1 ? "rgba(255,255,255,0.18)" : "rgba(0,0,0,0.18)",
                color: "rgba(255,255,255,0.92)",
                fontWeight: 900,
                fontSize: 12,
              }}
            >
              Innings 1
            </button>

            <button
              onClick={() => inn2Row && setActiveInnings(2)}
              disabled={!inn2Row}
              style={{
                borderRadius: 10,
                padding: "6px 10px",
                cursor: inn2Row ? "pointer" : "not-allowed",
                border: "1px solid rgba(255,255,255,0.16)",
                background: activeInnings === 2 ? "rgba(255,255,255,0.18)" : "rgba(0,0,0,0.18)",
                color: inn2Row ? "rgba(255,255,255,0.92)" : "rgba(255,255,255,0.45)",
                fontWeight: 900,
                fontSize: 12,
              }}
            >
              Innings 2
            </button>
          </div>

          {/* Batters / Bowler (mobile-friendly wrap) */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
              gap: 12,
              marginTop: 12,
            }}
          >
            <div style={{ borderRadius: 14, border: "1px solid rgba(255,255,255,0.10)", background: "rgba(0,0,0,0.20)", padding: 12 }}>
              <div style={{ opacity: 0.75, fontSize: 12, fontWeight: 900, marginBottom: 6 }}>Striker</div>
              <div style={{ fontWeight: 1000 }}>{striker?.name || "—"}</div>
              {strikerStats ? (
                <div style={{ marginTop: 6, fontSize: 12, opacity: 0.85 }}>
                  <div>
                    <span style={{ fontWeight: 900 }}>{strikerStats.r}</span> ({strikerStats.b}) • SR {strikerStats.sr.toFixed(1)}
                  </div>
                  <div style={{ opacity: 0.8 }}>4s {strikerStats.fours} • 6s {strikerStats.sixes}</div>
                </div>
              ) : (
                <div style={{ marginTop: 6, fontSize: 12, opacity: 0.65 }}>Waiting for first ball…</div>
              )}
            </div>

            <div style={{ borderRadius: 14, border: "1px solid rgba(255,255,255,0.10)", background: "rgba(0,0,0,0.20)", padding: 12 }}>
              <div style={{ opacity: 0.75, fontSize: 12, fontWeight: 900, marginBottom: 6 }}>Non-striker</div>
              <div style={{ fontWeight: 1000 }}>{nonStriker?.name || "—"}</div>
              {nonStrikerStats ? (
                <div style={{ marginTop: 6, fontSize: 12, opacity: 0.85 }}>
                  <div>
                    <span style={{ fontWeight: 900 }}>{nonStrikerStats.r}</span> ({nonStrikerStats.b}) • SR {nonStrikerStats.sr.toFixed(1)}
                  </div>
                  <div style={{ opacity: 0.8 }}>4s {nonStrikerStats.fours} • 6s {nonStrikerStats.sixes}</div>
                </div>
              ) : (
                <div style={{ marginTop: 6, fontSize: 12, opacity: 0.65 }}>Waiting for first ball…</div>
              )}
            </div>

            <div style={{ borderRadius: 14, border: "1px solid rgba(255,255,255,0.10)", background: "rgba(0,0,0,0.20)", padding: 12 }}>
              <div style={{ opacity: 0.75, fontSize: 12, fontWeight: 900, marginBottom: 6 }}>Bowler</div>
              <div style={{ fontWeight: 1000 }}>{bowler?.name || "—"}</div>
              {bowlerS ? (
                <div style={{ marginTop: 6, fontSize: 12, opacity: 0.85 }}>
                  <div>
                    {bowlerS.overs} ov • {bowlerS.runs} runs • {bowlerS.wkts} w
                  </div>
                  <div style={{ opacity: 0.8 }}>Econ {bowlerS.econ.toFixed(2)}</div>
                </div>
              ) : (
                <div style={{ marginTop: 6, fontSize: 12, opacity: 0.65 }}>Waiting for first ball…</div>
              )}
            </div>
          </div>

          {/* Recent balls (shown always, no Ball-by-ball tab) */}
          <div style={{ marginTop: 12 }}>
            <div style={{ fontWeight: 1000, marginBottom: 8 }}>Recent balls</div>
            <BallByBall balls={activeBalls} />
          </div>

          {/* Tabs (no Ball-by-ball) */}
          <div style={{ display: "flex", gap: 10, marginTop: 12, flexWrap: "wrap" }}>
            {[
              { key: "scorecard", label: "Scorecard" },
              { key: "partnership", label: "Partnership" },
              { key: "worm", label: "Worm" },
            ].map((t) => (
              <button
                key={t.key}
                onClick={() => setActiveTab(t.key)}
                style={{
                  borderRadius: 10,
                  padding: "6px 10px",
                  cursor: "pointer",
                  border: "1px solid rgba(255,255,255,0.16)",
                  background: activeTab === t.key ? "rgba(255,255,255,0.18)" : "rgba(0,0,0,0.18)",
                  color: "rgba(255,255,255,0.92)",
                  fontWeight: 900,
                  fontSize: 12,
                }}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div style={{ marginTop: 12 }}>
            {activeTab === "scorecard" ? (
              <div style={{ display: "grid", gap: 12 }}>
                <ScorecardTables
                  theme="dark"
                  title={`Innings 1${teamA?.name ? `: ${teamA.name}` : ""}`}
                  balls={inn1Balls}
                  playersById={playersById}
                />
                {inn2Row ? (
                  <ScorecardTables
                    theme="dark"
                    title={`Innings 2${teamB?.name ? `: ${teamB.name}` : ""}`}
                    balls={inn2Balls}
                    playersById={playersById}
                  />
                ) : null}
              </div>
            ) : null}

            {activeTab === "partnership" ? (
              <div style={{ borderRadius: 14, border: "1px solid rgba(255,255,255,0.10)", background: "rgba(0,0,0,0.18)", padding: 12 }}>
                <Partnerships balls={activeBalls} theme="dark" />
              </div>
            ) : null}

            {activeTab === "worm" ? (
              <div style={{ borderRadius: 14, border: "1px solid rgba(255,255,255,0.10)", background: "rgba(0,0,0,0.18)", padding: 12 }}>
                <WormGraph
                  innings1Balls={inn1Balls}
                  innings2Balls={inn2Balls}
                  target={inn1Balls.length ? innings1Totals.runs + 1 : null}
                  theme="dark"
                  maxOvers={oversLimit}
                />
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}