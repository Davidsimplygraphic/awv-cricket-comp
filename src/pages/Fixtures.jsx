import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabase";
import {
  buildCompletedResultText,
  buildInningsTotals,
  deriveRosterWicketCap,
  deriveMatchDisplayStatus,
  resolveDisplayWicketCap,
  toInt,
} from "../lib/scoring";

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

export default function Fixtures() {
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  const [matches, setMatches] = useState([]); // match rows
  const [inningsByMatch, setInningsByMatch] = useState(new Map()); // matchId -> {1: inningsRow, 2: inningsRow}
  const [ballsByInnings, setBallsByInnings] = useState(new Map()); // inningsId -> balls
  const [fixtureWicketCaps, setFixtureWicketCaps] = useState(new Map()); // fixtureId -> wicket cap
  const [players, setPlayers] = useState([]); // active players for roster fallback

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

      const fixtureIds = rows.map((r) => r.fixture_id || r.id).filter(Boolean);
      if (fixtureIds.length) {
        const caps = await supabase
          .from("fixture_wicket_caps")
          .select("fixture_id,wicket_cap")
          .in("fixture_id", fixtureIds);

        if (!alive) return;
        if (!caps.error) {
          const capMap = new Map();
          for (const row of caps.data || []) {
            if (row?.fixture_id) capMap.set(row.fixture_id, row.wicket_cap ?? null);
          }
          setFixtureWicketCaps(capMap);
        } else {
          setFixtureWicketCaps(new Map());
        }
      } else {
        setFixtureWicketCaps(new Map());
      }

      const teamIds = [...new Set(rows.flatMap((r) => [r.team_a_id, r.team_b_id]).filter(Boolean))];
      if (teamIds.length) {
        const p = await supabase
          .from("players")
          .select("id,team_id,active")
          .in("team_id", teamIds)
          .eq("active", true);

        if (!alive) return;
        if (!p.error) setPlayers(p.data || []);
        else setPlayers([]);
      } else {
        setPlayers([]);
      }

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
      const rosterWicketCap = deriveRosterWicketCap(players, [teamA?.id, teamB?.id]);
      const displayWicketCap = resolveDisplayWicketCap({
        fixtureWicketCap: fixtureWicketCaps.get(fixtureId) ?? null,
        matchWicketCap: m.wicket_cap,
        rosterWicketCap,
        fallback: 10,
      });

      const displayStatus = deriveMatchDisplayStatus({
        matchStatus: m.status,
        innings1Row: inn1Row,
        innings2Row: inn2Row,
        innings1Balls: inn1Balls,
        innings2Balls: inn2Balls,
        oversLimit: m.overs_limit,
        wicketCap: displayWicketCap,
      });

      const inn1 = inn1Row ? buildInningsTotals(inn1Row, inn1Balls) : null;
      const inn2 = inn2Row ? buildInningsTotals(inn2Row, inn2Balls) : null;

      const resultText = buildCompletedResultText({
        matchStatus: displayStatus,
        innings1Team: inn1Team,
        innings2Team: inn2Team,
        innings1: inn1,
        innings2: inn2,
        wicketCap: displayWicketCap,
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
        wicketCap: displayWicketCap,
        timeLabel: formatTime(m.scheduled_at),
        status: displayStatus || "",
        inn1,
        inn2,
        resultText,
      });
    }

    out.sort((a, b) => new Date(matches.find(m=>m.id===a.matchId)?.scheduled_at || 0).getTime() - new Date(matches.find(m=>m.id===b.matchId)?.scheduled_at || 0).getTime());
    return out;
  }, [matches, inningsByMatch, ballsByInnings, fixtureWicketCaps, players]);

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
