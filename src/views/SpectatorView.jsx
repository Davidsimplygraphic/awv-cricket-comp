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

function sumRuns(balls) {
  return (balls || []).reduce((acc, b) => acc + toInt(b.runs_off_bat, 0) + toInt(b.extra_runs, 0), 0);
}

function sumWkts(balls) {
  return (balls || []).reduce((acc, b) => acc + (b.wicket ? 1 : 0), 0);
}

function legalBallsCount(balls) {
  return (balls || []).reduce((acc, b) => acc + (b?.legal_ball !== false ? 1 : 0), 0);
}

function oversTextFromLegal(legalBalls) {
  const overs = Math.floor(legalBalls / 6);
  const ballsInOver = legalBalls % 6;
  return `${overs}.${ballsInOver}`;
}

function sortBalls(balls) {
  return (balls || [])
    .slice()
    .sort(
      (a, b) =>
        (toInt(a.over_no, 0) - toInt(b.over_no, 0)) ||
        (toInt(a.delivery_in_over, 0) - toInt(b.delivery_in_over, 0)) ||
        0
    );
}

function shortName(team) {
  if (!team) return "??";
  return (team.short_name || team.name || "??").toString();
}

function batterStats(balls, playerId) {
  let r = 0;
  let b = 0;
  let fours = 0;
  let sixes = 0;
  let outs = 0;

  for (const x of balls || []) {
    if (x.striker_id === playerId) {
      const off = toInt(x.runs_off_bat, 0);
      r += off;
      if (x?.legal_ball !== false) b += 1;
      if (off === 4) fours += 1;
      if (off === 6) sixes += 1;
    }
    if (x.wicket && x.dismissed_player_id === playerId) outs += 1;
  }

  const sr = b ? (r / b) * 100 : 0;
  return { r, b, fours, sixes, sr, outs };
}

function bowlerStats(balls, playerId) {
  let legal = 0;
  let runs = 0;
  let wkts = 0;

  for (const x of balls || []) {
    if (x.bowler_id !== playerId) continue;
    runs += toInt(x.runs_off_bat, 0) + toInt(x.extra_runs, 0);
    if (x.wicket) wkts += 1;
    if (x?.legal_ball !== false) legal += 1;
  }

  const overs = oversTextFromLegal(legal);
  const econ = legal ? (runs / (legal / 6)) : 0;
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

  const [activeTab, setActiveTab] = useState("ball"); // ball | scorecard | partnership | worm
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

      // players for both teams (active only)
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
      .channel(`spectator-match-${fixtureId}-${match.id}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "matches", filter: `id=eq.${match.id}` },
        (payload) => {
          setMatch((prev) => ({ ...(prev || {}), ...(payload.new || {}) }));
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(ch);
    };
  }, [fixtureId, match?.id]);

  const playersById = useMemo(() => {
    const m = {};
    (players || []).forEach((p) => {
      m[p.id] = p;
    });
    return m;
  }, [players]);

  const teamA = match?.team_a || null;
  const teamB = match?.team_b || null;

  const inn1Row = inningsByNo?.[1] || null;
  const inn2Row = inningsByNo?.[2] || null;

  const inn1Balls = inn1Row ? ballsByInnings?.[inn1Row.id] || [] : [];
  const inn2Balls = inn2Row ? ballsByInnings?.[inn2Row.id] || [] : [];

  const activeRow = activeInnings === 2 ? inn2Row : inn1Row;
  const activeBalls = useMemo(() => (activeInnings === 2 ? inn2Balls : inn1Balls), [activeInnings, inn1Balls, inn2Balls]);

  const activeTotals = useMemo(() => {
    const runs = sumRuns(activeBalls);
    const wkts = sumWkts(activeBalls);
    const legal = legalBallsCount(activeBalls);
    return { runs, wkts, legal, overs: oversTextFromLegal(legal) };
  }, [activeBalls]);

  const innings1Totals = useMemo(() => {
    const runs = sumRuns(inn1Balls);
    const wkts = sumWkts(inn1Balls);
    const legal = legalBallsCount(inn1Balls);
    return { runs, wkts, legal, overs: oversTextFromLegal(legal) };
  }, [inn1Balls]);

  const oversLimit = toInt(match?.overs_limit, 20);
  const wicketCap = toInt(match?.wicket_cap, 10);
  const maxLegal = oversLimit * 6;

  const target = innings1Totals.runs + 1;
  const ballsRemaining = Math.max(0, maxLegal - toInt(activeTotals.legal, 0));
  const runsNeeded = Math.max(0, target - activeTotals.runs);

  const crr = activeTotals.legal ? activeTotals.runs / (activeTotals.legal / 6) : 0;
  const rrr = activeTotals.legal ? (runsNeeded / (ballsRemaining / 6 || 1)) : 0;

  const derivedStatus = useMemo(() => {
    const raw = String(match?.status || "").toLowerCase();
    if (raw === "completed") return "completed";
    const anyBalls = (inn1Balls?.length || 0) + (inn2Balls?.length || 0) > 0;
    if (anyBalls) return "live";
    return raw || "scheduled";
  }, [match?.status, inn1Balls, inn2Balls]);

  const lastBall = activeBalls.length ? activeBalls[activeBalls.length - 1] : null;

  const strikerId = lastBall?.striker_id || "";
  const nonStrikerId = lastBall?.non_striker_id || "";
  const bowlerId = lastBall?.bowler_id || "";

  const striker = strikerId ? playersById[strikerId] : null;
  const nonStriker = nonStrikerId ? playersById[nonStrikerId] : null;
  const bowler = bowlerId ? playersById[bowlerId] : null;

  const strikerStats = strikerId ? batterStats(activeBalls, strikerId) : null;
  const nonStrikerStats = nonStrikerId ? batterStats(activeBalls, nonStrikerId) : null;
  const bowlerS = bowlerId ? bowlerStats(activeBalls, bowlerId) : null;

  const matchTitle = `${shortName(teamA)} vs ${shortName(teamB)}`;

  if (loading) {
    return <div style={{ padding: 16, color: "#64748B" }}>Loading spectator…</div>;
  }

  if (err) {
    return (
      <div style={{ padding: 16 }}>
        <div style={{ color: "crimson", fontWeight: 900, marginBottom: 10 }}>{err}</div>
        <Link to="/fixtures">Back to fixtures</Link>
      </div>
    );
  }

  return (
    <div style={{ padding: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontWeight: 1000, fontSize: 18 }}>{matchTitle}</div>
          <div style={{ color: "#64748B", fontSize: 13 }}>Spectator</div>
        </div>
        <Link to="/fixtures" style={{ fontSize: 13 }}>
          Back
        </Link>
      </div>

      {/* Score card (scorer-like, read-only) */}
      <div
        style={{
          marginTop: 12,
          borderRadius: 18,
          padding: 16,
          background: "linear-gradient(135deg, rgba(15,23,42,0.95), rgba(2,6,23,0.95))",
          color: "rgba(255,255,255,0.92)",
          border: "1px solid rgba(255,255,255,0.10)",
          boxShadow: "0 18px 50px rgba(2,6,23,0.22)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", gap: 14, flexWrap: "wrap", alignItems: "baseline" }}>
          <div>
            <div style={{ fontSize: 12, fontWeight: 900, opacity: 0.8 }}>Innings {activeInnings}</div>
            <div style={{ fontSize: 34, fontWeight: 1100, lineHeight: 1 }}>
              {activeTotals.runs}/{activeTotals.wkts}
              <span style={{ fontSize: 14, fontWeight: 900, opacity: 0.75, marginLeft: 8 }}>({activeTotals.overs} ov)</span>
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
              <>
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
                  <span style={{ opacity: 0.75 }}>RRR</span> <span style={{ fontWeight: 900 }}>{Number.isFinite(rrr) ? rrr.toFixed(2) : "0.00"}</span>
                </div>
              </>
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
            onClick={() => setActiveInnings(2)}
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

        {/* Batters / Bowler */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginTop: 12 }}>
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

        {/* Recent balls */}
        <div style={{ marginTop: 12 }}>
          <div style={{ fontWeight: 1000, marginBottom: 8 }}>Recent balls</div>
          <BallByBall balls={activeBalls} />
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", gap: 10, marginTop: 12, flexWrap: "wrap" }}>
          {[
            { key: "ball", label: "Ball-by-ball" },
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
          {activeTab === "ball" ? (
            <div style={{ borderRadius: 14, border: "1px solid rgba(255,255,255,0.10)", background: "rgba(0,0,0,0.18)", padding: 12 }}>
              <BallByBall balls={activeBalls} />
            </div>
          ) : null}

          {activeTab === "scorecard" ? (
            <div style={{ display: "grid", gap: 12 }}>
              <ScorecardTables theme="dark" title={`Innings 1${teamA?.name ? `: ${teamA.name}` : ""}`} balls={inn1Balls} playersById={playersById} />
              {inn2Row ? <ScorecardTables theme="dark" title={`Innings 2${teamB?.name ? `: ${teamB.name}` : ""}`} balls={inn2Balls} playersById={playersById} /> : null}
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
  );
}
