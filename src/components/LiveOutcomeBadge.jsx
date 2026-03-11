const TONES = {
  wicket: {
    background: "rgba(185,28,28,0.96)",
    border: "1px solid rgba(254,202,202,0.30)",
    color: "#fff7f7",
  },
  boundary: {
    background: "rgba(22,163,74,0.94)",
    border: "1px solid rgba(187,247,208,0.28)",
    color: "#f0fdf4",
  },
  extra: {
    background: "rgba(37,99,235,0.94)",
    border: "1px solid rgba(191,219,254,0.28)",
    color: "#eff6ff",
  },
  dot: {
    background: "rgba(51,65,85,0.92)",
    border: "1px solid rgba(203,213,225,0.18)",
    color: "#f8fafc",
  },
  runs: {
    background: "rgba(15,23,42,0.92)",
    border: "1px solid rgba(255,255,255,0.16)",
    color: "#f8fafc",
  },
  success: {
    background: "rgba(22,163,74,0.94)",
    border: "1px solid rgba(187,247,208,0.28)",
    color: "#f0fdf4",
  },
  queued: {
    background: "rgba(37,99,235,0.94)",
    border: "1px solid rgba(191,219,254,0.28)",
    color: "#eff6ff",
  },
};

export default function LiveOutcomeBadge({ outcome, visible = false, style = {} }) {
  if (!outcome) return null;

  const tone = TONES[outcome.tone] || TONES.runs;

  return (
    <div
      aria-hidden={!visible}
      style={{
        pointerEvents: "none",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        minHeight: 34,
        padding: "7px 12px",
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 1000,
        letterSpacing: 0.6,
        textTransform: "uppercase",
        boxShadow: "0 10px 24px rgba(0,0,0,0.22)",
        opacity: visible ? 1 : 0,
        transform: visible ? "translateY(0) scale(1)" : "translateY(-6px) scale(0.96)",
        transition: "opacity 180ms ease, transform 180ms ease",
        ...tone,
        ...style,
      }}
    >
      {outcome.label}
    </div>
  );
}
