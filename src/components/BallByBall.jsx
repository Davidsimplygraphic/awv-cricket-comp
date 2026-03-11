import { isAdministrativeBall, isBattingSideWicket, sortBallsByPosition, sumRuns, toInt } from "../lib/scoring";

function getBallChipTone(ball) {
  const total = toInt(ball.runs_off_bat, 0) + toInt(ball.extra_runs, 0);

  if (ball.wicket) {
    return {
      background: "#b91c1c",
      color: "white",
      border: "1px solid rgba(127,29,29,0.95)",
    };
  }

  if (ball.extra_type) {
    return {
      background: "rgba(59,130,246,0.95)",
      color: "#0b1220",
      border: "1px solid rgba(147,197,253,0.35)",
    };
  }

  if (total === 4 || total === 6) {
    return {
      background: "rgba(34,197,94,0.95)",
      color: "#0b1220",
      border: "1px solid rgba(134,239,172,0.35)",
    };
  }

  if (total === 0) {
    return {
      background: "rgba(148,163,184,0.28)",
      color: "rgba(255,255,255,0.92)",
      border: "1px solid rgba(148,163,184,0.18)",
    };
  }

  return {
    background: "rgba(255,255,255,0.08)",
    color: "rgba(255,255,255,0.92)",
    border: "1px solid rgba(255,255,255,0.10)",
  };
}

function buildOverSummary(balls) {
  const wickets = balls.filter((ball) => isBattingSideWicket(ball)).length;
  const runs = sumRuns(balls);
  return wickets ? `${runs} runs - ${wickets} wicket${wickets === 1 ? "" : "s"}` : `${runs} runs`;
}

function BallChip({ ball }) {
  const total = toInt(ball.runs_off_bat, 0) + toInt(ball.extra_runs, 0);
  const tone = getBallChipTone(ball);

  return (
    <div
      title={`Over ${toInt(ball.over_no, 0) + 1}.${toInt(ball.delivery_in_over, 0)}${ball.extra_type ? ` - ${ball.extra_type}` : ""}`}
      style={{
        minWidth: 38,
        height: 38,
        padding: "0 10px",
        borderRadius: 999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontWeight: 900,
        fontSize: 14,
        background: tone.background,
        color: tone.color,
        border: tone.border,
      }}
    >
      {ball.wicket ? "W" : String(total)}
    </div>
  );
}

export default function BallByBall({ balls, groupByOver = false }) {
  const sorted = sortBallsByPosition((balls || []).filter((ball) => !isAdministrativeBall(ball)));

  if (!groupByOver) {
    const lastFiveOvers = (() => {
      if (!sorted.length) return [];
      const maxOver = toInt(sorted[sorted.length - 1].over_no, 0);
      const minOver = Math.max(0, maxOver - 4);
      return sorted.filter((ball) => toInt(ball.over_no, 0) >= minOver);
    })();

    return (
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {lastFiveOvers.map((ball) => (
          <BallChip
            key={`${ball.over_no}.${ball.delivery_in_over}.${ball.id || ball.source_event_id || ball.local_temp_id || ""}`}
            ball={ball}
          />
        ))}
      </div>
    );
  }

  const overs = [];
  const overMap = new Map();

  for (const ball of sorted) {
    const overNo = toInt(ball.over_no, 0);
    if (!overMap.has(overNo)) {
      const bucket = { overNo, balls: [] };
      overMap.set(overNo, bucket);
      overs.push(bucket);
    }
    overMap.get(overNo).balls.push(ball);
  }

  overs.sort((a, b) => b.overNo - a.overNo);

  return (
    <div style={{ display: "grid", gap: 12 }}>
      {overs.length ? (
        overs.map((over) => (
          <div
            key={`over-${over.overNo}`}
            style={{
              display: "grid",
              gap: 10,
              padding: "10px 12px",
              borderRadius: 14,
              border: "1px solid rgba(255,255,255,0.08)",
              background: "rgba(255,255,255,0.03)",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 10,
                flexWrap: "wrap",
                fontSize: 13,
                fontWeight: 900,
                color: "rgba(232,238,252,0.72)",
              }}
            >
              <span>Over {over.overNo + 1}</span>
              <span>{buildOverSummary(over.balls)}</span>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {over.balls.map((ball) => (
                <BallChip
                  key={`${ball.over_no}.${ball.delivery_in_over}.${ball.id || ball.source_event_id || ball.local_temp_id || ""}`}
                  ball={ball}
                />
              ))}
            </div>
          </div>
        ))
      ) : (
        <div style={{ fontSize: 13, color: "rgba(232,238,252,0.72)" }}>
          No commentary yet.
        </div>
      )}
    </div>
  );
}
