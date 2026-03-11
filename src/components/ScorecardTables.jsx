import { useEffect, useMemo, useState } from "react";
import {
  didBatterFaceBall,
  isBowlerCreditedWicket,
  oversTextFromLegal,
  runsConcededByBowler,
  selectBatterStatus,
  selectInningsSummary,
  sortBallsByPosition,
} from "../lib/scoring";

function toInt(n, fallback = 0) {
  const x = Number(n);
  return Number.isFinite(x) ? x : fallback;
}

function buildBattingStats(balls, playerId, turn = 1) {
  let r = 0;
  let b = 0;
  let fours = 0;
  let sixes = 0;

  for (const x of balls || []) {
    if (x.striker_id === playerId && toInt(x.batting_turn, 1) === toInt(turn, 1)) {
      r += toInt(x.runs_off_bat, 0);
      if (didBatterFaceBall(x)) b += 1;
      if (toInt(x.runs_off_bat, 0) === 4) fours += 1;
      if (toInt(x.runs_off_bat, 0) === 6) sixes += 1;
    }
  }

  const sr = b ? (r / b) * 100 : 0;
  return { r, b, fours, sixes, sr };
}

function buildBowlingStats(balls, playerId) {
  let legal = 0;
  let runs = 0;
  let wkts = 0;

  for (const x of balls || []) {
    if (x.bowler_id !== playerId) continue;
    runs += runsConcededByBowler(x);
    if (isBowlerCreditedWicket(x)) wkts += 1;
    if (x?.legal_ball !== false) legal += 1;
  }

  const overs = oversTextFromLegal(legal);
  const econ = legal ? (runs / (legal / 6)) : 0;
  return { overs, runs, wkts, econ };
}

function useIsPhoneViewport() {
  const [isPhoneViewport, setIsPhoneViewport] = useState(
    typeof window !== "undefined" ? window.innerWidth <= 720 : false
  );

  useEffect(() => {
    if (typeof window === "undefined") return undefined;

    const onResize = () => setIsPhoneViewport(window.innerWidth <= 720);
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  return isPhoneViewport;
}

function MobileStatGrid({ items, text, subText, accent = null }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8 }}>
      {items.map((item) => (
        <div
          key={item.label}
          style={{
            borderRadius: 12,
            border: `1px solid ${accent || "rgba(255,255,255,0.08)"}`,
            background: "rgba(255,255,255,0.03)",
            padding: "8px 9px",
            minWidth: 0,
          }}
        >
          <div style={{ fontSize: 11, fontWeight: 900, color: subText }}>{item.label}</div>
          <div
            style={{
              marginTop: 4,
              fontSize: 14,
              fontWeight: 1000,
              color: text,
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {item.value}
          </div>
        </div>
      ))}
    </div>
  );
}

function statusColorForTone(tone, successColor, dangerColor) {
  return tone === "out" || tone === "retired_hurt" ? dangerColor : successColor;
}

export default function ScorecardTables({ title, balls, playersById, theme = "dark" }) {
  const sorted = useMemo(() => sortBallsByPosition(balls), [balls]);
  const totals = useMemo(() => selectInningsSummary(sorted), [sorted]);
  const isPhoneViewport = useIsPhoneViewport();

  const batters = useMemo(() => {
    const seen = new Set();
    const list = [];

    const push = (playerId, turn) => {
      if (!playerId) return;
      const t = toInt(turn, 1) || 1;
      const key = `${playerId}:${t}`;
      if (seen.has(key)) return;
      seen.add(key);
      list.push({ playerId, turn: t });
    };

    const exitsSeen = new Map();
    for (const b of sorted || []) {
      if (b.striker_id) push(b.striker_id, b.batting_turn || 1);
      if (b.non_striker_id) push(b.non_striker_id, (exitsSeen.get(b.non_striker_id) || 0) + 1);

      if (b.wicket && b.dismissed_player_id) {
        const nextExit = (exitsSeen.get(b.dismissed_player_id) || 0) + 1;
        exitsSeen.set(b.dismissed_player_id, nextExit);
        push(b.dismissed_player_id, nextExit);
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

  const battingRows = useMemo(() => (
    batters.map((ap) => {
      const p = playersById?.[ap.playerId];
      const baseName = p?.name || "Unknown";
      const name = ap.turn > 1
        ? `${baseName} (${ap.turn === 2 ? "2nd" : ap.turn === 3 ? "3rd" : `${ap.turn}th`})`
        : baseName;
      const s = buildBattingStats(sorted, ap.playerId, ap.turn);
      const status = selectBatterStatus({
        balls: sorted,
        playerId: ap.playerId,
        turn: ap.turn,
        isAtCrease: false,
      });

      return {
        key: `${ap.playerId}:${ap.turn}`,
        name,
        runs: s.r,
        balls: s.b,
        fours: s.fours,
        sixes: s.sixes,
        sr: s.sr.toFixed(1),
        status: status.label,
        statusTone: status.tone,
      };
    })
  ), [batters, playersById, sorted]);

  const bowlingRows = useMemo(() => (
    bowlers.map((id) => {
      const p = playersById?.[id];
      const name = p?.name || "Unknown";
      const s = buildBowlingStats(sorted, id);

      return {
        key: id,
        name,
        overs: s.overs,
        runs: s.runs,
        wickets: s.wkts,
        econ: s.econ.toFixed(2),
      };
    })
  ), [bowlers, playersById, sorted]);

  const isLight = theme === "light";
  const text = isLight ? "#0f172a" : "rgba(255,255,255,0.92)";
  const subText = isLight ? "rgba(15,23,42,0.70)" : "rgba(232,238,252,0.75)";
  const border = isLight ? "rgba(15,23,42,0.12)" : "rgba(255,255,255,0.10)";
  const softBorder = isLight ? "rgba(15,23,42,0.08)" : "rgba(255,255,255,0.08)";
  const bg = isLight ? "white" : "rgba(255,255,255,0.04)";
  const successColor = isLight ? "#16a34a" : "rgba(134,239,172,0.95)";
  const dangerColor = isLight ? "#ef4444" : "rgba(248,113,113,0.95)";

  const cardStyle = {
    borderRadius: 14,
    border: `1px solid ${border}`,
    background: isLight ? "white" : "rgba(0,0,0,0.35)",
    padding: isPhoneViewport ? 10 : 12,
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
      {isPhoneViewport ? (
        <div style={{ display: "grid", gap: 8 }}>
          {battingRows.length ? (
            battingRows.map((row) => (
              <div
                key={row.key}
                style={{
                  borderRadius: 12,
                  border: `1px solid ${softBorder}`,
                  background: bg,
                  padding: "10px 11px",
                  display: "grid",
                  gap: 10,
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
                  <div style={{ minWidth: 0 }}>
                    <div
                      style={{
                        fontWeight: 900,
                        fontSize: 15,
                        minWidth: 0,
                        display: "-webkit-box",
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: "vertical",
                        overflow: "hidden",
                        lineHeight: 1.2,
                      }}
                    >
                      {row.name}
                    </div>
                <div style={{ marginTop: 4, fontSize: 12, color: statusColorForTone(row.statusTone, successColor, dangerColor) }}>
                  {row.status}
                </div>
                  </div>

                  <div style={{ textAlign: "right", flexShrink: 0 }}>
                    <div style={{ fontSize: 22, fontWeight: 1000, lineHeight: 1 }}>{row.runs}</div>
                    <div style={{ marginTop: 4, fontSize: 12, color: subText }}>{row.balls} balls</div>
                  </div>
                </div>

                <MobileStatGrid
                  items={[
                    { label: "SR", value: row.sr },
                    { label: "4s", value: row.fours },
                    { label: "6s", value: row.sixes },
                  ]}
                  text={text}
                  subText={subText}
                  accent={softBorder}
                />
              </div>
            ))
          ) : (
            <div style={{ color: subText, fontSize: 13 }}>No batting yet.</div>
          )}
        </div>
      ) : (
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
              {battingRows.length ? (
                battingRows.map((row) => (
                  <tr key={row.key}>
                    <td style={{ ...tdStyle, fontWeight: 900 }}>{row.name}</td>
                    <td style={{ ...tdStyle, textAlign: "right" }}>{row.runs}</td>
                    <td style={{ ...tdStyle, textAlign: "right" }}>{row.balls}</td>
                    <td style={{ ...tdStyle, textAlign: "right" }}>{row.fours}</td>
                    <td style={{ ...tdStyle, textAlign: "right" }}>{row.sixes}</td>
                    <td style={{ ...tdStyle, textAlign: "right" }}>{row.sr}</td>
                    <td style={{ ...tdStyle, textAlign: "right", color: statusColorForTone(row.statusTone, successColor, dangerColor) }}>
                      {row.status}
                    </td>
                  </tr>
                ))
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
      )}

      <div style={{ height: 14 }} />

      <div style={{ fontWeight: 1000, marginBottom: 8 }}>Bowling</div>
      {isPhoneViewport ? (
        <div style={{ display: "grid", gap: 8 }}>
          {bowlingRows.length ? (
            bowlingRows.map((row) => (
              <div
                key={row.key}
                style={{
                  borderRadius: 12,
                  border: `1px solid ${softBorder}`,
                  background: bg,
                  padding: "10px 11px",
                  display: "grid",
                  gap: 10,
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
                  <div
                    style={{
                      fontWeight: 900,
                      fontSize: 15,
                      minWidth: 0,
                      display: "-webkit-box",
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: "vertical",
                      overflow: "hidden",
                      lineHeight: 1.2,
                    }}
                  >
                    {row.name}
                  </div>

                  <div style={{ textAlign: "right", flexShrink: 0 }}>
                    <div style={{ fontSize: 20, fontWeight: 1000, lineHeight: 1 }}>{row.overs}</div>
                    <div style={{ marginTop: 4, fontSize: 12, color: subText }}>overs</div>
                  </div>
                </div>

                <MobileStatGrid
                  items={[
                    { label: "Runs", value: row.runs },
                    { label: "Wkts", value: row.wickets },
                    { label: "Econ", value: row.econ },
                  ]}
                  text={text}
                  subText={subText}
                  accent={softBorder}
                />
              </div>
            ))
          ) : (
            <div style={{ color: subText, fontSize: 13 }}>No bowling yet.</div>
          )}
        </div>
      ) : (
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
              {bowlingRows.length ? (
                bowlingRows.map((row) => (
                  <tr key={row.key}>
                    <td style={{ ...tdStyle, fontWeight: 900 }}>{row.name}</td>
                    <td style={{ ...tdStyle, textAlign: "right" }}>{row.overs}</td>
                    <td style={{ ...tdStyle, textAlign: "right" }}>{row.runs}</td>
                    <td style={{ ...tdStyle, textAlign: "right" }}>{row.wickets}</td>
                    <td style={{ ...tdStyle, textAlign: "right" }}>{row.econ}</td>
                  </tr>
                ))
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
      )}
    </div>
  );
}
