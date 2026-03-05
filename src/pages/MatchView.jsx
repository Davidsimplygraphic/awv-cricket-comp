import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { supabase } from "../lib/supabase";

/* ---------------- Helpers ---------------- */

function toInt(n, fallback = 0) {
  const x = Number(n);
  return Number.isFinite(x) ? x : fallback;
}

function sortBallsCricketOrder(list) {
  const next = [...list];
  next.sort((a, b) => {
    const oa = toInt(a.over_no, 0);
    const ob = toInt(b.over_no, 0);
    if (oa !== ob) return oa - ob;
    return toInt(a.delivery_in_over, 0) - toInt(b.delivery_in_over, 0);
  });
  return next;
}

function sumRuns(balls) {
  return balls.reduce((acc, b) => acc + (b.runs_off_bat || 0) + (b.extra_runs || 0), 0);
}

function sumWkts(balls) {
  return balls.reduce((acc, b) => acc + (b.wicket ? 1 : 0), 0);
}

function countLegalBalls(balls) {
  return balls.filter((b) => !!b.legal_ball).length;
}

function oversTextFromLegal(legalBalls) {
  const overs = Math.floor(legalBalls / 6);
  const ballsInOver = legalBalls % 6;
  return `${overs}.${ballsInOver}`;
}

function safeDiv(a, b) {
  if (!b) return 0;
  return a / b;
}

function groupBy(arr, keyFn) {
  const m = new Map();
  for (const item of arr) {
    const k = keyFn(item);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(item);
  }
  return m;
}

function buildWormSeries(innBalls) {
  // Returns points as { x: oversFloat, y: runs }
  const points = [{ x: 0, y: 0 }];
  let runs = 0;
  let legal = 0;

  for (const b of innBalls) {
    runs += (b.runs_off_bat || 0) + (b.extra_runs || 0);
    if (b.legal_ball) legal += 1;
    const x = legal / 6;
    points.push({ x, y: runs });
  }

  // de-dup by x (keep last value for same x)
  const byX = new Map();
  for (const p of points) byX.set(p.x, p);
  return Array.from(byX.values()).sort((a, b) => a.x - b.x);
}

function buildPartnerships(innBalls, playerName) {
  // Partnerships are derived from striker/non-striker pairs per delivery.
  // We track runs (incl. extras) and balls (exclude wides).
  const res = [];
  const addCurrent = (cur) => {
    if (!cur) return;
    if (!cur.a || !cur.b) return;
    if (cur.balls <= 0 && cur.runs <= 0) return;
    res.push({
      a: cur.a,
      b: cur.b,
      runs: cur.runs,
      balls: cur.balls,
      aRuns: cur.aRuns,
      aBalls: cur.aBalls,
      bRuns: cur.bRuns,
      bBalls: cur.bBalls,
    });
  };

  let cur = null;

  for (const ball of innBalls) {
    const a = ball.striker_id || "";
    const b = ball.non_striker_id || "";
    if (!a || !b) continue;

    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    const curKey = cur ? (cur.a < cur.b ? `${cur.a}|${cur.b}` : `${cur.b}|${cur.a}`) : null;

    if (!cur || key !== curKey) {
      addCurrent(cur);
      cur = {
        a,
        b,
        runs: 0,
        balls: 0,
        aRuns: 0,
        aBalls: 0,
        bRuns: 0,
        bBalls: 0,
      };
    }

    // partnership total includes extras
    const ballRuns = (ball.runs_off_bat || 0) + (ball.extra_runs || 0);
    cur.runs += ballRuns;

    // balls: wides don't count
    const countsBall = ball.extra_type !== "wide";
    if (countsBall) cur.balls += 1;

    // individual contribution
    const strikerIsA = ball.striker_id === cur.a;
    const batRuns = ball.runs_off_bat || 0;
    if (strikerIsA) {
      cur.aRuns += batRuns;
      if (countsBall) cur.aBalls += 1;
    } else {
      cur.bRuns += batRuns;
      if (countsBall) cur.bBalls += 1;
    }

    // wicket ends partnership if the striker is out (simple model)
    if (ball.wicket) {
      addCurrent(cur);
      cur = null;
    }
  }

  // current partnership (if any)
  addCurrent(cur);

  const named = res.map((p) => ({
    ...p,
    aName: playerName(p.a),
    bName: playerName(p.b),
  }));

  return {
    all: named,
    current: named.length ? named[named.length - 1] : null,
  };
}

function WormGraph({ seriesA, seriesB, labelA, labelB }) {
  const w = 620;
  const h = 220;
  const pad = 34;

  const maxX = Math.max(
    seriesA?.length ? seriesA[seriesA.length - 1].x : 0,
    seriesB?.length ? seriesB[seriesB.length - 1].x : 0,
    1
  );
  const maxY = Math.max(
    ...[...(seriesA || []), ...(seriesB || [])].map((p) => p.y),
    10
  );

  const sx = (x) => pad + (x / maxX) * (w - pad * 2);
  const sy = (y) => h - pad - (y / maxY) * (h - pad * 2);

  const pathFor = (s) => {
    if (!s || !s.length) return "";
    return s
      .map((p, i) => `${i === 0 ? "M" : "L"}${sx(p.x).toFixed(2)},${sy(p.y).toFixed(2)}`)
      .join(" ");
  };

  const yTicks = 4;
  const xTicks = 4;

  return (
    <div style={{ width: "100%", overflowX: "auto" }}>
      <svg viewBox={`0 0 ${w} ${h}`} style={{ width: "100%", maxWidth: w, display: "block" }}>
        {/* grid */}
        {Array.from({ length: yTicks + 1 }).map((_, i) => {
          const y = pad + ((h - pad * 2) * i) / yTicks;
          const val = Math.round(maxY - (maxY * i) / yTicks);
          return (
            <g key={`y-${i}`}>
              <line x1={pad} y1={y} x2={w - pad} y2={y} stroke="#e8e8e8" strokeWidth="1" />
              <text x={6} y={y + 4} fontSize="10" fill="#777">{val}</text>
            </g>
          );
        })}
        {Array.from({ length: xTicks + 1 }).map((_, i) => {
          const x = pad + ((w - pad * 2) * i) / xTicks;
          const val = (maxX * i) / xTicks;
          return (
            <g key={`x-${i}`}>
              <line x1={x} y1={pad} x2={x} y2={h - pad} stroke="#f0f0f0" strokeWidth="1" />
              <text x={x - 6} y={h - 10} fontSize="10" fill="#777">{val.toFixed(0)}</text>
            </g>
          );
        })}

        {/* axes */}
        <line x1={pad} y1={pad} x2={pad} y2={h - pad} stroke="#bbb" strokeWidth="1" />
        <line x1={pad} y1={h - pad} x2={w - pad} y2={h - pad} stroke="#bbb" strokeWidth="1" />

        {/* series */}
        {seriesA?.length ? <path d={pathFor(seriesA)} fill="none" stroke="#d32f2f" strokeWidth="2.5" /> : null}
        {seriesB?.length ? <path d={pathFor(seriesB)} fill="none" stroke="#444" strokeWidth="2.5" /> : null}

        {/* legend */}
        <g>
          <circle cx={pad + 6} cy={14} r={5} fill="#d32f2f" />
          <text x={pad + 18} y={18} fontSize="12" fill="#333">{labelA}</text>
          <rect x={pad + 120} y={9} width={10} height={10} fill="#444" />
          <text x={pad + 136} y={18} fontSize="12" fill="#333">{labelB}</text>
        </g>
      </svg>
    </div>
  );
}

/* Batting order (IDs) for a single innings */
function battingOrderFromBalls(balls, strikerId, nonStrikerId) {
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
}

/* Bowling overview aggregation (single innings) */
function buildBowlingOverviewRows({ balls, bowlingPlayers, playerName }) {
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
    s.runs += (b.runs_off_bat || 0) + ((b.extra_type === "bye" || b.extra_type === "legbye") ? 0 : (b.extra_runs || 0));
    if (b.wicket) s.wickets += 1;

    const overNo = toInt(b.over_no, 0);
    if (!s.perOver.has(overNo)) s.perOver.set(overNo, { deliveries: 0, legal: 0, runs: 0 });
    const o = s.perOver.get(overNo);
    o.deliveries += 1;
    if (b.legal_ball) o.legal += 1;
    o.runs += (b.runs_off_bat || 0) + ((b.extra_type === "bye" || b.extra_type === "legbye") ? 0 : (b.extra_runs || 0));
  });

  const rows = [];

  // show bowlers that have bowled; optionally could show all bowlingPlayers
  bowlingPlayers.forEach((p) => {
    const s = byBowler.get(p.id);
    if (!s) return;

    let maidens = 0;
    s.perOver.forEach((o) => {
      const finished = o.legal >= 6 || o.deliveries >= 7;
      if (finished && o.runs === 0) maidens += 1;
    });

    const oversFull = Math.floor(s.legalBalls / 6);
    const ballsIn = s.legalBalls % 6;
    const oversText = `${oversFull}.${ballsIn}`;
    const oversAsFloat = s.legalBalls / 6;
    const econ = oversAsFloat > 0 ? (s.runs / oversAsFloat).toFixed(2) : "0.00";

    rows.push({
      id: p.id,
      name: playerName(p.id),
      oversText,
      maidens,
      runs: s.runs,
      wickets: s.wickets,
      econ,
    });
  });

  rows.sort((a, b) => {
    if (b.wickets !== a.wickets) return b.wickets - a.wickets;
    return Number(a.econ) - Number(b.econ);
  });

  return rows;
}

/* ---------------- Component ---------------- */

export default function MatchView() {
  const { matchId } = useParams();

  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  const [match, setMatch] = useState(null);
  const [teams, setTeams] = useState([]);
  const [players, setPlayers] = useState([]);

  const [innings, setInnings] = useState([]); // both innings rows
  const [balls, setBalls] = useState([]);     // all balls for match

  const [activeTab, setActiveTab] = useState("scorecard"); // scorecard | partnerships | worm

  // maps
  const teamById = useMemo(() => new Map(teams.map((t) => [t.id, t])), [teams]);
  const playerById = useMemo(() => new Map(players.map((p) => [p.id, p])), [players]);

  const playerName = (id) => playerById.get(id)?.name || "—";

  const ballsByInnings = useMemo(() => groupBy(balls, (b) => b.innings_id), [balls]);

  // Load match + innings + balls + teams/players
  useEffect(() => {
    let channel;

    (async () => {
      setLoading(true);
      setErr("");

      // Match
      const m = await supabase.from("matches").select("*").eq("id", matchId).single();
      if (m.error) {
        setErr(m.error.message);
        setLoading(false);
        return;
      }
      setMatch(m.data);

      // Teams (for names)
      const t = await supabase.from("teams").select("*").in("id", [m.data.team_a_id, m.data.team_b_id]);
      if (t.error) {
        setErr(t.error.message);
        setLoading(false);
        return;
      }
      setTeams(t.data || []);

      // Players (for names + scorecards)
      // Fetch ALL players for both teams (active or not) so names always resolve.
      const p = await supabase.from("players").select("*").in("team_id", [m.data.team_a_id, m.data.team_b_id]).order("name");
      if (p.error) {
        setErr(p.error.message);
        setLoading(false);
        return;
      }
      setPlayers(p.data || []);

      // Innings
      const inn = await supabase.from("innings").select("*").eq("match_id", matchId).order("innings_no", { ascending: true });
      if (inn.error) {
        setErr(inn.error.message);
        setLoading(false);
        return;
      }
      setInnings(inn.data || []);

      // Balls (ALL) for match
      const b = await supabase
        .from("balls")
        .select("*")
        .eq("match_id", matchId)
        .order("over_no", { ascending: true })
        .order("delivery_in_over", { ascending: true });

      if (b.error) {
        setErr(b.error.message);
        setLoading(false);
        return;
      }
      setBalls(sortBallsCricketOrder(b.data || []));

      // Live subscribe on match balls
      channel = supabase
        .channel(`balls-live-${matchId}`)
        .on(
          "postgres_changes",
          { event: "INSERT", schema: "public", table: "balls", filter: `match_id=eq.${matchId}` },
          (payload) => {
            setBalls((prev) => {
              if (prev.some((x) => x.id === payload.new.id)) return prev;
              return sortBallsCricketOrder([...prev, payload.new]);
            });
          }
        )
        .subscribe();

      setLoading(false);
    })();

    return () => {
      if (channel) supabase.removeChannel(channel);
    };
  }, [matchId]);

  const oversLimit = useMemo(() => {
    const v = toInt(match?.overs_limit, 20);
    return v > 0 ? v : 20;
  }, [match]);

  // Build per-innings view models (innings 1 + innings 2)
  const inningsViews = useMemo(() => {
    if (!match) return [];

    // Ensure we always render two innings boxes if you want
    const inn1 = innings.find((x) => x.innings_no === 1) || null;
    const inn2 = innings.find((x) => x.innings_no === 2) || null;
    const list = [inn1, inn2].filter(Boolean);

    return list.map((inn) => {
      const innBalls = ballsByInnings.get(inn.id) || [];
      const runs = sumRuns(innBalls);
      const wkts = sumWkts(innBalls);
      const legal = countLegalBalls(innBalls);
      const overs = oversTextFromLegal(legal);
      const crr = legal > 0 ? (runs / (legal / 6)).toFixed(2) : "0.00";

      // last known players on field (from last ball of that innings)
      const last = innBalls.length ? innBalls[innBalls.length - 1] : null;
      const strikerId = last?.striker_id || "";
      const nonStrikerId = last?.non_striker_id || "";
      const bowlerId = last?.bowler_id || "";

      // out set (basic: striker_id marked out when wicket=true)
      const outSet = new Set();
      innBalls.forEach((b) => {
        if (b.wicket && b.striker_id) outSet.add(b.striker_id);
      });

      // batting team + bowling team players
      const battingPlayers = players.filter((p) => p.team_id === inn.batting_team_id);
      const bowlingPlayers = players.filter((p) => p.team_id === inn.bowling_team_id);

      // Batting scorecard
      const orderIds = battingOrderFromBalls(innBalls, strikerId, nonStrikerId);

      const battingRows = orderIds
        .map((id) => {
          const p = playerById.get(id);
          if (!p) return null;

          const facedAsStriker = innBalls.filter((b) => b.striker_id === id);
          const ballsFaced = facedAsStriker.filter((b) => b.extra_type !== "wide").length;
          const batRuns = facedAsStriker.reduce((acc, b) => acc + (b.runs_off_bat || 0), 0);
          const fours = facedAsStriker.filter((b) => (b.runs_off_bat || 0) === 4).length;
          const sixes = facedAsStriker.filter((b) => (b.runs_off_bat || 0) === 6).length;
          const sr = ballsFaced > 0 ? ((batRuns / ballsFaced) * 100).toFixed(1) : "0.0";

          const isAtCrease = id === strikerId || id === nonStrikerId;
          const isOut = outSet.has(id);

          return {
            id,
            name: p.name,
            runs: batRuns,
            balls: ballsFaced,
            fours,
            sixes,
            sr,
            isAtCrease,
            isOut,
          };
        })
        .filter(Boolean)
        .filter((r) => r.isAtCrease || r.balls > 0);

      // Bowling overview
      const bowlingRows = buildBowlingOverviewRows({
        balls: innBalls,
        bowlingPlayers,
        playerName,
      });

      return {
        innings: inn,
        balls: innBalls,
        runs,
        wkts,
        legal,
        overs,
        crr,
        strikerId,
        nonStrikerId,
        bowlerId,
        battingPlayers,
        bowlingPlayers,
        battingRows,
        bowlingRows,
      };
    });
  }, [match, innings, ballsByInnings, players, playerById]);

  // Target info (innings 2 only)
  const inn1View = inningsViews.find((v) => v.innings.innings_no === 1) || null;
  const inn2View = inningsViews.find((v) => v.innings.innings_no === 2) || null;

  const worm = useMemo(() => {
    const s1 = inn1View ? buildWormSeries(inn1View.balls) : [];
    const s2 = inn2View ? buildWormSeries(inn2View.balls) : [];
    return { s1, s2 };
  }, [inn1View, inn2View]);

  const partnerships = useMemo(() => {
    // Prefer the current (latest) innings for partnerships display
    const latest = inn2View || inn1View;
    if (!latest) return { current: null, all: [], teamName: "" };
    const teamName = teamById.get(latest.innings.batting_team_id)?.name || "";
    const p = buildPartnerships(latest.balls, playerName);
    return { ...p, teamName };
  }, [inn1View, inn2View, teamById, playerName]);

  const target = useMemo(() => {
    if (!inn1View) return null;
    return inn1View.runs + 1;
  }, [inn1View]);

  const inn2Need = useMemo(() => {
    if (!inn2View || target == null) return null;
    const maxLegal = oversLimit * 6;
    const ballsRemaining = Math.max(0, maxLegal - inn2View.legal);
    const runsRemaining = Math.max(0, target - inn2View.runs);
    const rrr =
      ballsRemaining <= 0 ? (runsRemaining > 0 ? "∞" : "0.00") : (runsRemaining / (ballsRemaining / 6)).toFixed(2);

    return { ballsRemaining, runsRemaining, rrr };
  }, [inn2View, target, oversLimit]);

  const latestView = useMemo(() => {
    if (inn2View && inn2View.balls.length) return inn2View;
    if (inn2View && (inn1View?.innings?.completed || inn1View?.balls?.length)) return inn2View;
    return inn1View;
  }, [inn1View, inn2View]);

  const lastFiveOversBalls = useMemo(() => {
    const list = latestView?.balls || [];
    if (!list.length) return [];
    const maxOver = toInt(list[list.length - 1]?.over_no, 0);
    const minOver = Math.max(0, maxOver - 4);
    return list.filter((b) => toInt(b.over_no, 0) >= minOver);
  }, [latestView]);

  const ballStyle = (b) => {
    // Colours requested: 4 blue, 6 green, wicket maroon
    if (b.wicket) return { background: "#c7003f", color: "#fff" };
    if ((b.runs_off_bat || 0) === 4) return { background: "#15dbf9", color: "#06202a" };
    if ((b.runs_off_bat || 0) === 6) return { background: "#24d657", color: "#06210e" };
    return { background: "rgba(255,255,255,0.08)", color: "#e8eefc", border: "1px solid rgba(255,255,255,0.10)" };
  };

  if (loading) return <div>Loading…</div>;

  const teamAName = match ? teamById.get(match.team_a_id)?.name || "Team A" : "Team A";
  const teamBName = match ? teamById.get(match.team_b_id)?.name || "Team B" : "Team B";

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Match Centre</h2>

      {err && <div style={{ color: "crimson", marginTop: 10 }}>{err}</div>}

      {match ? (
        <div style={{ marginTop: 8, color: "#666" }}>
          <div>
            <b>{teamAName}</b> vs <b>{teamBName}</b>
          </div>
          <div>
            Status: <b>{match.status}</b> · Overs limit: <b>{oversLimit}</b>
          </div>
        </div>
      ) : null}

      {/* Main scoreboard + tabs */}
      <div style={{ marginTop: 14, display: "grid", gap: 12, maxWidth: 980 }}>
        {latestView ? (
          <div style={{ padding: 14, borderRadius: 16, border: "1px solid rgba(255,255,255,0.10)", background: "rgba(8, 15, 30, 0.92)", color: "#e8eefc" }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
              <div>
                <div style={{ fontWeight: 900, fontSize: 16 }}>
                  Innings {latestView.innings.innings_no}: {teamById.get(latestView.innings.batting_team_id)?.name || "Batting"}
                </div>
                <div style={{ color: "rgba(232,238,252,0.70)", marginTop: 4 }}>
                  Bowling: <b>{teamById.get(latestView.innings.bowling_team_id)?.name || "Bowling"}</b>
                </div>
              </div>

              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 30, fontWeight: 900 }}>
                  {latestView.runs}/{latestView.wkts}{" "}
                  <span style={{ fontSize: 14, fontWeight: 700, color: "rgba(232,238,252,0.70)" }}>({latestView.overs} ov)</span>
                </div>
                <div style={{ marginTop: 2, color: "rgba(232,238,252,0.70)" }}>CRR <b style={{ color: "#e8eefc" }}>{latestView.crr}</b></div>
              </div>
            </div>

            {/* Ball-by-ball (last 5 overs) */}
            <div style={{ marginTop: 12 }}>
              <div style={{ fontWeight: 900, marginBottom: 8 }}>Ball-by-ball</div>
              {!lastFiveOversBalls.length ? (
                <div style={{ color: "rgba(232,238,252,0.65)" }}>No balls yet.</div>
              ) : (
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {lastFiveOversBalls
                    .slice()
                    .reverse()
                    .map((b) => {
                      const val = b.wicket ? "W" : (b.runs_off_bat ?? 0);
                      const st = ballStyle(b);
                      return (
                        <div
                          key={b.id}
                          title={`${b.over_no}.${b.delivery_in_over}`}
                          style={{
                            width: 42,
                            height: 42,
                            borderRadius: 10,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            fontWeight: 900,
                            ...st,
                          }}
                        >
                          {val}
                        </div>
                      );
                    })}
                </div>
              )}
            </div>

            {/* Tabs */}
            <div style={{ marginTop: 14, display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button onClick={() => setActiveTab("scorecard")} style={tabBtn(activeTab === "scorecard")}>Scorecard</button>
              <button onClick={() => setActiveTab("partnerships")} style={tabBtn(activeTab === "partnerships")}>Partnerships</button>
              <button onClick={() => setActiveTab("worm")} style={tabBtn(activeTab === "worm")}>Worm</button>
            </div>
          </div>
        ) : null}

        {activeTab === "scorecard" ? (
          inningsViews.length === 0 ? (
          <div style={{ color: "#666" }}>No innings yet.</div>
          ) : (
            inningsViews.map((v) => {
            const innNo = v.innings.innings_no;
            const battingTeamName = teamById.get(v.innings.batting_team_id)?.name || `Batting team`;
            const bowlingTeamName = teamById.get(v.innings.bowling_team_id)?.name || `Bowling team`;

            return (
              <div key={v.innings.id} style={{ border: "1px solid #ddd", borderRadius: 12, padding: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                  <div>
                    <div style={{ fontWeight: 900, fontSize: 16 }}>
                      Innings {innNo}: <span>{battingTeamName}</span>
                    </div>
                    <div style={{ color: "#666", marginTop: 4 }}>
                      Bowling: <b>{bowlingTeamName}</b>
                    </div>
                  </div>

                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontSize: 22, fontWeight: 900 }}>
                      {v.runs}/{v.wkts}{" "}
                      <span style={{ fontSize: 14, fontWeight: 600, color: "#666" }}>
                        ({v.overs} ov)
                      </span>
                    </div>
                    <div style={{ marginTop: 4, color: "#666" }}>
                      CRR: <b>{v.crr}</b>
                    </div>
                  </div>
                </div>

                {/* Target / RRR box for innings 2 */}
                {innNo === 2 && target != null && inn2Need ? (
                  <div style={{ marginTop: 10, padding: 10, border: "1px solid #eee", borderRadius: 10, color: "#555" }}>
                    Target: <b>{target}</b> · Need: <b>{inn2Need.runsRemaining}</b> runs from{" "}
                    <b>{inn2Need.ballsRemaining}</b> balls · RRR: <b>{inn2Need.rrr}</b>
                  </div>
                ) : null}

                {/* At crease */}
                <div style={{ marginTop: 10, color: "#666" }}>
                  Batting: <b>{playerName(v.strikerId)}</b> ⭐ / <b>{playerName(v.nonStrikerId)}</b> ·
                  Bowler: <b>{playerName(v.bowlerId)}</b>
                </div>

                {/* Batting scorecard */}
                <details open style={{ marginTop: 12, borderTop: "1px solid #eee", paddingTop: 12 }}>
                  <summary style={{ cursor: "pointer", fontWeight: 800, listStyle: "none" }}>Batting scorecard</summary>

                  {!v.battingRows.length ? (
                    <div style={{ color: "#666", marginTop: 8 }}>No batting yet.</div>
                  ) : (
                    <div style={{ overflowX: "auto", marginTop: 8 }}>
                      <table style={{ width: "100%", borderCollapse: "collapse" }}>
                        <thead>
                          <tr>
                            <th style={th}>Batter</th>
                            <th style={thRight}>R</th>
                            <th style={thRight}>B</th>
                            <th style={thRight}>4s</th>
                            <th style={thRight}>6s</th>
                            <th style={thRight}>SR</th>
                            <th style={thRight}>Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {v.battingRows.map((r) => (
                            <tr key={r.id}>
                              <td style={td}>
                                <b>{r.name}</b> {r.id === v.strikerId ? <span style={{ color: "#666" }}>⭐</span> : null}
                              </td>
                              <td style={tdRight}><b>{r.runs}</b></td>
                              <td style={tdRight}>{r.balls}</td>
                              <td style={tdRight}>{r.fours}</td>
                              <td style={tdRight}>{r.sixes}</td>
                              <td style={tdRight}>{r.sr}</td>
                              <td style={tdRight}>
                                {r.isAtCrease ? (
                                  <span style={{ color: "green", fontWeight: 700 }}>Not out</span>
                                ) : r.isOut ? (
                                  <span style={{ color: "crimson", fontWeight: 700 }}>Out</span>
                                ) : (
                                  <span style={{ color: "#666" }}>—</span>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </details>

                {/* Bowling overview */}
                <details open style={{ marginTop: 12, borderTop: "1px solid #eee", paddingTop: 12 }}>
                  <summary style={{ cursor: "pointer", fontWeight: 800, listStyle: "none" }}>Bowling overview</summary>

                  {!v.bowlingRows.length ? (
                    <div style={{ color: "#666", marginTop: 8 }}>No bowling yet.</div>
                  ) : (
                    <div style={{ overflowX: "auto", marginTop: 8 }}>
                      <table style={{ width: "100%", borderCollapse: "collapse" }}>
                        <thead>
                          <tr>
                            <th style={th}>Bowler</th>
                            <th style={thRight}>O</th>
                            <th style={thRight}>M</th>
                            <th style={thRight}>R</th>
                            <th style={thRight}>W</th>
                            <th style={thRight}>Econ</th>
                          </tr>
                        </thead>
                        <tbody>
                          {v.bowlingRows.map((r) => (
                            <tr key={r.id}>
                              <td style={td}><b>{r.name}</b></td>
                              <td style={tdRight}>{r.oversText}</td>
                              <td style={tdRight}>{r.maidens}</td>
                              <td style={tdRight}>{r.runs}</td>
                              <td style={tdRight}><b>{r.wickets}</b></td>
                              <td style={tdRight}>{r.econ}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </details>

                {/* Ball-by-ball (last 30 for that innings) */}
                <details style={{ marginTop: 12, borderTop: "1px solid #eee", paddingTop: 12 }}>
                  <summary style={{ cursor: "pointer", fontWeight: 800, listStyle: "none" }}>Ball-by-ball</summary>
                  {!v.balls.length ? (
                    <div style={{ color: "#666", marginTop: 8 }}>No balls yet.</div>
                  ) : (
                    <ol style={{ marginTop: 8 }}>
                      {v.balls.slice(-30).map((b) => (
                        <li key={b.id}>
                          Over {toInt(b.over_no, 0) + 1}.{toInt(b.delivery_in_over, 0)} —{" "}
                          {b.extra_type ? `Extra: ${b.extra_type} (+${b.extra_runs || 0})` : `Bat: ${b.runs_off_bat || 0}`}
                          {!b.legal_ball ? " (not legal)" : ""}
                          {b.wicket ? " — WICKET" : ""}
                        </li>
                      ))}
                    </ol>
                  )}
                </details>
              </div>
            );
            })
          )
        ) : null}

        {activeTab === "partnerships" ? (
          <div style={{ ...cardDetails }}>
            <div style={summaryRow}>
              <span>Partnerships</span>
              <span style={{ color: "#777", fontWeight: 600, fontSize: 12 }}>{partnerships.teamName || ""}</span>
            </div>
            {!partnerships.current ? (
              <div style={{ marginTop: 10, color: "#666" }}>No partnerships yet.</div>
            ) : (
              <div style={{ marginTop: 12 }}>
                <div style={partnerRow}>
                  <div style={{ minWidth: 170 }}>
                    <div style={{ fontWeight: 800 }}>{partnerships.current.aName}</div>
                    <div style={{ color: "#666" }}>{partnerships.current.aRuns} ({partnerships.current.aBalls})</div>
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 900 }}>
                      <div>{partnerships.current.runs} ({partnerships.current.balls})</div>
                      <div style={{ color: "#666", fontWeight: 700 }}>Current</div>
                    </div>
                    <div style={partnerBarWrap}>
                      <div
                        style={{
                          height: 10,
                          width: `${Math.min(100, Math.max(4, (partnerships.current.runs / Math.max(1, partnerships.current.runs + 10)) * 100))}%`,
                          background: "#d32f2f",
                          borderRadius: 99,
                        }}
                      />
                    </div>
                  </div>
                  <div style={{ minWidth: 170, textAlign: "right" }}>
                    <div style={{ fontWeight: 800 }}>{partnerships.current.bName}</div>
                    <div style={{ color: "#666" }}>{partnerships.current.bRuns} ({partnerships.current.bBalls})</div>
                  </div>
                </div>

                <div style={{ marginTop: 12, color: "#888", fontWeight: 800 }}>All partnerships</div>
                <div style={{ marginTop: 8, display: "grid", gap: 8 }}>
                  {partnerships.all
                    .slice()
                    .reverse()
                    .map((p, idx) => (
                      <div
                        key={idx}
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          gap: 12,
                          padding: "10px 12px",
                          border: "1px solid #eee",
                          borderRadius: 12,
                          background: "white",
                        }}
                      >
                        <div style={{ fontWeight: 800 }}>{p.aName} &amp; {p.bName}</div>
                        <div style={{ fontWeight: 900 }}>{p.runs} ({p.balls})</div>
                      </div>
                    ))}
                </div>
              </div>
            )}
          </div>
        ) : null}

        {activeTab === "worm" ? (
          worm.s1.length || worm.s2.length ? (
            <div style={{ ...cardDetails }}>
              <div style={summaryRow}>
                <span>Worm graph</span>
                <span style={{ color: "#777", fontWeight: 600, fontSize: 12 }}>Scoring comparison</span>
              </div>
              <div style={{ marginTop: 10 }}>
                <WormGraph
                  seriesA={worm.s1}
                  seriesB={worm.s2}
                  labelA={inn1View ? (teamById.get(inn1View.innings.batting_team_id)?.name || "Innings 1") : "Innings 1"}
                  labelB={inn2View ? (teamById.get(inn2View.innings.batting_team_id)?.name || "Innings 2") : "Innings 2"}
                />
              </div>
            </div>
          ) : (
            <div style={{ color: "#666" }}>No worm data yet.</div>
          )
        ) : null}
      </div>
    </div>
  );
}

function tabBtn(active) {
  return {
    padding: "10px 12px",
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,0.14)",
    background: active ? "rgba(255,255,255,0.14)" : "rgba(255,255,255,0.06)",
    color: "#e8eefc",
    fontWeight: 900,
    cursor: "pointer",
  };
}

/* ---------------- Styles ---------------- */

const th = {
  textAlign: "left",
  padding: "8px 8px",
  borderBottom: "1px solid #eee",
  color: "#666",
  fontSize: 12,
  fontWeight: 800,
  whiteSpace: "nowrap",
};

const thRight = { ...th, textAlign: "right" };

const td = {
  padding: "8px 8px",
  borderBottom: "1px solid #f2f2f2",
  fontSize: 14,
  whiteSpace: "nowrap",
};

const tdRight = { ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" };

const cardDetails = {
  background: "#fff",
  border: "1px solid #eee",
  borderRadius: 16,
  padding: 12,
  boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
};

const summaryRow = {
  cursor: "pointer",
  listStyle: "none",
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  gap: 12,
  fontWeight: 900,
  fontSize: 18,
};

const partnerRow = {
  display: "flex",
  alignItems: "center",
  gap: 12,
};

const partnerBarWrap = {
  marginTop: 8,
  height: 10,
  background: "#f3f3f3",
  borderRadius: 99,
  overflow: "hidden",
};
