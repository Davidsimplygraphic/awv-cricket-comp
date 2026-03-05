import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabase";

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

function statusBadge(status) {
  const s = String(status || "").toLowerCase();
  if (s === "completed") return { label: "COMPLETED", bg: "#16a34a" };
  if (s === "playing" || s === "live") return { label: "LIVE", bg: "#ef4444" };
  if (s === "scheduled") return { label: "SCHEDULED", bg: "#334155" };
  return { label: (status || "").toString().toUpperCase() || "—", bg: "#334155" };
}

function formatDateHeading(dateKey) {
  const d = new Date(`${dateKey}T00:00:00`);
  return d.toLocaleDateString(undefined, {
    day: "2-digit",
    month: "long",
    year: "numeric",
  });
}

function formatTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function buildResultText({ matchStatus, inn1Team, inn2Team, inn1, inn2, wicketCap }) {
  const s = String(matchStatus || "").toLowerCase();
  if (s !== "completed") return "";

  if (!inn1 || !inn2) return "";

  // Only show a result once both innings have at least started (some balls) OR are completed.
  const hasI1 = (inn1.balls || []).length > 0 || inn1.completed;
  const hasI2 = (inn2.balls || []).length > 0 || inn2.completed;
  if (!hasI1 || !hasI2) return "";

  const i1Runs = inn1.runs;
  const i2Runs = inn2.runs;

  if (i2Runs > i1Runs) {
    const wktsRemaining = Math.max(0, toInt(wicketCap, 10) - inn2.wkts);
    const ballsRemaining = Math.max(0, toInt(inn2.maxLegal, 0) - toInt(inn2.legalBalls, 0));
    return `${inn2Team?.name || inn2Team?.short_name || "Team 2"} won by ${wktsRemaining} wicket${wktsRemaining === 1 ? "" : "s"} with ${ballsRemaining} ball${ballsRemaining === 1 ? "" : "s"} remaining`;
  }
  if (i1Runs > i2Runs) {
    const runsBy = i1Runs - i2Runs;
    return `${inn1Team?.name || inn1Team?.short_name || "Team 1"} won by ${runsBy} run${runsBy === 1 ? "" : "s"}`;
  }
  return "Match tied";
}

export default function Fixtures() {
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  const [matches, setMatches] = useState([]); // match rows
  const [inningsByMatch, setInningsByMatch] = useState(new Map()); // matchId -> {1: inningsRow, 2: inningsRow}
  const [ballsByInnings, setBallsByInnings] = useState(new Map()); // inningsId -> balls

  useEffect(() => {
    let alive = true;

    (async () => {
      setLoading(true);
      setErr("");

      // Load match rows with team joins.
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
        .order("scheduled_at", { ascending: true, nullsFirst: false });

      if (!alive) return;
      if (m.error) {
        setErr(`Fixtures load failed: ${m.error.message}`);
        setMatches([]);
        setInningsByMatch(new Map());
        setBallsByInnings(new Map());
        setLoading(false);
        return;
      }

      const rows = (m.data || []).slice();
      setMatches(rows);

      const matchIds = rows.map((r) => r.id).filter(Boolean);

      // Load innings rows for all matches
      const innMap = new Map();
      if (matchIds.length) {
        const inn = await supabase
          .from("innings")
          .select("id,match_id,innings_no,batting_team_id,bowling_team_id,completed")
          .in("match_id", matchIds)
          .order("innings_no", { ascending: true });

        if (!alive) return;
        if (inn.error) {
          setErr(`Innings load failed: ${inn.error.message}`);
          setLoading(false);
          return;
        }

        for (const r of inn.data || []) {
          const mid = r.match_id;
          if (!innMap.has(mid)) innMap.set(mid, {});
          const ino = Number(r.innings_no);
          if (ino === 1 || ino === 2) innMap.get(mid)[ino] = r;
        }
      }

      // Load balls for all matches (single query, then bucket by innings_id)
      const ballsMap = new Map();
      if (matchIds.length) {
        const b = await supabase
          .from("balls")
          .select("match_id,innings_id,runs_off_bat,extra_runs,legal_ball,wicket,over_no,delivery_in_over")
          .in("match_id", matchIds)
          .order("match_id", { ascending: true })
          .order("innings_id", { ascending: true })
          .order("over_no", { ascending: true })
          .order("delivery_in_over", { ascending: true });

        if (!alive) return;
        if (b.error) {
          setErr(`Balls load failed: ${b.error.message}`);
          setLoading(false);
          return;
        }

        for (const row of b.data || []) {
          const iid = row.innings_id;
          if (!iid) continue;
          if (!ballsMap.has(iid)) ballsMap.set(iid, []);
          ballsMap.get(iid).push(row);
        }
      }

      if (!alive) return;
      setInningsByMatch(innMap);
      setBallsByInnings(ballsMap);
      setLoading(false);
    })();

    return () => {
      alive = false;
    };
  }, []);

  const fixtures = useMemo(() => {
    const out = [];

    for (const m of matches) {
      const fixtureId = m.fixture_id || m.id;
      const teamA = m.team_a || null;
      const teamB = m.team_b || null;

      const teamById = new Map();
      if (teamA?.id) teamById.set(teamA.id, teamA);
      if (teamB?.id) teamById.set(teamB.id, teamB);

      const dateKey = (() => {
        const d = new Date(m.scheduled_at || Date.now());
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      })();

      const innObj = inningsByMatch.get(m.id) || {};
      const inn1Row = innObj[1] || null;
      const inn2Row = innObj[2] || null;

      // For display + results, trust the innings batting_team_id when it exists.
      const inn1Team = inn1Row?.batting_team_id ? teamById.get(inn1Row.batting_team_id) : teamA;
      const inn2Team = inn2Row?.batting_team_id ? teamById.get(inn2Row.batting_team_id) : teamB;

      const inn1Balls = inn1Row ? ballsByInnings.get(inn1Row.id) || [] : [];
      const inn2Balls = inn2Row ? ballsByInnings.get(inn2Row.id) || [] : [];

      // Derive a reliable display status (some older scorer flows may not persist matches.status)
      const hasAnyBalls = (inn1Balls?.length || 0) + (inn2Balls?.length || 0) > 0;
      const rawStatus = m.status || "";

      const oversLimit = toInt(m.overs_limit, 20);
      const wicketCap = toInt(m.wicket_cap, 10);
      const maxLegal = oversLimit * 6;

      const inn1RunsTmp = inn1Row ? sumRuns(inn1Balls) : 0;
      const inn2RunsTmp = inn2Row ? sumRuns(inn2Balls) : 0;
      const inn2LegalTmp = inn2Row ? legalBallsCount(inn2Balls) : 0;
      const inn2WktsTmp = inn2Row ? sumWkts(inn2Balls) : 0;

      const chaseCompleted = !!inn1Row && !!inn2Row && inn2RunsTmp > inn1RunsTmp;
      const inn2Exhausted = !!inn2Row && (inn2LegalTmp >= maxLegal || inn2WktsTmp >= wicketCap || !!inn2Row.completed);
      const inningsSuggestCompleted = !!inn1Row && !!inn2Row && (!!inn1Row.completed || (inn1Balls?.length || 0) > 0) && (chaseCompleted || inn2Exhausted || !!inn2Row.completed);

      let displayStatus = rawStatus;
      const raw = String(rawStatus).toLowerCase();

      // If a match is marked completed but there are no balls yet, treat it as scheduled (stale flag).
      if (raw === "completed" && !hasAnyBalls) displayStatus = "scheduled";
      // If marked completed but innings data does not suggest a decision yet, treat as live.
      if (raw === "completed" && hasAnyBalls && !inningsSuggestCompleted) displayStatus = "live";

      if (raw !== "completed" && inningsSuggestCompleted) displayStatus = "completed";
      else if ((raw === "scheduled" || !raw) && hasAnyBalls) displayStatus = "live";
      else if (raw === "playing") displayStatus = "live";

      const inn1 = inn1Row
        ? {
            inningsId: inn1Row.id,
            completed: !!inn1Row.completed,
            runs: sumRuns(inn1Balls),
            wkts: sumWkts(inn1Balls),
            overs: oversTextFromLegal(legalBallsCount(inn1Balls)),
            balls: inn1Balls,
          }
        : null;

      const inn2 = inn2Row
        ? {
            inningsId: inn2Row.id,
            completed: !!inn2Row.completed,
            runs: sumRuns(inn2Balls),
            wkts: sumWkts(inn2Balls),
            legalBalls: legalBallsCount(inn2Balls),
            maxLegal: toInt(m.overs_limit, 20) * 6,
            overs: oversTextFromLegal(legalBallsCount(inn2Balls)),
            balls: inn2Balls,
          }
        : null;

      const resultText = buildResultText({
        // Use the derived status so cards that *look* completed also show a result.
        matchStatus: displayStatus,
        inn1Team,
        inn2Team,
        inn1,
        inn2,
        wicketCap: m.wicket_cap,
      });

      out.push({
        fixtureId,
        matchId: m.id,
        dateKey,
        teamA,
        teamB,
        inn1Team,
        inn2Team,
        oversLimit: toInt(m.overs_limit, 20),
        wicketCap: toInt(m.wicket_cap, 10),
        timeLabel: formatTime(m.scheduled_at),
        status: displayStatus || "",
        inn1,
        inn2,
        resultText,
      });
    }

    out.sort((a, b) => new Date(matches.find(m=>m.id===a.matchId)?.scheduled_at || 0).getTime() - new Date(matches.find(m=>m.id===b.matchId)?.scheduled_at || 0).getTime());
    return out;
  }, [matches, inningsByMatch, ballsByInnings]);

  const dateGroups = useMemo(() => {
    const g = new Map();
    for (const f of fixtures) {
      if (!g.has(f.dateKey)) g.set(f.dateKey, []);
      g.get(f.dateKey).push(f);
    }
    return Array.from(g.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [fixtures]);

  if (loading) {
    return (
      <div style={{ padding: 16 }}>
        <h1 style={{ margin: 0 }}>Fixtures / Results</h1>
        <div style={{ marginTop: 8, color: "#64748B" }}>Loading…</div>
      </div>
    );
  }

  return (
    <div style={{ padding: 16 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <h1 style={{ margin: 0 }}>Fixtures / Results</h1>
        <div style={{ fontSize: 12, opacity: 0.8 }}>
          Fixtures and results for the tournament. Tap <b>Match Centre</b> for full details.
        </div>
      </div>

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

      {dateGroups.map(([dateKey, fs]) => {
        const dateLabel = formatDateHeading(dateKey);

        return (
          <div key={dateKey} style={{ marginTop: 16 }}>
            <div
              style={{
                background: "#0b1b3a",
                color: "white",
                padding: "10px 12px",
                borderRadius: 10,
                fontWeight: 800,
                letterSpacing: 0.4,
              }}
            >
              {dateLabel.toUpperCase()}
            </div>

            <div style={{ display: "grid", gap: 12, marginTop: 12 }}>
              {fs.map((f) => {
                const badge = statusBadge(f.status);

                const nameBlock = (team) => {
                  const full = (team?.name || "").trim();
                  const short = (team?.short_name || "").trim();
                  if (full && short && full.toLowerCase() !== short.toLowerCase()) {
                    return (
                      <div style={{ fontWeight: 900 }}>
                        {full}
                        <span style={{ marginLeft: 8, fontSize: 12, opacity: 0.7, fontWeight: 900 }}>({short})</span>
                      </div>
                    );
                  }
                  return <div style={{ fontWeight: 900 }}>{full || short || "—"}</div>;
                };

                return (
                  <div
                    key={f.fixtureId}
                    style={{
                      borderRadius: 14,
                      background: "#0f172a",
                      color: "white",
                      padding: 14,
                      borderLeft: "4px solid #ef4444",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                        <span
                          style={{
                            background: "#111827",
                            padding: "4px 8px",
                            borderRadius: 999,
                            fontSize: 12,
                            fontWeight: 800,
                          }}
                        >
                          T20
                        </span>
                        <span
                          style={{
                            background: badge.bg,
                            padding: "4px 8px",
                            borderRadius: 999,
                            fontSize: 12,
                            fontWeight: 900,
                          }}
                        >
                          {badge.label}
                        </span>
                        <span style={{ fontSize: 12, color: "rgba(255,255,255,0.72)", fontWeight: 700 }}>
                          Overs: {f.oversLimit} · Time: {f.timeLabel} · Wicket cap: {f.wicketCap}
                        </span>
                      </div>

                      <div style={{ textAlign: "right" }}>
                        <div style={{ fontWeight: 900, fontSize: 13 }}>{f.status ? String(f.status).toUpperCase() : ""}</div>
                      </div>
                    </div>

                    <div style={{ marginTop: 12, display: "grid", gap: 10 }}>
                      {/* Innings 1 line */}
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                        {nameBlock(f.inn1Team || f.teamA)}
                        <div style={{ fontWeight: 1000 }}>
                          {f.inn1 ? (
                            (f.inn1.balls || []).length ? (
                              <>
                                {f.inn1.runs}/{f.inn1.wkts}
                                <span style={{ fontSize: 12, color: "rgba(255,255,255,0.70)", marginLeft: 8 }}>
                                  ({f.inn1.overs} ov)
                                </span>
                              </>
                            ) : (
                              <span style={{ color: "rgba(255,255,255,0.70)" }}>—</span>
                            )
                          ) : (
                            <span style={{ color: "rgba(255,255,255,0.70)" }}>—</span>
                          )}
                        </div>
                      </div>

                      {/* Innings 2 line */}
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                        {nameBlock(f.inn2Team || f.teamB)}
                        <div style={{ fontWeight: 1000 }}>
                          {f.inn2 ? (
                            (f.inn2.balls || []).length ? (
                              <>
                                {f.inn2.runs}/{f.inn2.wkts}
                                <span style={{ fontSize: 12, color: "rgba(255,255,255,0.70)", marginLeft: 8 }}>
                                  ({f.inn2.overs} ov)
                                </span>
                              </>
                            ) : (
                              <span style={{ color: "rgba(255,255,255,0.70)" }}>—</span>
                            )
                          ) : (
                            <span style={{ color: "rgba(255,255,255,0.70)" }}>—</span>
                          )}
                        </div>
                      </div>

                      {f.resultText ? (
                        <div style={{ marginTop: 2, color: "rgba(255,255,255,0.78)", fontWeight: 800, fontSize: 13 }}>{f.resultText}</div>
                      ) : null}
                    </div>

                    <div style={{ marginTop: 12, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                      <Link
                        to={`/match-centre/${f.fixtureId}`}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 8,
                          padding: "8px 10px",
                          borderRadius: 999,
                          background: "#111827",
                          border: "1px solid rgba(255,255,255,0.10)",
                          color: "white",
                          textDecoration: "none",
                          fontWeight: 900,
                          fontSize: 12,
                          letterSpacing: 0.2,
                        }}
                      >
                        MATCH CENTRE
                      </Link>

                      {f.fixtureId ? (
                        <Link
                          to={`/score/${f.fixtureId}`}
                          style={{
                            color: "#93c5fd",
                            textDecoration: "underline",
                            fontWeight: 900,
                            fontSize: 12,
                          }}
                        >
                          Open scorer
                        </Link>
                      ) : null}

                      {f.fixtureId ? (
                        <Link
                          to={`/match/${f.fixtureId}`}
                          style={{
                            color: "#93c5fd",
                            textDecoration: "underline",
                            fontWeight: 900,
                            fontSize: 12,
                          }}
                        >
                          Open spectator
                        </Link>
                      ) : null}

                      {/* Match Centre replaces the old spectator view */}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}

      {!err && fixtures.length === 0 ? (
        <div style={{ marginTop: 16, padding: 12, borderRadius: 12, border: "1px solid #E5E7EB", color: "#475569" }}>
          No fixtures found yet.
        </div>
      ) : null}
    </div>
  );
}
