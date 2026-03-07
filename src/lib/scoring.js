export const ADMIN_EXTRA_TYPE_RETIRED_HURT = "retiredhurt";

export function toInt(value, fallback = 0) {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
}

export function isAdministrativeBall(ball) {
  return ball?.extra_type === ADMIN_EXTRA_TYPE_RETIRED_HURT || ball?.dismissal_kind === "retired hurt";
}

export function isCompetitiveBall(ball) {
  return !isAdministrativeBall(ball);
}

export function sumRuns(balls) {
  return (balls || []).reduce((total, ball) => {
    if (isAdministrativeBall(ball)) return total;
    return total + toInt(ball?.runs_off_bat, 0) + toInt(ball?.extra_runs, 0);
  }, 0);
}

export function sumWkts(balls) {
  return (balls || []).reduce((total, ball) => {
    if (!ball?.wicket) return total;
    if (isAdministrativeBall(ball)) return total;
    return total + 1;
  }, 0);
}

export function legalBallsCount(balls) {
  return (balls || []).reduce((total, ball) => {
    if (isAdministrativeBall(ball)) return total;
    return total + (ball?.legal_ball !== false ? 1 : 0);
  }, 0);
}

export function oversTextFromLegal(legalBalls) {
  const overs = Math.floor(toInt(legalBalls, 0) / 6);
  const ballsInOver = toInt(legalBalls, 0) % 6;
  return `${overs}.${ballsInOver}`;
}

export function getOverBalls(balls, overNo) {
  return (balls || []).filter((ball) => toInt(ball?.over_no, 0) === toInt(overNo, 0) && !isAdministrativeBall(ball));
}

export function getOverCounts(balls, overNo) {
  const overBalls = getOverBalls(balls, overNo);
  const deliveries = overBalls.length;
  const legal = overBalls.filter((ball) => ball?.legal_ball !== false).length;
  const hasIllegal = overBalls.some((ball) => ball?.legal_ball === false);
  return { deliveries, legal, hasIllegal };
}

export function isOverFinished(counts) {
  if (!counts) return false;
  if (counts.hasIllegal) return counts.deliveries >= 7;
  return counts.legal >= 6;
}

export function computeNextPosition(balls) {
  const competitiveBalls = (balls || []).filter(isCompetitiveBall);

  if (!competitiveBalls.length) {
    return { over_no: 0, delivery_in_over: 1, counts: { deliveries: 0, legal: 0, hasIllegal: false }, newOver: true };
  }

  const lastBall = competitiveBalls[competitiveBalls.length - 1];
  const overNo = toInt(lastBall?.over_no, 0);
  const counts = getOverCounts(competitiveBalls, overNo);

  if (isOverFinished(counts)) {
    return {
      over_no: overNo + 1,
      delivery_in_over: 1,
      counts: { deliveries: 0, legal: 0, hasIllegal: false },
      newOver: true,
    };
  }

  const nextDelivery = Math.min(7, toInt(lastBall?.delivery_in_over, 0) + 1);

  if (nextDelivery > 7 || counts.deliveries >= 7) {
    return {
      over_no: overNo + 1,
      delivery_in_over: 1,
      counts: { deliveries: 0, legal: 0, hasIllegal: false },
      newOver: true,
    };
  }

  return { over_no: overNo, delivery_in_over: nextDelivery, counts, newOver: false };
}

export function sortBallsByPosition(balls) {
  return [...(balls || [])].sort((a, b) => {
    const overDiff = toInt(a?.over_no, 0) - toInt(b?.over_no, 0);
    if (overDiff !== 0) return overDiff;

    const deliveryDiff = toInt(a?.delivery_in_over, 0) - toInt(b?.delivery_in_over, 0);
    if (deliveryDiff !== 0) return deliveryDiff;

    const adminDiff = Number(isAdministrativeBall(a)) - Number(isAdministrativeBall(b));
    if (adminDiff !== 0) return adminDiff;

    const createdDiff = new Date(a?.created_at || 0).getTime() - new Date(b?.created_at || 0).getTime();
    if (createdDiff !== 0) return createdDiff;

    return String(a?.id || a?.source_event_id || a?.local_temp_id || "").localeCompare(
      String(b?.id || b?.source_event_id || b?.local_temp_id || "")
    );
  });
}

export function mergeBallIntoList(previousBalls, nextBall) {
  const filtered = (previousBalls || []).filter((ball) => {
    if (nextBall?.id && ball?.id === nextBall.id) return false;
    if (nextBall?.source_event_id && ball?.source_event_id === nextBall.source_event_id) return false;
    if (nextBall?.local_temp_id && ball?.local_temp_id === nextBall.local_temp_id) return false;
    return true;
  });

  return sortBallsByPosition([...filtered, nextBall]);
}

export function updateBallInList(previousBalls, target, patch) {
  return sortBallsByPosition(
    (previousBalls || []).map((ball) => (matchesBallTarget(ball, target) ? applyBallPatch(ball, patch) : ball))
  );
}

export function matchesBallTarget(ball, target) {
  if (!ball || !target) return false;
  if (target.id && ball.id === target.id) return true;
  if (target.source_event_id && ball.source_event_id === target.source_event_id) return true;
  if (target.local_temp_id && ball.local_temp_id === target.local_temp_id) return true;
  return false;
}

export function applyBallPatch(ball, patch) {
  if (!ball) return ball;

  const next = { ...ball };

  if (Object.prototype.hasOwnProperty.call(patch, "runs_off_bat")) next.runs_off_bat = toInt(patch.runs_off_bat, 0);
  if (Object.prototype.hasOwnProperty.call(patch, "extra_type")) next.extra_type = patch.extra_type || null;
  if (Object.prototype.hasOwnProperty.call(patch, "extra_runs")) next.extra_runs = Math.max(0, toInt(patch.extra_runs, 0));
  if (Object.prototype.hasOwnProperty.call(patch, "wicket")) next.wicket = !!patch.wicket;
  if (Object.prototype.hasOwnProperty.call(patch, "dismissal_kind")) next.dismissal_kind = patch.dismissal_kind || null;
  if (Object.prototype.hasOwnProperty.call(patch, "dismissed_player_id")) {
    next.dismissed_player_id = patch.dismissed_player_id || null;
  }

  if (next.extra_type === "wide" || next.extra_type === "bye" || next.extra_type === "legbye") {
    next.runs_off_bat = 0;
  }

  if (!next.wicket) {
    next.dismissal_kind = null;
    next.dismissed_player_id = null;
  }

  return next;
}

export function countLegalBallsBowledBy(balls, bowlerId) {
  return (balls || []).filter((ball) => ball?.bowler_id === bowlerId && !isAdministrativeBall(ball) && ball?.legal_ball !== false)
    .length;
}

export function buildInningsTotals(inningsRow, balls) {
  const legal = legalBallsCount(balls);
  return {
    inningsId: inningsRow?.id || null,
    completed: !!inningsRow?.completed,
    runs: sumRuns(balls),
    wkts: sumWkts(balls),
    legalBalls: legal,
    overs: oversTextFromLegal(legal),
    balls: balls || [],
  };
}

export function deriveMatchDisplayStatus({
  matchStatus,
  innings1Row,
  innings2Row,
  innings1Balls,
  innings2Balls,
  oversLimit,
  wicketCap,
}) {
  const raw = String(matchStatus || "").toLowerCase();
  const innings1 = buildInningsTotals(innings1Row, innings1Balls);
  const innings2 = buildInningsTotals(innings2Row, innings2Balls);
  const anyBalls = innings1.balls.length + innings2.balls.length > 0;
  const maxLegal = Math.max(1, toInt(oversLimit, 20)) * 6;
  const maxWickets = Math.max(1, toInt(wicketCap, 10));
  const innings2Started = innings2.balls.length > 0 || innings2.completed;
  const innings1Started = innings1.balls.length > 0 || innings1.completed;
  const innings2Exhausted = innings2Started && (innings2.completed || innings2.legalBalls >= maxLegal || innings2.wkts >= maxWickets);
  const inningsSuggestCompleted = innings1Started && innings2Started && innings2Exhausted;

  if (raw === "completed" && !anyBalls && !inningsSuggestCompleted) return "scheduled";
  if (raw === "completed" && !inningsSuggestCompleted) return anyBalls ? "live" : "scheduled";
  if (raw !== "completed" && inningsSuggestCompleted) return "completed";
  if ((raw === "scheduled" || !raw) && anyBalls) return "live";
  if (raw === "playing") return "live";
  return raw || "scheduled";
}

export function buildCompletedResultText({ matchStatus, innings1Team, innings2Team, innings1, innings2 }) {
  const status = String(matchStatus || "").toLowerCase();
  if (status !== "completed") return "";
  if (!innings1 || !innings2) return "";

  const innings1Started = (innings1.balls || []).length > 0 || innings1.completed;
  const innings2Started = (innings2.balls || []).length > 0 || innings2.completed;
  if (!innings1Started || !innings2Started) return "";

  if (innings1.runs === innings2.runs) return "Match tied";

  const winner = innings2.runs > innings1.runs ? innings2Team : innings1Team;
  const margin = Math.abs(innings2.runs - innings1.runs);
  const name = winner?.name || winner?.short_name || "Winning team";
  return `${name} won by ${margin} run${margin === 1 ? "" : "s"}`;
}
