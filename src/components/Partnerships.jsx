import { selectPartnerships } from "../lib/scoring";

function partnershipPairLabel(partnership, playersById) {
  const strikerName = playersById?.[partnership.strikerId]?.name || "";
  const nonStrikerName = playersById?.[partnership.nonStrikerId]?.name || "";

  if (strikerName && nonStrikerName) return `${strikerName} & ${nonStrikerName}`;
  if (strikerName || nonStrikerName) return strikerName || nonStrikerName;
  return partnership.current ? "Current partnership" : "Partnership";
}

function partnershipEndLabel(partnership) {
  if (partnership.current) return "Current stand";
  if (partnership.endedByRetiredHurt) return `Overs ${partnership.startOver}-${partnership.endOver} | ended by retired hurt`;
  if (partnership.endedByWicket) return `Overs ${partnership.startOver}-${partnership.endOver} | ended by wicket`;
  return `Overs ${partnership.startOver}-${partnership.endOver}`;
}

function partnershipMetaStyle(partnership, subText) {
  if (partnership.endedByRetiredHurt) {
    return {
      color: "#fca5a5",
      fontWeight: 900,
    };
  }

  return {
    color: subText,
    fontWeight: 500,
  };
}

export default function Partnerships({ balls, playersById, theme = "dark", compact = false }) {
  const partnerships = selectPartnerships(balls);

  const isLight = theme === "light";
  const text = isLight ? "#0f172a" : "rgba(255,255,255,0.92)";
  const subText = isLight ? "rgba(15,23,42,0.70)" : "rgba(232,238,252,0.75)";
  const border = isLight ? "rgba(15,23,42,0.12)" : "rgba(255,255,255,0.10)";
  const bg = isLight ? "rgba(15,23,42,0.02)" : "rgba(255,255,255,0.04)";

  if (!partnerships.length) {
    return <div style={{ color: subText, fontSize: 13 }}>No partnerships yet.</div>;
  }

  const displayPartnerships = compact ? [...partnerships].reverse() : partnerships;

  if (compact) {
    return (
      <div style={{ display: "grid", gap: 10, color: text }}>
        <div style={{ fontWeight: 900, fontSize: 14 }}>Partnerships</div>
        {displayPartnerships.map((partnership, index) => (
          <div
            key={`${partnership.startOver}-${partnership.endOver}-${index}`}
            style={{
              display: "grid",
              gap: 10,
              borderRadius: 12,
              border: `1px solid ${partnership.current ? "rgba(56,189,248,0.28)" : border}`,
              background: partnership.current
                ? (isLight ? "rgba(56,189,248,0.08)" : "rgba(56,189,248,0.10)")
                : bg,
              padding: 12,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 4 }}>
                  <span
                    style={{
                      fontWeight: 900,
                      minWidth: 0,
                      display: "-webkit-box",
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: "vertical",
                      overflow: "hidden",
                    }}
                  >
                    {partnershipPairLabel(partnership, playersById)}
                  </span>
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 900,
                      borderRadius: 999,
                      padding: "2px 8px",
                      background: partnership.current
                        ? "rgba(56,189,248,0.18)"
                        : "rgba(255,255,255,0.08)",
                      color: partnership.current ? "#7dd3fc" : subText,
                    }}
                  >
                    {partnership.current ? "Live" : "Completed"}
                  </span>
                </div>
                <div style={{ fontSize: 12, ...partnershipMetaStyle(partnership, subText) }}>
                  {partnershipEndLabel(partnership)}
                </div>
              </div>

              <div style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                <div style={{ fontSize: 22, fontWeight: 1000, lineHeight: 1 }}>{partnership.runs}</div>
                <div style={{ fontSize: 12, color: subText }}>{partnership.balls} balls</div>
              </div>
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div style={{ fontSize: 13, color: text }}>
      <div style={{ fontWeight: 900, marginBottom: 8 }}>Partnerships</div>

      <div style={{ borderRadius: 12, border: `1px solid ${border}`, background: bg, padding: 10 }}>
        <div style={{ display: "grid", gap: 10 }}>
          {displayPartnerships.map((partnership, index) => (
            <div
              key={`${partnership.startOver}-${partnership.endOver}-${index}`}
              style={{
                borderRadius: 10,
                border: `1px solid ${border}`,
                padding: 10,
                background: isLight ? "white" : "rgba(0,0,0,0.18)",
              }}
            >
              <div style={{ fontWeight: 900, marginBottom: 4 }}>
                {partnershipPairLabel(partnership, playersById)}
              </div>
              <div style={{ fontSize: 12, ...partnershipMetaStyle(partnership, subText) }}>
                {partnership.runs} runs | {partnership.balls} balls | {partnershipEndLabel(partnership)}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
