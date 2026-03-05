import { useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabase";

/**
 * Points Table (skeleton)
 *
 * Your tournament rules:
 * - 4 points for winning the game
 * - bonus: +2 for 100, +1 for 50, +2 for 5-for, +1 for 3-for
 * - tie-breaker: head-to-head
 *
 * Current DB does not yet store match result fields (winner_team_id, etc) or per-player milestones,
 * so this page renders the table structure with points = 0 until result data is added.
 */
export default function PointsTable() {
  const [teams, setTeams] = useState([]);
  const [matches, setMatches] = useState([]);
  const [err, setErr] = useState("");

  useEffect(() => {
    (async () => {
      setErr("");

      const t = await supabase.from("teams").select("*").order("name");
      if (t.error) {
        setErr(t.error.message);
        return;
      }
      setTeams(t.data || []);

      const m = await supabase.from("matches").select("*");
      if (m.error) {
        setErr((prev) => prev || m.error.message);
        return;
      }
      setMatches(m.data || []);
    })();
  }, []);

  const rows = useMemo(() => {
    // Placeholder until match results are stored.
    return (teams || []).map((t) => ({
      teamId: t.id,
      name: t.name,
      played: 0,
      won: 0,
      lost: 0,
      points: 0,
    }));
  }, [teams, matches]);

  return (
    <div>
      <h2>Points Table</h2>
      {err && <div style={{ color: "crimson" }}>{err}</div>}

      <p style={{ color: "#666" }}>
        This table is wired in, but points/results will remain 0 until we store match outcomes (winner/loser) and milestone bonuses.
      </p>

      <div style={{ overflowX: "auto" }}>
        <table cellPadding="8" style={{ borderCollapse: "collapse", width: "100%", minWidth: 520 }}>
          <thead>
            <tr>
              <th align="left" style={{ borderBottom: "1px solid #ddd" }}>Team</th>
              <th align="right" style={{ borderBottom: "1px solid #ddd" }}>P</th>
              <th align="right" style={{ borderBottom: "1px solid #ddd" }}>W</th>
              <th align="right" style={{ borderBottom: "1px solid #ddd" }}>L</th>
              <th align="right" style={{ borderBottom: "1px solid #ddd" }}>Pts</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.teamId}>
                <td style={{ borderBottom: "1px solid #f0f0f0" }}>{r.name}</td>
                <td align="right" style={{ borderBottom: "1px solid #f0f0f0" }}>{r.played}</td>
                <td align="right" style={{ borderBottom: "1px solid #f0f0f0" }}>{r.won}</td>
                <td align="right" style={{ borderBottom: "1px solid #f0f0f0" }}>{r.lost}</td>
                <td align="right" style={{ borderBottom: "1px solid #f0f0f0", fontWeight: 800 }}>{r.points}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
