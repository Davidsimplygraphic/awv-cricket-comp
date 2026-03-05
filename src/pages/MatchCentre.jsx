import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { supabase } from "../lib/supabase";

import Partnerships from "../components/Partnerships";
import WormGraph from "../components/WormGraph";
import BallByBall from "../components/BallByBall";
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
  // Treat NULL as legal (legacy rows); only explicit false is illegal
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

function buildResultText({ matchStatus, inn1Team, inn2Team, inn1, inn2, wicketCap, oversLimit }) {
  const s = String(matchStatus || "").toLowerCase();
  if (s !== "completed") return "";
  if (!inn1 || !inn2) return "";

  const hasI1 = (inn1.balls || []).length > 0 || inn1.completed;
  const hasI2 = (inn2.balls || []).length > 0 || inn2.completed;
  if (!hasI1 || !hasI2) return "";

  const i1Runs = inn1.runs;
  const i2Runs = inn2.runs;
  const target = i1Runs + 1;

  if (i2Runs >= target) {
    const wktsRemaining = Math.max(0, toInt(wicketCap, 10) - inn2.wkts);
    const maxLegal = toInt(oversLimit, 20) * 6;
    const ballsRemaining = Math.max(0, maxLegal - toInt(inn2.legalBalls, 0));
    return `${inn2Team?.name || inn2Team?.short_name || "Team 2"} won by ${wktsRemaining} wicket${wktsRemaining === 1 ? "" : "s"} with ${ballsRemaining} ball${ballsRemaining === 1 ? "" : "s"} remaining`;
  }

  if (i1Runs > i2Runs) {
    const runsBy = i1Runs - i2Runs;
    return `${inn1Team?.name || inn1Team?.short_name || "Team 1"} won by ${runsBy} run${runsBy === 1 ? "" : "s"}`;
  }

  return "Match tied";
}

export default function MatchCentre() {
  const { fixtureId } = useParams();

  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  const [players, setPlayers] = useState([]);
  const [match, setMatch] = useState(null);
  const [inningsByNo, setInningsByNo] = useState({}); // {1: row, 2: row}
  const [ballsByInnings, setBallsByInnings] = useState({}); // {inningsId: balls[]}

  const [activeTab, setActiveTab] = useState("scorecard"); // scorecard | partnership | worm
  const [activeInnings, setActiveInnings] = useState(1); // 1 or 2

  // Load players + match + innings + balls
  useEffect(() => {
    let alive = true;

    (async () => {
      setLoading(true);
      setErr("");

      const p = await supabase.from("players").select("*");
      if (!alive) return;
      if (p.error) {
        setErr(p.error.message);
        setLoading(false);
        return;
      }
      setPlayers(p.data || []);

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
          team_a_id,
          team_b_id,
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
        setErr(m.error.message);
        setLoading(false);
        return;
      }
      if (!m.data) {
        setErr("No match found for this fixture.");
        setLoading(false);
        return;
      }

      setMatch(m.data);

      const inn = await supabase
        .from("innings")
        .select("id,match_id,innings_no,batting_team_id,bowling_team_id,completed")
        .eq("match_id", m.data.id)
        .order("innings_no", { ascending: true });

      if (!alive) return;
      if (inn.error) {
        setErr(inn.error.message);
        setLoading(false);
        return;
      }

      const map = {};
      (inn.data || []).forEach((r) => {
        const n = Number(r.innings_no);
        if (n === 1 || n === 2) map[n] = r;
      });
      setInningsByNo(map);

      const ballsMap = {};
      for (const r of inn.data || []) {
        const b = await supabase
          .from("balls")
          .select("*")
          .eq("match_id", m.data.id)
          .eq("innings_id", r.id)
          .order("over_no", { ascending: true })
          .order("delivery_in_over", { ascending: true });
        if (!alive) return;
        if (b.error) {
          setErr(b.error.message);
          setLoading(false);
          return;
        }
        ballsMap[r.id] = sortBalls(b.data || []);
      }
      setBallsByInnings(ballsMap);

      // Pick active innings based on whether innings 2 has data or match is completed
      const inn2 = map[2] || null;
      const inn2Has = inn2 ? (ballsMap[inn2.id] || []).length > 0 || !!inn2.completed : false;
      setActiveInnings(inn2Has ? 2 : 1);

      setLoading(false);
    })();

    return () => {
      alive = false;
    };
  }, [fixtureId]);

  // Realtime subscribe to balls for innings 1 & 2
  useEffect(() => {
    if (!match?.id) return;
    const inn1 = inningsByNo?.[1] || null;
    const inn2 = inningsByNo?.[2] || null;
    const ids = [inn1?.id, inn2?.id].filter(Boolean);
    if (!ids.length) return;

    const chans = ids.map((inningsId) =>
      supabase
        .channel(`match-centre-balls-${fixtureId}-${inningsId}`)
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
            if (!b.error) {
              setBallsByInnings((prev) => ({ ...prev, [inningsId]: sortBalls(b.data || []) }));
            }
          }
        )
        .subscribe()
    );

    return () => {
      chans.forEach((c) => supabase.removeChannel(c));
    };
  }, [fixtureId, match?.id, inningsByNo]);

  // Realtime subscribe to match status changes
  useEffect(() => {
    if (!match?.id) return;
    const ch = supabase
      .channel(`match-centre-match-${fixtureId}-${match.id}`)
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

  // IMPORTANT: ScorecardTables expects an object map (playersById[playerId]).
  // If we pass a Map here, every lookup becomes undefined and the UI shows "Unknown".
  const playersById = useMemo(() => {
    const m = {};
    (players || []).forEach((p) => {
      m[p.id] = p;
    });
    return m;
  }, [players]);

  const inn1Row = inningsByNo?.[1] || null;
  const inn2Row = inningsByNo?.[2] || null;
  const inn1Balls = inn1Row ? ballsByInnings?.[inn1Row.id] || [] : [];
  const inn2Balls = inn2Row ? ballsByInnings?.[inn2Row.id] || [] : [];

  const inn1 = useMemo(() => {
    if (!inn1Row) return null;
    const legal = legalBallsCount(inn1Balls);
    return {
      completed: !!inn1Row.completed,
      runs: sumRuns(inn1Balls),
      wkts: sumWkts(inn1Balls),
      legalBalls: legal,
      overs: oversTextFromLegal(legal),
      balls: inn1Balls,
    };
  }, [inn1Row, inn1Balls]);

  const inn2 = useMemo(() => {
    if (!inn2Row) return null;
    const legal = legalBallsCount(inn2Balls);
    return {
      completed: !!inn2Row.completed,
      runs: sumRuns(inn2Balls),
      wkts: sumWkts(inn2Balls),
      legalBalls: legal,
      overs: oversTextFromLegal(legal),
      balls: inn2Balls,
    };
  }, [inn2Row, inn2Balls]);

  const teamA = match?.team_a || null;
  const teamB = match?.team_b || null;
  const matchTitle = `${teamA?.name || teamA?.short_name || "Team A"} vs ${teamB?.name || teamB?.short_name || "Team B"}`;

  const teamById = useMemo(() => {
    const m = new Map();
    if (teamA?.id) m.set(teamA.id, teamA);
    if (teamB?.id) m.set(teamB.id, teamB);
    return m;
  }, [teamA, teamB]);

  const inn1Team = inn1Row?.batting_team_id ? teamById.get(inn1Row.batting_team_id) : teamA;
  const inn2Team = inn2Row?.batting_team_id ? teamById.get(inn2Row.batting_team_id) : teamB;

  const derivedStatus = useMemo(() => {
    const raw = String(match?.status || "").toLowerCase();
    if (raw === "completed") return "completed";
    const anyBalls = (inn1Balls?.length || 0) + (inn2Balls?.length || 0) > 0;
    if (!anyBalls) return raw || "scheduled";

    // If innings suggest completion (chase done OR innings 2 exhausted), treat as completed.
    const oversLimit = toInt(match?.overs_limit, 20);
    const wicketCap = toInt(match?.wicket_cap, 10);
    const maxLegal = oversLimit * 6;

    const i1Runs = inn1 ? inn1.runs : 0;
    const i2Runs = inn2 ? inn2.runs : 0;
    const i2Legal = inn2 ? toInt(inn2.legalBalls, 0) : 0;
    const i2Wkts = inn2 ? toInt(inn2.wkts, 0) : 0;

    const chaseCompleted = !!inn1 && !!inn2 && i2Runs >= i1Runs + 1;
    const inn2Exhausted = !!inn2 && (i2Legal >= maxLegal || i2Wkts >= wicketCap || !!inn2.completed);
    const inningsSuggestCompleted = !!inn1 && !!inn2 && (chaseCompleted || inn2Exhausted);

    if (inningsSuggestCompleted) return "completed";
    return "live";
  }, [match?.status, match?.overs_limit, match?.wicket_cap, inn1, inn2, inn1Balls, inn2Balls]);

  const resultText = useMemo(() => {
    return buildResultText({
      matchStatus: derivedStatus,
      inn1Team,
      inn2Team,
      inn1,
      inn2,
      wicketCap: match?.wicket_cap,
      oversLimit: match?.overs_limit,
    });
  }, [derivedStatus, match?.wicket_cap, match?.overs_limit, inn1Team, inn2Team, inn1, inn2]);

const activeBalls = useMemo(() => {
    if (activeInnings === 2) return inn2Balls;
    return inn1Balls;
  }, [activeInnings, inn1Balls, inn2Balls]);

  if (loading) {
    return (
      <div style={{ maxWidth: 980, margin: "0 auto", padding: 16, color: "#64748B" }}>
        Loading match centre…
      </div>
    );
  }

  if (err) {
    return (
      <div style={{ maxWidth: 980, margin: "0 auto", padding: 16 }}>
        <div style={{ color: "crimson", marginBottom: 12, fontWeight: 800 }}>{err}</div>
        <Link to="/fixtures">Back to fixtures</Link>
      </div>
    );
  }

  if (!match) {
    return (
      <div style={{ maxWidth: 980, margin: "0 auto", padding: 16 }}>
        <div style={{ padding: 12, border: "1px solid #E5E7EB", borderRadius: 12, color: "#475569" }}>
          No match found.
        </div>
        <div style={{ marginTop: 12 }}>
          <Link to="/fixtures">Back to fixtures</Link>
        </div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 980, margin: "0 auto", padding: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontWeight: 1000, fontSize: 18 }}>{matchTitle}</div>
          <div style={{ color: "#64748B", fontSize: 13 }}>Match Centre</div>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <Link to="/fixtures" style={{ fontSize: 13 }}>
            Back
          </Link>
        </div>
      </div>

      {/* Header card */}
      <div
        style={{
          marginTop: 12,
          borderRadius: 16,
          background:
            "radial-gradient(1200px 500px at 0% 0%, rgba(255,255,255,0.08), rgba(255,255,255,0)), #0B1220",
          border: "1px solid rgba(255,255,255,0.08)",
          padding: 16,
          color: "white",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div>
            <div style={{ fontWeight: 1000, fontSize: 14, opacity: 0.95 }}>
              {teamA?.name || "—"} vs {teamB?.name || "—"}
            </div>

            <div style={{ fontSize: 13, opacity: 0.75, marginTop: 6 }}>
              {teamA?.name || "Team A"}: {inn1 ? `${inn1.runs}/${inn1.wkts} (${inn1.overs} ov)` : "—"}
            </div>
            <div style={{ fontSize: 13, opacity: 0.75, marginTop: 2 }}>
              {teamB?.name || "Team B"}: {inn2 ? `${inn2.runs}/${inn2.wkts} (${inn2.overs} ov)` : "—"}
            </div>
          </div>

          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 12, opacity: 0.75, fontWeight: 900 }}>Status</div>
            <div style={{ fontSize: 14, fontWeight: 1000 }}>{String(derivedStatus || "").toUpperCase()}</div>
          </div>
        </div>

        {resultText ? (
          <div style={{ marginTop: 10, fontWeight: 1000, color: "rgba(255,228,176,0.95)" }}>{resultText}</div>
        ) : null}

        {/* Tabs */}
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
                padding: "8px 10px",
                border: "1px solid rgba(255,255,255,0.12)",
                background: activeTab === t.key ? "rgba(255,255,255,0.16)" : "rgba(255,255,255,0.06)",
                color: "white",
                cursor: "pointer",
                fontWeight: 900,
                fontSize: 12,
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Innings toggle for worm/partnership/ball */}
      {activeTab !== "scorecard" ? (
        <div style={{ marginTop: 12, display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button
            onClick={() => setActiveInnings(1)}
            style={{
              borderRadius: 12,
              padding: "10px 12px",
              border: "1px solid #E5E7EB",
              background: activeInnings === 1 ? "#0B1B44" : "#F8FAFC",
              color: activeInnings === 1 ? "white" : "#0B1B44",
              cursor: "pointer",
              fontWeight: 1000,
            }}
          >
            Innings 1
          </button>
          <button
            onClick={() => setActiveInnings(2)}
            disabled={!inn2Row}
            style={{
              borderRadius: 12,
              padding: "10px 12px",
              border: "1px solid #E5E7EB",
              background: activeInnings === 2 ? "#0B1B44" : "#F8FAFC",
              color: activeInnings === 2 ? "white" : "#0B1B44",
              cursor: inn2Row ? "pointer" : "not-allowed",
              fontWeight: 1000,
              opacity: inn2Row ? 1 : 0.5,
            }}
          >
            Innings 2
          </button>
        </div>
      ) : null}

      {/* Tab content */}
      <div style={{ marginTop: 12 }}>
        {activeTab === "scorecard" ? (
          <div style={{ display: "grid", gap: 12 }}>
            <ScorecardTables theme="light" title={`Innings 1${teamA?.name ? `: ${teamA.name}` : ""}`} balls={inn1Balls} playersById={playersById} />
            <ScorecardTables theme="light" title={`Innings 2${teamB?.name ? `: ${teamB.name}` : ""}`} balls={inn2Balls} playersById={playersById} />
          </div>
        ) : null}

        {activeTab === "partnership" ? (
          <div style={{ borderRadius: 16, border: "1px solid #E5E7EB", overflow: "hidden" }}>
            <div style={{ padding: 12, background: "#F8FAFC", borderBottom: "1px solid #E5E7EB", fontWeight: 1000 }}>
              Partnerships — {activeInnings === 1 ? teamA?.name : teamB?.name}
            </div>
            <div style={{ padding: 12 }}>
              <Partnerships balls={activeBalls} theme="light" />
            </div>
          </div>
        ) : null}

        {activeTab === "worm" ? (
          <div style={{ borderRadius: 16, border: "1px solid #E5E7EB", overflow: "hidden" }}>
            <div style={{ padding: 12, background: "#F8FAFC", borderBottom: "1px solid #E5E7EB", fontWeight: 1000 }}>
              Worm — Innings 1 vs Innings 2
            </div>
            <div style={{ padding: 12 }}>
              <WormGraph innings1Balls={inn1Balls} innings2Balls={inn2Balls} target={inn1 ? inn1.runs + 1 : null} theme="light" maxOvers={toInt(match?.overs_limit, 20)} />
            </div>
          </div>
        ) : null}</div>
    </div>
  );
}
