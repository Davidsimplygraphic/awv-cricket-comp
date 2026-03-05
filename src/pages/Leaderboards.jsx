import { useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabase";

/**
 * Leaderboards
 * 1) Team standings (points + W/L/T + runs for/against + NRR)
 * 2) Batting leaderboard (total runs_off_bat across all COMPLETED matches)
 * 3) Bowling leaderboard (total wickets across all COMPLETED matches)
 *
 * DATA MODEL (current / correct):
 * - ONE row in public.matches per match.
 * - TWO rows in public.innings per match (innings_no 1 and 2).
 * - Balls are linked to innings via balls.innings_id (and also carry match_id).
 *
 * INCLUDED MATCHES:
 * - Only matches where matches.status = "completed" are included.
 *
 * RESULT POINTS:
 * - Win = 4
 * - Tie = 2
 * - Loss = 0
 *
 * BONUS POINTS:
 * - Bat 100+ = +2, Bat 50–99 = +1 (per innings)
 * - Bowl 5W+ = +2, Bowl 3–4W = +1 (per innings)
 *
 * BAT TWICE RULE (per innings):
 * - If a player bats again after being OUT in the SAME innings, later runs are ignored.
 * - Only the first dismissal per innings counts.
 */

function toInt(n, fallback = 0) {
  const x = Number(n);
  return Number.isFinite(x) ? x : fallback;
}

function safeDiv(a, b) {
  if (!b) return 0;
  return a / b;
}

function fmt(num, digits = 2) {
  if (!Number.isFinite(num)) return "0.00";
  return num.toFixed(digits);
}

function sumRuns(balls) {
  return (balls || []).reduce((acc, b) => acc + toInt(b.runs_off_bat, 0) + toInt(b.extra_runs, 0), 0);
}

function sumWkts(balls) {
  return (balls || []).reduce((acc, b) => acc + (b.wicket ? 1 : 0), 0);
}

function countLegal(balls) {
  // Treat NULL as legal (legacy rows); only explicit false is illegal
  return (balls || []).reduce((acc, b) => acc + (b?.legal_ball !== false ? 1 : 0), 0);
}

function oversTextFromLegal(legalBalls) {
  const lb = toInt(legalBalls, 0);
  const overs = Math.floor(lb / 6);
  const ballsInOver = lb % 6;
  return `${overs}.${ballsInOver}`;
}

function getDismissedBatterId(ball) {
  if (!ball?.wicket) return null;
  return ball.dismissed_player_id || null;
}

function computeBatTwiceRunsByPlayer(balls) {
  const countedRunsByPlayer = new Map();
  // key = `${inningsId}:${playerId}` (dismissed once per innings)
  const dismissedInInnings = new Set();

  for (const b of balls || []) {
    const inningsId = b.innings_id || null;
    const strikerId = b.striker_id || null;
    if (!inningsId || !strikerId) continue;

    // If already dismissed in this innings, ignore later runs
    const key = `${inningsId}:${strikerId}`;
    if (!dismissedInInnings.has(key)) {
      // count bat runs (ignore wides for "balls faced" but runs_off_bat is already 0 on wides in this app)
      countedRunsByPlayer.set(strikerId, (countedRunsByPlayer.get(strikerId) || 0) + toInt(b.runs_off_bat, 0));
    }

    const outId = getDismissedBatterId(b);
    if (outId) {
      const outKey = `${inningsId}:${outId}`;
      if (!dismissedInInnings.has(outKey)) dismissedInInnings.add(outKey);
    }
  }

  return countedRunsByPlayer;
}

function computeWktsByBowlerPerInnings(balls) {
  // key = `${inningsId}:${bowlerId}`
  const m = new Map();
  for (const b of balls || []) {
    if (!b.wicket) continue;
    const inningsId = b.innings_id || null;
    const bowlerId = b.bowler_id || null;
    if (!inningsId || !bowlerId) continue;
    const key = `${inningsId}:${bowlerId}`;
    m.set(key, (m.get(key) || 0) + 1);
  }
  return m;
}

export default function Leaderboards() {
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  const [teams, setTeams] = useState([]);
  const [players, setPlayers] = useState([]);

  const [matches, setMatches] = useState([]);
  const [innings, setInnings] = useState([]);
  const [balls, setBalls] = useState([]);

  useEffect(() => {
    let alive = true;

    (async () => {
      setLoading(true);
      setErr("");

      const t = await supabase.from("teams").select("id,name,short_name").order("name", { ascending: true });
      if (!alive) return;
      if (t.error) {
        setErr(`Teams load failed: ${t.error.message}`);
        setLoading(false);
        return;
      }
      setTeams(t.data || []);

      const p = await supabase.from("players").select("id,name,team_id,active").order("name", { ascending: true });
      if (!alive) return;
      if (p.error) {
        setErr(`Players load failed: ${p.error.message}`);
        setLoading(false);
        return;
      }
      setPlayers(p.data || []);

      // IMPORTANT: don't trust matches.status alone.
      // Some scorer flows can finish both innings without persisting matches.status = "completed".
      // We load all matches and then decide completion based on innings + balls.
      const m = await supabase
        .from("matches")
        .select("id,fixture_id,team_a_id,team_b_id,overs_limit,wicket_cap,status");
      if (!alive) return;
      if (m.error) {
        setErr(`Matches load failed: ${m.error.message}`);
        setLoading(false);
        return;
      }
      const matchRows = m.data || [];
      setMatches(matchRows);

      const matchIds = matchRows.map((x) => x.id).filter(Boolean);

      if (!matchIds.length) {
        setInnings([]);
        setBalls([]);
        setLoading(false);
        return;
      }

      const inn = await supabase
        .from("innings")
        .select("id,match_id,innings_no,batting_team_id,bowling_team_id,completed")
        .in("match_id", matchIds);

      if (!alive) return;
      if (inn.error) {
        setErr(`Innings load failed: ${inn.error.message}`);
        setLoading(false);
        return;
      }
      setInnings(inn.data || []);

      const b = await supabase
        .from("balls")
        .select(
          "match_id,innings_id,striker_id,bowler_id,runs_off_bat,extra_runs,extra_type,legal_ball,wicket,dismissed_player_id"
        )
        .in("match_id", matchIds);

      if (!alive) return;
      if (b.error) {
        setErr(`Balls load failed: ${b.error.message}`);
        setLoading(false);
        return;
      }
      setBalls(b.data || []);
      setLoading(false);
    })();

    return () => {
      alive = false;
    };
  }, []);

  const teamById = useMemo(() => {
    const m = new Map();
    for (const t of teams || []) m.set(t.id, t);
    return m;
  }, [teams]);

  const playerById = useMemo(() => {
    const m = new Map();
    for (const p of players || []) m.set(p.id, p);
    return m;
  }, [players]);

  const inningsByMatch = useMemo(() => {
    const m = new Map(); // matchId -> {1: innings, 2: innings}
    for (const inn of innings || []) {
      const mid = inn.match_id;
      if (!mid) continue;
      if (!m.has(mid)) m.set(mid, {});
      const ino = Number(inn.innings_no);
      if (ino === 1 || ino === 2) m.get(mid)[ino] = inn;
    }
    return m;
  }, [innings]);

  const ballsByInnings = useMemo(() => {
    const m = new Map();
    for (const b of balls || []) {
      const iid = b.innings_id;
      if (!iid) continue;
      if (!m.has(iid)) m.set(iid, []);
      m.get(iid).push(b);
    }
    return m;
  }, [balls]);

  const completedMatchIds = useMemo(() => {
    const set = new Set();

    for (const match of matches || []) {
      const mid = match.id;
      if (!mid) continue;
      const innObj = inningsByMatch.get(mid) || {};
      const inn1 = innObj[1] || null;
      const inn2 = innObj[2] || null;
      if (!inn1 || !inn2) continue;

      const b1 = ballsByInnings.get(inn1.id) || [];
      const b2 = ballsByInnings.get(inn2.id) || [];

      const raw = String(match.status || "").toLowerCase();
      if (raw === "completed") {
        set.add(mid);
        continue;
      }

      // Require both innings to have started (or be marked completed)
      const hasI1 = b1.length > 0 || !!inn1.completed;
      const hasI2 = b2.length > 0 || !!inn2.completed;
      if (!hasI1 || !hasI2) continue;

      const oversLimit = toInt(match.overs_limit, 20);
      const wicketCap = toInt(match.wicket_cap, 10);
      const maxLegal = oversLimit * 6;

      const i1Runs = sumRuns(b1);
      const i2Runs = sumRuns(b2);
      const i2Legal = countLegal(b2);
      const i2Wkts = sumWkts(b2);

      // Chase is complete once innings 2 reaches the target (innings1 + 1)
      const chaseCompleted = i2Runs >= i1Runs + 1;
      const inn2Exhausted = i2Legal >= maxLegal || i2Wkts >= wicketCap || !!inn2.completed;

      if (chaseCompleted || inn2Exhausted) set.add(mid);
    }

    return set;
  }, [matches, inningsByMatch, ballsByInnings]);

  const completedBalls = useMemo(() => {
    if (!completedMatchIds.size) return [];
    return (balls || []).filter((b) => b?.match_id && completedMatchIds.has(b.match_id));
  }, [balls, completedMatchIds]);

  const standings = useMemo(() => {
    const base = new Map();
    for (const t of teams || []) {
      base.set(t.id, {
        teamId: t.id,
        teamName: t.name,
        teamShort: t.short_name || t.name,
        played: 0,
        won: 0,
        lost: 0,
        tied: 0,
        points: 0,
        bonus: 0,
        runsFor: 0,
        runsAgainst: 0,
        ballsFor: 0, // legal balls faced
        ballsAgainst: 0, // legal balls bowled
      });
    }

    const runsByPlayer = computeBatTwiceRunsByPlayer(completedBalls);
    const wktsByBowlerInnings = computeWktsByBowlerPerInnings(completedBalls);

    // Batting bonus: per innings, award to player's team
    // We'll derive per-player per-innings runs by re-walking balls with the same "bat twice" guard.
    const runsPerPlayerInnings = new Map(); // key `${inningsId}:${playerId}` -> runs
    const dismissedInInnings = new Set(); // same rule
    for (const b of completedBalls || []) {
      const inningsId = b.innings_id;
      const strikerId = b.striker_id;
      if (!inningsId || !strikerId) continue;

      const key = `${inningsId}:${strikerId}`;
      if (!dismissedInInnings.has(key)) {
        runsPerPlayerInnings.set(key, (runsPerPlayerInnings.get(key) || 0) + toInt(b.runs_off_bat, 0));
      }

      const outId = getDismissedBatterId(b);
      if (outId) {
        const outKey = `${inningsId}:${outId}`;
        if (!dismissedInInnings.has(outKey)) dismissedInInnings.add(outKey);
      }
    }

    // Apply batting bonuses
    for (const [key, runs] of runsPerPlayerInnings.entries()) {
      const playerId = key.split(":")[1];
      const pl = playerById.get(playerId);
      if (!pl?.team_id) continue;

      let bonus = 0;
      if (runs >= 100) bonus = 2;
      else if (runs >= 50) bonus = 1;

      if (bonus) {
        const row = base.get(pl.team_id);
        if (row) row.bonus += bonus;
      }
    }

    // Apply bowling bonuses (per innings)
    for (const [key, wkts] of wktsByBowlerInnings.entries()) {
      const bowlerId = key.split(":")[1];
      const pl = playerById.get(bowlerId);
      if (!pl?.team_id) continue;

      let bonus = 0;
      if (wkts >= 5) bonus = 2;
      else if (wkts >= 3) bonus = 1;

      if (bonus) {
        const row = base.get(pl.team_id);
        if (row) row.bonus += bonus;
      }
    }

    // Match results + NRR inputs
    for (const match of matches || []) {
      const mid = match.id;
      if (!completedMatchIds.has(mid)) continue;

      const innObj = inningsByMatch.get(mid) || {};
      const inn1 = innObj[1] || null;
      const inn2 = innObj[2] || null;
      if (!inn1 || !inn2) continue;

      const b1 = ballsByInnings.get(inn1.id) || [];
      const b2 = ballsByInnings.get(inn2.id) || [];

      const i1Runs = sumRuns(b1);
      const i2Runs = sumRuns(b2);

      const i1Legal = countLegal(b1);
      const i2Legal = countLegal(b2);

      // Teams: trust innings batting_team_id (match.team_a_id / team_b_id are not reliable for ordering)
      const teamAId = inn1.batting_team_id;
      const teamBId = inn2.batting_team_id;

      const rowA = base.get(teamAId);
      const rowB = base.get(teamBId);
      if (!rowA || !rowB) continue;

      rowA.played += 1;
      rowB.played += 1;

      // Runs / balls for NRR
      rowA.runsFor += i1Runs;
      rowA.ballsFor += i1Legal;
      rowA.runsAgainst += i2Runs;
      rowA.ballsAgainst += i2Legal;

      rowB.runsFor += i2Runs;
      rowB.ballsFor += i2Legal;
      rowB.runsAgainst += i1Runs;
      rowB.ballsAgainst += i1Legal;

      // Result
      if (i2Runs > i1Runs) {
        rowB.won += 1;
        rowA.lost += 1;
        rowB.points += 4;
      } else if (i1Runs > i2Runs) {
        rowA.won += 1;
        rowB.lost += 1;
        rowA.points += 4;
      } else {
        rowA.tied += 1;
        rowB.tied += 1;
        rowA.points += 2;
        rowB.points += 2;
      }
    }

    // Add bonuses into points
    for (const row of base.values()) row.points += row.bonus;

    // Compute NRR
    const out = [];
    for (const row of base.values()) {
      const oversFor = row.ballsFor / 6;
      const oversAgainst = row.ballsAgainst / 6;
      const nrr = safeDiv(row.runsFor, oversFor) - safeDiv(row.runsAgainst, oversAgainst);
      out.push({ ...row, nrr });
    }

    out.sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      if (b.won !== a.won) return b.won - a.won;
      return b.nrr - a.nrr;
    });

    return out;
  }, [teams, players, matches, inningsByMatch, ballsByInnings, completedBalls, completedMatchIds, playerById]);

  const battingRows = useMemo(() => {
    // Per-player batting across completed matches
    // Includes: Runs (bat-twice rule), Inns, Avg, SR

    const perPlayer = new Map(); // playerId -> { runs, balls, outs, innings:Set }
    const dismissedInInnings = new Set(); // `${inningsId}:${playerId}`

    for (const b of completedBalls || []) {
      const inningsId = b.innings_id;
      const strikerId = b.striker_id;

      if (inningsId && strikerId) {
        if (!perPlayer.has(strikerId)) perPlayer.set(strikerId, { runs: 0, balls: 0, outs: 0, innings: new Set() });
        const row = perPlayer.get(strikerId);
        row.innings.add(inningsId);

        const key = `${inningsId}:${strikerId}`;
        if (!dismissedInInnings.has(key)) {
          row.runs += toInt(b.runs_off_bat, 0);
          if (b?.legal_ball !== false) row.balls += 1;
        }
      }

      if (b.wicket) {
        const outId = getDismissedBatterId(b);
        const inningsId2 = b.innings_id;
        if (outId && inningsId2) {
          const outKey = `${inningsId2}:${outId}`;
          if (!dismissedInInnings.has(outKey)) {
            dismissedInInnings.add(outKey);
            if (!perPlayer.has(outId)) perPlayer.set(outId, { runs: 0, balls: 0, outs: 0, innings: new Set() });
            const row = perPlayer.get(outId);
            row.innings.add(inningsId2);
            row.outs += 1;
          }
        }
      }
    }

    const rows = [];
    for (const [playerId, s] of perPlayer.entries()) {
      const pl = playerById.get(playerId);
      if (!pl) continue;
      const inns = s.innings.size;
      const avg = s.outs > 0 ? s.runs / s.outs : s.runs;
      const sr = s.balls > 0 ? (s.runs / s.balls) * 100 : 0;

      rows.push({
        playerId,
        name: pl.name,
        teamId: pl.team_id,
        teamName: teamById.get(pl.team_id)?.name || "",
        runs: s.runs,
        inns,
        avg,
        sr,
      });
    }

    rows.sort((a, b) => b.runs - a.runs);
    return rows.slice(0, 50);
  }, [completedBalls, playerById, teamById]);

  const bowlingRows = useMemo(() => {
    // Per-player bowling across completed matches
    // Includes: Wkts, Overs, Matches, Econ

    const perPlayer = new Map(); // bowlerId -> { wkts, runs, legal, matches:Set }
    for (const b of completedBalls || []) {
      const bowlerId = b.bowler_id;
      if (!bowlerId) continue;
      if (!perPlayer.has(bowlerId)) perPlayer.set(bowlerId, { wkts: 0, runs: 0, legal: 0, matches: new Set() });
      const row = perPlayer.get(bowlerId);

      if (b.match_id) row.matches.add(b.match_id);
      row.runs += toInt(b.runs_off_bat, 0) + toInt(b.extra_runs, 0);
      if (b.wicket) row.wkts += 1;
      if (b?.legal_ball !== false) row.legal += 1;
    }

    const rows = [];
    for (const [playerId, s] of perPlayer.entries()) {
      const pl = playerById.get(playerId);
      if (!pl) continue;
      const overs = oversTextFromLegal(s.legal);
      const econ = s.legal ? s.runs / (s.legal / 6) : 0;
      rows.push({
        playerId,
        name: pl.name,
        teamId: pl.team_id,
        teamName: teamById.get(pl.team_id)?.name || "",
        wickets: s.wkts,
        overs,
        matches: s.matches.size,
        econ,
      });
    }

    rows.sort((a, b) => b.wickets - a.wickets);
    return rows.slice(0, 50);
  }, [completedBalls, playerById, teamById]);

  if (loading) {
    return (
      <div style={{ padding: 16 }}>
        <h1 style={{ margin: 0 }}>Leaderboards</h1>
        <div style={{ marginTop: 8, color: "#64748B" }}>Loading…</div>
      </div>
    );
  }

  return (
    <div style={{ padding: 16 }}>
      <h1 style={{ margin: 0 }}>Leaderboards</h1>

      {err ? (
        <div
          style={{
            marginTop: 12,
            padding: 10,
            borderRadius: 12,
            border: "1px solid rgba(220, 38, 38, 0.25)",
            background: "rgba(220, 38, 38, 0.06)",
            color: "#b91c1c",
            fontWeight: 700,
          }}
        >
          {err}
        </div>
      ) : null}

      <div style={{ marginTop: 14, display: "grid", gap: 16 }}>
        {/* Team standings */}
        <div style={{ background: "#0f172a", color: "white", borderRadius: 14, padding: 14 }}>
          <div style={{ fontWeight: 1000, marginBottom: 10 }}>Team Standings</div>

          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: "left", color: "rgba(255,255,255,0.70)" }}>
                  <th style={{ padding: "8px 6px" }}>#</th>
                  <th style={{ padding: "8px 6px" }}>Team</th>
                  <th style={{ padding: "8px 6px" }}>P</th>
                  <th style={{ padding: "8px 6px" }}>W</th>
                  <th style={{ padding: "8px 6px" }}>L</th>
                  <th style={{ padding: "8px 6px" }}>T</th>
                  <th style={{ padding: "8px 6px" }}>Pts</th>
                  <th style={{ padding: "8px 6px" }}>Bonus</th>
                  <th style={{ padding: "8px 6px" }}>NRR</th>
                </tr>
              </thead>
              <tbody>
                {standings.map((r, idx) => (
                  <tr key={r.teamId} style={{ borderTop: "1px solid rgba(255,255,255,0.08)" }}>
                    <td style={{ padding: "8px 6px", fontWeight: 900 }}>{idx + 1}</td>
                    <td style={{ padding: "8px 6px", fontWeight: 900 }}>{r.teamName}</td>
                    <td style={{ padding: "8px 6px" }}>{r.played}</td>
                    <td style={{ padding: "8px 6px" }}>{r.won}</td>
                    <td style={{ padding: "8px 6px" }}>{r.lost}</td>
                    <td style={{ padding: "8px 6px" }}>{r.tied}</td>
                    <td style={{ padding: "8px 6px", fontWeight: 1000 }}>{r.points}</td>
                    <td style={{ padding: "8px 6px" }}>{r.bonus}</td>
                    <td style={{ padding: "8px 6px" }}>{fmt(r.nrr, 2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {matches.length === 0 ? (
            <div style={{ marginTop: 10, color: "rgba(255,255,255,0.70)" }}>
              No completed matches yet. Finish a match (set to <b>completed</b>) to populate leaderboards.
            </div>
          ) : null}
        </div>

        {/* Batting */}
        <div style={{ background: "#0f172a", color: "white", borderRadius: 14, padding: 14 }}>
          <div style={{ fontWeight: 1000, marginBottom: 10 }}>Batting (Runs)</div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: "left", color: "rgba(255,255,255,0.70)" }}>
                  <th style={{ padding: "8px 6px" }}>#</th>
                  <th style={{ padding: "8px 6px" }}>Player</th>
                  <th style={{ padding: "8px 6px" }}>Team</th>
                  <th style={{ padding: "8px 6px" }}>Runs</th>
                  <th style={{ padding: "8px 6px" }}>Inns</th>
                  <th style={{ padding: "8px 6px" }}>Avg</th>
                  <th style={{ padding: "8px 6px" }}>SR</th>
                </tr>
              </thead>
              <tbody>
                {battingRows.map((r, idx) => (
                  <tr key={r.playerId} style={{ borderTop: "1px solid rgba(255,255,255,0.08)" }}>
                    <td style={{ padding: "8px 6px", fontWeight: 900 }}>{idx + 1}</td>
                    <td style={{ padding: "8px 6px", fontWeight: 900 }}>{r.name}</td>
                    <td style={{ padding: "8px 6px" }}>{r.teamName}</td>
                    <td style={{ padding: "8px 6px", fontWeight: 1000 }}>{r.runs}</td>
                    <td style={{ padding: "8px 6px" }}>{r.inns}</td>
                    <td style={{ padding: "8px 6px" }}>{fmt(r.avg, 2)}</td>
                    <td style={{ padding: "8px 6px" }}>{fmt(r.sr, 1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Bowling */}
        <div style={{ background: "#0f172a", color: "white", borderRadius: 14, padding: 14 }}>
          <div style={{ fontWeight: 1000, marginBottom: 10 }}>Bowling (Wickets)</div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: "left", color: "rgba(255,255,255,0.70)" }}>
                  <th style={{ padding: "8px 6px" }}>#</th>
                  <th style={{ padding: "8px 6px" }}>Player</th>
                  <th style={{ padding: "8px 6px" }}>Team</th>
                  <th style={{ padding: "8px 6px" }}>Wkts</th>
                  <th style={{ padding: "8px 6px" }}>Overs</th>
                  <th style={{ padding: "8px 6px" }}>Matches</th>
                  <th style={{ padding: "8px 6px" }}>Econ</th>
                </tr>
              </thead>
              <tbody>
                {bowlingRows.map((r, idx) => (
                  <tr key={r.playerId} style={{ borderTop: "1px solid rgba(255,255,255,0.08)" }}>
                    <td style={{ padding: "8px 6px", fontWeight: 900 }}>{idx + 1}</td>
                    <td style={{ padding: "8px 6px", fontWeight: 900 }}>{r.name}</td>
                    <td style={{ padding: "8px 6px" }}>{r.teamName}</td>
                    <td style={{ padding: "8px 6px", fontWeight: 1000 }}>{r.wickets}</td>
                    <td style={{ padding: "8px 6px" }}>{r.overs}</td>
                    <td style={{ padding: "8px 6px" }}>{r.matches}</td>
                    <td style={{ padding: "8px 6px" }}>{fmt(r.econ, 2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
