import { useMemo } from "react";

function toInt(n, fallback = 0) {
  const x = Number(n);
  return Number.isFinite(x) ? x : fallback;
}

function buildCumulativeSeries(balls) {
  const sorted = (balls || [])
    .slice()
    .sort((a, b) => (toInt(a.over_no, 0) - toInt(b.over_no, 0)) || (toInt(a.delivery_in_over, 0) - toInt(b.delivery_in_over, 0)) || 0);

  let cum = 0;
  let legalX = 0; // x in legal balls
  const pts = [{ x: 0, y: 0 }];

  for (const b of sorted) {
    cum += toInt(b.runs_off_bat, 0) + toInt(b.extra_runs, 0);
    if (b?.legal_ball !== false) legalX += 1;
    pts.push({ x: legalX, y: cum });
  }
  return pts;
}

function fmtOverFromBalls(legalBalls) {
  const o = Math.floor(legalBalls / 6);
  const b = legalBalls % 6;
  return `${o}.${b}`;
}

export default function WormGraph({
  innings1Balls = [],
  innings2Balls = [],
  target = null, // number (innings1Total+1)
  theme = "dark",
  maxOvers = 20,
}) {
  const series1 = useMemo(() => buildCumulativeSeries(innings1Balls), [innings1Balls]);
  const series2 = useMemo(() => buildCumulativeSeries(innings2Balls), [innings2Balls]);

  const hasAny = (series1.length > 1) || (series2.length > 1);

  const maxX = maxOvers * 6;
  const maxY = Math.max(
    1,
    ...series1.map((p) => p.y),
    ...series2.map((p) => p.y),
    ...(Number.isFinite(target) ? [target] : [])
  );

  const isLight = theme === "light";
  const text = isLight ? "#0f172a" : "rgba(255,255,255,0.92)";
  const subText = isLight ? "rgba(15,23,42,0.65)" : "rgba(232,238,252,0.70)";
  const border = isLight ? "rgba(15,23,42,0.12)" : "rgba(255,255,255,0.10)";
  const bg = isLight ? "rgba(15,23,42,0.02)" : "rgba(255,255,255,0.04)";

  if (!hasAny) {
    return <div style={{ color: subText, fontSize: 13 }}>No worm yet.</div>;
  }

  // SVG chart constants
  const W = 720;
  const H = 220;
  const PAD_L = 44;
  const PAD_R = 14;
  const PAD_T = 14;
  const PAD_B = 28;

  function sx(x) {
    const innerW = W - PAD_L - PAD_R;
    return PAD_L + (Math.min(Math.max(x, 0), maxX) / maxX) * innerW;
  }
  function sy(y) {
    const innerH = H - PAD_T - PAD_B;
    return PAD_T + (1 - Math.min(Math.max(y, 0), maxY) / maxY) * innerH;
  }

  function poly(pts) {
    return pts.map((p) => `${sx(p.x)},${sy(p.y)}`).join(" ");
  }

  const p1 = poly(series1);
  const p2 = poly(series2);

  // simple grid ticks
  const xTicks = [0, 5, 10, 15, 20].filter((o) => o <= maxOvers);
  const yTicks = 4;

  const x1Balls = series1.at(-1)?.x || 0;
  const x2Balls = series2.at(-1)?.x || 0;

  return (
    <div style={{ fontSize: 13 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "baseline", marginBottom: 8 }}>
        <div style={{ fontWeight: 900, color: text }}>Worm</div>
        <div style={{ color: subText, fontSize: 12 }}>
          Innings 1: {series1.at(-1)?.y || 0} ({fmtOverFromBalls(x1Balls)} ov) • Innings 2: {series2.at(-1)?.y || 0} ({fmtOverFromBalls(x2Balls)} ov)
        </div>
      </div>

      <div style={{ borderRadius: 12, border: `1px solid ${border}`, background: bg, padding: 10, overflowX: "auto" }}>
        <svg width="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ display: "block", minWidth: 520 }}>
          {/* grid */}
          {xTicks.map((o) => {
            const x = sx(o * 6);
            return <line key={`x-${o}`} x1={x} y1={PAD_T} x2={x} y2={H - PAD_B} stroke={border} strokeWidth="1" />;
          })}
          {[...Array(yTicks + 1)].map((_, i) => {
            const y = PAD_T + ((H - PAD_T - PAD_B) * i) / yTicks;
            return <line key={`y-${i}`} x1={PAD_L} y1={y} x2={W - PAD_R} y2={y} stroke={border} strokeWidth="1" />;
          })}

          {/* target line */}
          {Number.isFinite(target) ? (
            <line x1={PAD_L} y1={sy(target)} x2={W - PAD_R} y2={sy(target)} stroke={isLight ? "#ef4444" : "rgba(239,68,68,0.9)"} strokeWidth="2" strokeDasharray="6 4" />
          ) : null}

          {/* innings lines */}
          <polyline points={p1} fill="none" stroke={isLight ? "#2563eb" : "rgba(96,165,250,0.95)"} strokeWidth="3" />
          <polyline points={p2} fill="none" stroke={isLight ? "#f59e0b" : "rgba(251,191,36,0.95)"} strokeWidth="3" />

          {/* axis labels */}
          <text x={PAD_L} y={H - 8} fill={subText} fontSize="12">Overs</text>
          <text x={10} y={PAD_T + 12} fill={subText} fontSize="12">Runs</text>

          {xTicks.map((o) => (
            <text key={`xt-${o}`} x={sx(o * 6)} y={H - 10} fill={subText} fontSize="11" textAnchor="middle">
              {o}
            </text>
          ))}

          {/* y labels (0 and max) */}
          <text x={PAD_L - 10} y={sy(0) + 4} fill={subText} fontSize="11" textAnchor="end">0</text>
          <text x={PAD_L - 10} y={sy(maxY) + 4} fill={subText} fontSize="11" textAnchor="end">{Math.round(maxY)}</text>
        </svg>

        <div style={{ display: "flex", gap: 10, marginTop: 8, flexWrap: "wrap" }}>
          <div style={{ display: "flex", gap: 6, alignItems: "center", color: subText, fontSize: 12 }}>
            <span style={{ width: 10, height: 10, borderRadius: 99, background: isLight ? "#2563eb" : "rgba(96,165,250,0.95)", display: "inline-block" }} />
            Innings 1
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "center", color: subText, fontSize: 12 }}>
            <span style={{ width: 10, height: 10, borderRadius: 99, background: isLight ? "#f59e0b" : "rgba(251,191,36,0.95)", display: "inline-block" }} />
            Innings 2
          </div>
          {Number.isFinite(target) ? (
            <div style={{ display: "flex", gap: 6, alignItems: "center", color: subText, fontSize: 12 }}>
              <span style={{ width: 14, height: 2, background: isLight ? "#ef4444" : "rgba(239,68,68,0.9)", display: "inline-block" }} />
              Target {target}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
