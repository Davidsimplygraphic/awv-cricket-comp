import { useMemo } from "react";

function toInt(n, fallback = 0) {
  const x = Number(n);
  return Number.isFinite(x) ? x : fallback;
}

function legalBallsCount(balls) {
  // Treat NULL as legal; only explicit false is illegal
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
    .sort((a, b) => (toInt(a.over_no, 0) - toInt(b.over_no, 0)) || (toInt(a.delivery_in_over, 0) - toInt(b.delivery_in_over, 0)) || 0);
}

function buildBattingStats(balls, playerId) {
  let r = 0;
  let b = 0;
  let fours = 0;
  let sixes = 0;
  let outs = 0;

  for (const x of balls || []) {
    if (x.striker_id === playerId) {
      r += toInt(x.runs_off_bat, 0);
      if (x?.legal_ball !== false) b += 1;
      if (toInt(x.runs_off_bat, 0) === 4) fours += 1;
      if (toInt(x.runs_off_bat, 0) === 6) sixes += 1;
    }
    if (x.wicket && x.dismissed_player_id === playerId) {
      outs += 1;
    }
  }

  const sr = b ? (r / b) * 100 : 0;
  return { r, b, fours, sixes, sr, outs };
}

function buildBowlingStats(balls, playerId) {
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

export default function ScorecardTables({ title, balls, playersById, theme = "dark" }) {
  const sorted = useMemo(() => sortBalls(balls), [balls]);

  const totals = useMemo(() => {
    const runs = (sorted || []).reduce((acc, b) => acc + toInt(b.runs_off_bat, 0) + toInt(b.extra_runs, 0), 0);
    const wkts = (sorted || []).reduce((acc, b) => acc + (b.wicket ? 1 : 0), 0);
    const legal = legalBallsCount(sorted || []);
    return { runs, wkts, legal, oversText: oversTextFromLegal(legal) };
  }, [sorted]);

  const batters = useMemo(() => {
    const seen = new Set();
    const list = [];
    for (const b of sorted || []) {
      if (b.striker_id && !seen.has(b.striker_id)) {
        seen.add(b.striker_id);
        list.push(b.striker_id);
      }
      if (b.non_striker_id && !seen.has(b.non_striker_id)) {
        seen.add(b.non_striker_id);
        list.push(b.non_striker_id);
      }
      if (b.dismissed_player_id && !seen.has(b.dismissed_player_id)) {
        seen.add(b.dismissed_player_id);
        list.push(b.dismissed_player_id);
      }
    }
    return list;
  }, [sorted]);

  const bowlers = useMemo(() => {
    const seen = new Set();
    const list = [];
    for (const b of sorted || []) {
      if (b.bowler_id && !seen.has(b.bowler_id)) {
        seen.add(b.bowler_id);
        list.push(b.bowler_id);
      }
    }
    return list;
  }, [sorted]);

  const isLight = theme === "light";
  const text = isLight ? "#0f172a" : "rgba(255,255,255,0.92)";
  const subText = isLight ? "rgba(15,23,42,0.70)" : "rgba(232,238,252,0.75)";
  const border = isLight ? "rgba(15,23,42,0.12)" : "rgba(255,255,255,0.10)";
  const softBorder = isLight ? "rgba(15,23,42,0.08)" : "rgba(255,255,255,0.08)";
  const bg = isLight ? "white" : "rgba(255,255,255,0.04)";

  const cardStyle = {
    borderRadius: 14,
    border: `1px solid ${border}`,
    background: isLight ? "white" : "rgba(0,0,0,0.35)",
    padding: 12,
    color: text,
  };

  const sectionTitleStyle = {
    fontWeight: 1000,
    marginBottom: 10,
    display: "flex",
    justifyContent: "space-between",
    gap: 10,
    flexWrap: "wrap",
    alignItems: "baseline",
  };

  const tableStyle = {
    width: "100%",
    borderCollapse: "collapse",
    fontSize: 13,
    color: text,
    background: bg,
  };

  const thStyle = {
    textAlign: "left",
    padding: "10px 12px",
    borderBottom: `1px solid ${softBorder}`,
    color: subText,
    fontWeight: 900,
    fontSize: 12,
    letterSpacing: 0.2,
    background: isLight ? "rgba(15,23,42,0.02)" : "transparent",
  };

  const tdStyle = {
    padding: "10px 12px",
    borderBottom: `1px solid ${softBorder}`,
    verticalAlign: "top",
    color: text,
  };

  const summaryStyle = {
    color: subText,
    fontWeight: 800,
    fontSize: 12,
  };

  return (
    <div style={cardStyle}>
      <div style={sectionTitleStyle}>
        <div>{title}</div>
        <div style={summaryStyle}>
          {totals.runs}/{totals.wkts} ({totals.oversText} ov)
        </div>
      </div>

      <div style={{ fontWeight: 1000, marginBottom: 8 }}>Batting</div>
      <div style={{ overflowX: "auto", borderRadius: 12, border: `1px solid ${softBorder}` }}>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>Batter</th>
              <th style={{ ...thStyle, textAlign: "right" }}>R</th>
              <th style={{ ...thStyle, textAlign: "right" }}>B</th>
              <th style={{ ...thStyle, textAlign: "right" }}>4s</th>
              <th style={{ ...thStyle, textAlign: "right" }}>6s</th>
              <th style={{ ...thStyle, textAlign: "right" }}>SR</th>
              <th style={{ ...thStyle, textAlign: "right" }}>Status</th>
            </tr>
          </thead>
          <tbody>
            {batters.length ? (
              batters.map((id) => {
                const p = playersById?.[id];
                const name = p?.name || "Unknown";
                const s = buildBattingStats(sorted, id);
                const out = s.outs > 0;
                return (
                  <tr key={id}>
                    <td style={{ ...tdStyle, fontWeight: 900 }}>{name}</td>
                    <td style={{ ...tdStyle, textAlign: "right" }}>{s.r}</td>
                    <td style={{ ...tdStyle, textAlign: "right" }}>{s.b}</td>
                    <td style={{ ...tdStyle, textAlign: "right" }}>{s.fours}</td>
                    <td style={{ ...tdStyle, textAlign: "right" }}>{s.sixes}</td>
                    <td style={{ ...tdStyle, textAlign: "right" }}>{s.sr.toFixed(1)}</td>
                    <td style={{ ...tdStyle, textAlign: "right", color: out ? (isLight ? "#ef4444" : "rgba(248,113,113,0.95)") : (isLight ? "#16a34a" : "rgba(134,239,172,0.95)") }}>
                      {out ? "Out x1" : "Not out"}
                    </td>
                  </tr>
                );
              })
            ) : (
              <tr>
                <td style={tdStyle} colSpan={7}>
                  <span style={{ color: subText }}>No batting yet.</span>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div style={{ height: 14 }} />

      <div style={{ fontWeight: 1000, marginBottom: 8 }}>Bowling</div>
      <div style={{ overflowX: "auto", borderRadius: 12, border: `1px solid ${softBorder}` }}>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>Bowler</th>
              <th style={{ ...thStyle, textAlign: "right" }}>O</th>
              <th style={{ ...thStyle, textAlign: "right" }}>R</th>
              <th style={{ ...thStyle, textAlign: "right" }}>W</th>
              <th style={{ ...thStyle, textAlign: "right" }}>Econ</th>
            </tr>
          </thead>
          <tbody>
            {bowlers.length ? (
              bowlers.map((id) => {
                const p = playersById?.[id];
                const name = p?.name || "Unknown";
                const s = buildBowlingStats(sorted, id);
                return (
                  <tr key={id}>
                    <td style={{ ...tdStyle, fontWeight: 900 }}>{name}</td>
                    <td style={{ ...tdStyle, textAlign: "right" }}>{s.overs}</td>
                    <td style={{ ...tdStyle, textAlign: "right" }}>{s.runs}</td>
                    <td style={{ ...tdStyle, textAlign: "right" }}>{s.wkts}</td>
                    <td style={{ ...tdStyle, textAlign: "right" }}>{s.econ.toFixed(2)}</td>
                  </tr>
                );
              })
            ) : (
              <tr>
                <td style={tdStyle} colSpan={5}>
                  <span style={{ color: subText }}>No bowling yet.</span>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
