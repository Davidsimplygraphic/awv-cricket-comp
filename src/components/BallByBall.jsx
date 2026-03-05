function toInt(n, fallback = 0) {
  const x = Number(n);
  return Number.isFinite(x) ? x : fallback;
}

export default function BallByBall({ balls }) {
  const sorted = (balls || [])
    .slice()
    .sort((a, b) => (a.over_no - b.over_no) || (a.delivery_in_over - b.delivery_in_over) || 0);

  // last 5 overs by over_no
  const lastFive = (() => {
    if (!sorted.length) return [];
    const maxOver = sorted[sorted.length - 1].over_no;
    const minOver = Math.max(1, maxOver - 4);
    return sorted.filter((b) => b.over_no >= minOver);
  })();

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
      {lastFive.map((b) => {
        const total = toInt(b.runs_off_bat, 0) + toInt(b.extra_runs, 0);
        const value = b.wicket ? "W" : String(total);

        let bg = "rgba(255,255,255,0.06)";
        let fg = "#000";
        let border = "1px solid rgba(0,0,0,0.10)";

        if (b.wicket) {
          bg = "#c7003f";
          fg = "white";
          border = "1px solid rgba(0,0,0,0.20)";
        } else if (total === 4) {
          bg = "#15dbf9";
          fg = "#0B1220";
        } else if (total === 6) {
          bg = "#24d657";
          fg = "#0B1220";
        }

        return (
          <div
            key={`${b.over_no}.${b.delivery_in_over}.${b.id || ""}`}
            title={`Over ${b.over_no}.${b.delivery_in_over}${b.extra_type ? ` • ${b.extra_type}` : ""}`}
            style={{
              width: 36,
              height: 36,
              borderRadius: 10,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontWeight: 900,
              fontSize: 13,
              background: bg,
              color: fg,
              border: border,
            }}
          >
            {value}
          </div>
        );
      })}
    </div>
  );
}