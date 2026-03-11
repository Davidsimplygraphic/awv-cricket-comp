import { useMemo } from "react";
import { selectOverBoundaryTicks, selectWormSeries, selectWormWicketPoints } from "../lib/scoring";

function fmtOverFromBalls(legalBalls) {
  const overs = Math.floor(legalBalls / 6);
  const balls = legalBalls % 6;
  return `${overs}.${balls}`;
}

export default function WormGraph({
  innings1Balls = [],
  innings2Balls = [],
  playersById = {},
  target = null,
  theme = "dark",
  maxOvers = 20,
  compact = false,
}) {
  const series1 = useMemo(() => selectWormSeries(innings1Balls), [innings1Balls]);
  const series2 = useMemo(() => selectWormSeries(innings2Balls), [innings2Balls]);
  const wicketPoints1 = useMemo(() => selectWormWicketPoints(innings1Balls), [innings1Balls]);
  const wicketPoints2 = useMemo(() => selectWormWicketPoints(innings2Balls), [innings2Balls]);
  const allBalls = useMemo(() => [...innings1Balls, ...innings2Balls], [innings1Balls, innings2Balls]);
  const overBoundaryTicks = useMemo(
    () => selectOverBoundaryTicks({ balls: allBalls, maxOvers }),
    [allBalls, maxOvers]
  );

  const hasAny = series1.length > 1 || series2.length > 1;
  const resolvedMaxOvers = Math.max(1, overBoundaryTicks.at(-1) || 0, Number(maxOvers) || 0);
  const maxX = resolvedMaxOvers * 6;
  const maxY = Math.max(
    1,
    ...series1.map((point) => point.y),
    ...series2.map((point) => point.y),
    ...(Number.isFinite(target) ? [target] : [])
  );

  const isLight = theme === "light";
  const text = isLight ? "#0f172a" : "rgba(255,255,255,0.92)";
  const subText = isLight ? "rgba(15,23,42,0.65)" : "rgba(232,238,252,0.70)";
  const border = isLight ? "rgba(15,23,42,0.12)" : "rgba(255,255,255,0.10)";
  const bg = isLight ? "rgba(15,23,42,0.02)" : "rgba(255,255,255,0.04)";
  const overGuide = isLight ? "rgba(148,163,184,0.26)" : "rgba(148,163,184,0.18)";
  const wicketFill = isLight ? "#dc2626" : "#ef4444";
  const wicketStroke = isLight ? "#ffffff" : "rgba(248,250,252,0.94)";

  if (!hasAny) {
    return <div style={{ color: subText, fontSize: 13 }}>No worm yet.</div>;
  }

  const W = compact ? 420 : 720;
  const H = compact ? 196 : 220;
  const PAD_L = compact ? 32 : 44;
  const PAD_R = compact ? 18 : 14;
  const PAD_T = compact ? 12 : 14;
  const PAD_B = compact ? 28 : 28;

  function sx(x) {
    const innerW = W - PAD_L - PAD_R;
    return PAD_L + (Math.min(Math.max(x, 0), maxX) / maxX) * innerW;
  }

  function sy(y) {
    const innerH = H - PAD_T - PAD_B;
    return PAD_T + (1 - Math.min(Math.max(y, 0), maxY) / maxY) * innerH;
  }

  function poly(points) {
    return points.map((point) => `${sx(point.x)},${sy(point.y)}`).join(" ");
  }

  const xTicks = compact
    ? [...new Set([0, Math.max(0, Math.floor(resolvedMaxOvers / 2)), resolvedMaxOvers])].filter((overs) => overs <= resolvedMaxOvers)
    : [0, 5, 10, 15, 20, resolvedMaxOvers].filter((overs, index, list) => overs <= resolvedMaxOvers && list.indexOf(overs) === index);
  const yTicks = compact ? 3 : 4;
  const x1Balls = series1.at(-1)?.x || 0;
  const x2Balls = series2.at(-1)?.x || 0;
  const wicketRadius = compact ? 4.5 : 5.5;

  function renderWicketPoint(point, inningsKey) {
    const batterName = playersById?.[point.dismissedPlayerId]?.name || "Batter";
    const dismissal = point.dismissalKind ? ` (${point.dismissalKind})` : "";

    return (
      <circle
        key={`${inningsKey}-${point.key}`}
        data-worm-wicket={inningsKey}
        data-point-x={point.x}
        data-point-y={point.y}
        cx={sx(point.x)}
        cy={sy(point.y)}
        r={wicketRadius}
        fill={wicketFill}
        stroke={wicketStroke}
        strokeWidth="2"
      >
        <title>{`Wicket - ${batterName}${dismissal}`}</title>
      </circle>
    );
  }

  return (
    <div style={{ fontSize: compact ? 12 : 13 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 10,
          alignItems: "baseline",
          flexWrap: "wrap",
          marginBottom: 8,
        }}
      >
        <div style={{ fontWeight: 900, color: text }}>{compact ? "Run flow" : "Worm"}</div>
        <div style={{ color: subText, fontSize: 12 }}>
          Innings 1: {series1.at(-1)?.y || 0} ({fmtOverFromBalls(x1Balls)} ov) • Innings 2: {series2.at(-1)?.y || 0} ({fmtOverFromBalls(x2Balls)} ov)
        </div>
      </div>

      <div style={{ borderRadius: 12, border: `1px solid ${border}`, background: bg, padding: compact ? 8 : 10, overflowX: "auto" }}>
        <svg width="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMinYMin meet" style={{ display: "block", minWidth: compact ? 300 : 520 }}>
          {overBoundaryTicks.map((overs) => {
            const x = sx(overs * 6);
            return (
              <line
                key={`guide-${overs}`}
                data-worm-over-guide={overs}
                x1={x}
                y1={PAD_T}
                x2={x}
                y2={H - PAD_B}
                stroke={overGuide}
                strokeWidth="1"
                vectorEffect="non-scaling-stroke"
              />
            );
          })}
          {[...Array(yTicks + 1)].map((_, index) => {
            const y = PAD_T + ((H - PAD_T - PAD_B) * index) / yTicks;
            return (
              <line
                key={`y-${index}`}
                x1={PAD_L}
                y1={y}
                x2={W - PAD_R}
                y2={y}
                stroke={border}
                strokeWidth="1"
              />
            );
          })}

          {Number.isFinite(target) ? (
            <line
              x1={PAD_L}
              y1={sy(target)}
              x2={W - PAD_R}
              y2={sy(target)}
              stroke={isLight ? "#ef4444" : "rgba(239,68,68,0.9)"}
              strokeWidth="2"
              strokeDasharray="6 4"
            />
          ) : null}

          <polyline points={poly(series1)} fill="none" stroke={isLight ? "#2563eb" : "rgba(96,165,250,0.95)"} strokeWidth="3" />
          <polyline points={poly(series2)} fill="none" stroke={isLight ? "#f59e0b" : "rgba(251,191,36,0.95)"} strokeWidth="3" />
          {wicketPoints1.map((point) => renderWicketPoint(point, "innings1"))}
          {wicketPoints2.map((point) => renderWicketPoint(point, "innings2"))}

          <text x={PAD_L} y={H - 8} fill={subText} fontSize={compact ? "11" : "12"}>Overs</text>
          <text x={10} y={PAD_T + 12} fill={subText} fontSize={compact ? "11" : "12"}>Runs</text>

          {xTicks.map((overs) => (
            <text
              key={`xt-${overs}`}
              x={sx(overs * 6)}
              y={H - 10}
              fill={subText}
              fontSize={compact ? "10" : "11"}
              textAnchor="middle"
            >
              {overs}
            </text>
          ))}

          <text x={PAD_L - 10} y={sy(0) + 4} fill={subText} fontSize={compact ? "10" : "11"} textAnchor="end">0</text>
          <text x={PAD_L - 10} y={sy(maxY) + 4} fill={subText} fontSize={compact ? "10" : "11"} textAnchor="end">
            {Math.round(maxY)}
          </text>
        </svg>

        <div style={{ display: "flex", gap: 10, marginTop: 8, flexWrap: "wrap" }}>
          <div style={{ display: "flex", gap: 6, alignItems: "center", color: subText, fontSize: 12 }}>
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: 99,
                background: isLight ? "#2563eb" : "rgba(96,165,250,0.95)",
                display: "inline-block",
              }}
            />
            Innings 1
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "center", color: subText, fontSize: 12 }}>
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: 99,
                background: isLight ? "#f59e0b" : "rgba(251,191,36,0.95)",
                display: "inline-block",
              }}
            />
            Innings 2
          </div>
          {Number.isFinite(target) ? (
            <div style={{ display: "flex", gap: 6, alignItems: "center", color: subText, fontSize: 12 }}>
              <span
                style={{
                  width: 14,
                  height: 2,
                  background: isLight ? "#ef4444" : "rgba(239,68,68,0.9)",
                  display: "inline-block",
                }}
              />
              Target {target}
            </div>
          ) : null}
          <div style={{ display: "flex", gap: 6, alignItems: "center", color: subText, fontSize: 12 }}>
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: 99,
                background: wicketFill,
                border: `2px solid ${wicketStroke}`,
                display: "inline-block",
                boxSizing: "border-box",
              }}
            />
            Wicket
          </div>
        </div>
      </div>
    </div>
  );
}
