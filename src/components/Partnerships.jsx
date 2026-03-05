function toInt(n, fallback = 0) {
  const x = Number(n);
  return Number.isFinite(x) ? x : fallback;
}

function sortBalls(balls) {
  return (balls || [])
    .slice()
    .sort((a, b) => (toInt(a.over_no, 0) - toInt(b.over_no, 0)) || (toInt(a.delivery_in_over, 0) - toInt(b.delivery_in_over, 0)) || 0);
}

function overText(overNo, deliveryInOver) {
  const o = toInt(overNo, 0);
  const d = toInt(deliveryInOver, 0);
  return `${o}.${d}`;
}

export default function Partnerships({ balls, theme = "dark" }) {
  const sorted = sortBalls(balls);

  const isLight = theme === "light";
  const text = isLight ? "#0f172a" : "rgba(255,255,255,0.92)";
  const subText = isLight ? "rgba(15,23,42,0.70)" : "rgba(232,238,252,0.75)";
  const border = isLight ? "rgba(15,23,42,0.12)" : "rgba(255,255,255,0.10)";
  const bg = isLight ? "rgba(15,23,42,0.02)" : "rgba(255,255,255,0.04)";

  // Basic partnerships: reset on wicket
  const partnerships = [];
  let current = { runs: 0, balls: 0, startOver: null, endOver: null, endedByWicket: false };

  for (const b of sorted) {
    if (current.startOver == null) current.startOver = overText(b.over_no, b.delivery_in_over);

    const runs = toInt(b.runs_off_bat, 0) + toInt(b.extra_runs, 0);
    current.runs += runs;
    if (b?.legal_ball !== false) current.balls += 1;

    current.endOver = overText(b.over_no, b.delivery_in_over);

    if (b.wicket) {
      current.endedByWicket = true;
      partnerships.push(current);
      current = { runs: 0, balls: 0, startOver: null, endOver: null, endedByWicket: false };
    }
  }

  if (current.startOver != null && (current.runs > 0 || current.balls > 0)) {
    partnerships.push(current);
  }

  if (!partnerships.length) {
    return <div style={{ color: subText, fontSize: 13 }}>No partnerships yet.</div>;
  }

  return (
    <div style={{ fontSize: 13, color: text }}>
      <div style={{ fontWeight: 900, marginBottom: 8 }}>Partnerships</div>

      <div style={{ borderRadius: 12, border: `1px solid ${border}`, background: bg, padding: 10 }}>
        <div style={{ display: "grid", gap: 10 }}>
          {partnerships.map((p, idx) => (
            <div
              key={idx}
              style={{
                borderRadius: 10,
                border: `1px solid ${border}`,
                padding: 10,
                background: isLight ? "white" : "rgba(0,0,0,0.18)",
              }}
            >
              <div style={{ fontWeight: 900, marginBottom: 4 }}>
                Partnership {idx + 1}
              </div>
              <div style={{ color: subText, fontSize: 12 }}>
                {p.runs} runs • {p.balls} balls • from {p.startOver}{p.endOver ? ` - ${p.endOver}` : ""}{p.endedByWicket ? " • ended by wicket" : ""}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
