export const ADMIN_EXTRA_TYPE_RETIRED_HURT = "retiredhurt";
export const LEGACY_ADD_BALL_EVENT_TYPE = "add_ball";
export const DELIVERY_RECORDED_EVENT_TYPE = "delivery_recorded";
export const ADMINISTRATIVE_STATE_CHANGED_EVENT_TYPE = "administrative_state_changed";

export function toInt(value, fallback = 0) {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
}

export function resolveWicketCap(value, fallback = 10) {
  const normalizedFallback = (() => {
    if (fallback === null || fallback === undefined || fallback === "") return 10;
    const next = Number(fallback);
    return Number.isFinite(next) && next > 0 ? next : 10;
  })();

  if (value === null || value === undefined || value === "") {
    return normalizedFallback;
  }

  const next = Number(value);
  if (!Number.isFinite(next)) return normalizedFallback;
  return Math.max(1, next);
}

export function deriveRosterWicketCap(players = [], teamIds = []) {
  const relevantTeams = new Set((teamIds || []).filter(Boolean));
  if (!relevantTeams.size) return null;

  const counts = new Map();
  for (const player of players || []) {
    if (!player?.team_id || !relevantTeams.has(player.team_id)) continue;
    if (player?.active === false) continue;
    counts.set(player.team_id, (counts.get(player.team_id) || 0) + 1);
  }

  const maxPlayers = Math.max(...[...relevantTeams].map((teamId) => counts.get(teamId) || 0));
  return maxPlayers > 0 ? Math.max(1, maxPlayers - 1) : null;
}

export function resolveDisplayWicketCap({
  fixtureWicketCap = null,
  matchWicketCap = null,
  rosterWicketCap = null,
  fallback = 10,
} = {}) {
  const preferred = fixtureWicketCap ?? matchWicketCap ?? rosterWicketCap;
  return resolveWicketCap(preferred, rosterWicketCap ?? fallback);
}

export function isAdministrativeBall(ball) {
  return ball?.extra_type === ADMIN_EXTRA_TYPE_RETIRED_HURT || ball?.dismissal_kind === "retired hurt";
}

export function isBattingSideWicket(ball) {
  if (!ball?.wicket) return false;
  if (isAdministrativeBall(ball)) return false;

  const dismissalKind = String(ball?.dismissal_kind || "").trim().toLowerCase();
  if (dismissalKind === "retired hurt") return false;

  return true;
}

export function isBowlerCreditedDismissalKind(kind) {
  const dismissalKind = String(kind || "").trim().toLowerCase();

  if (!dismissalKind) return true;
  if (dismissalKind === "run out" || dismissalKind === "retired hurt") return false;
  if (
    dismissalKind === "bowled"
    || dismissalKind === "caught"
    || dismissalKind === "lbw"
    || dismissalKind === "hit wicket"
    || dismissalKind === "stumped"
  ) {
    return true;
  }

  // Preserve historical/legacy scorecards unless an explicit exception is known.
  return true;
}

export function isBowlerCreditedWicket(ball) {
  if (!isBattingSideWicket(ball)) return false;
  return isBowlerCreditedDismissalKind(ball?.dismissal_kind);
}

export function isDeliveryEventType(eventType) {
  return eventType === LEGACY_ADD_BALL_EVENT_TYPE || eventType === DELIVERY_RECORDED_EVENT_TYPE;
}

export function normalizeDeliveryValues({
  runsOffBat = 0,
  extraType = null,
  extraRuns = 0,
} = {}) {
  const normalizedExtraType = extraType || null;
  let normalizedRunsOffBat = Math.max(0, toInt(runsOffBat, 0));
  let normalizedExtraRuns = 0;

  if (normalizedExtraType === "wide") {
    normalizedRunsOffBat = 0;
    normalizedExtraRuns = Math.max(2, toInt(extraRuns, 2));
  } else if (normalizedExtraType === "noball") {
    normalizedExtraRuns = Math.max(1, toInt(extraRuns, 1));
  } else if (normalizedExtraType === "bye" || normalizedExtraType === "legbye") {
    normalizedRunsOffBat = 0;
    normalizedExtraRuns = Math.max(0, toInt(extraRuns, 0));
  } else {
    normalizedExtraRuns = 0;
  }

  return {
    runsOffBat: normalizedRunsOffBat,
    extraType: normalizedExtraType,
    extraRuns: normalizedExtraRuns,
  };
}

export function normalizeDeliveryOutcome({
  runsOffBat = 0,
  extraType = null,
  extraRuns = 0,
  priorOverBalls = [],
} = {}) {
  const normalized = normalizeDeliveryValues({ runsOffBat, extraType, extraRuns });
  return {
    ...normalized,
    legalBall: deriveLegalBallForExtraType(normalized.extraType, priorOverBalls),
  };
}

export function validateWicketDeliveryInput({
  dismissalKind = "bowled",
  runsOffBat = 0,
  extraType = null,
  extraRuns = 0,
} = {}) {
  const normalizedKind = String(dismissalKind || "bowled").trim().toLowerCase();
  const normalized = normalizeDeliveryValues({ runsOffBat, extraType, extraRuns });

  if (normalizedKind === "retired hurt") {
    return {
      ok: false,
      message: 'Use "administrative_state_changed" for retired hurt. It is not a delivery event.',
      ...normalized,
      dismissalKind: normalizedKind,
    };
  }

  if (normalizedKind === "run out") {
    return {
      ok: true,
      ...normalized,
      dismissalKind: normalizedKind,
    };
  }

  if (normalizedKind === "stumped") {
    if (normalized.runsOffBat > 0) {
      return {
        ok: false,
        message: "Stumped deliveries cannot include completed bat runs in the current model.",
        ...normalized,
        dismissalKind: normalizedKind,
      };
    }

    if (normalized.extraType && normalized.extraType !== "wide") {
      return {
        ok: false,
        message: "Only a base wide is supported as an extra on a stumped delivery in the current model.",
        ...normalized,
        dismissalKind: normalizedKind,
      };
    }

    if (normalized.extraType === "wide" && normalized.extraRuns !== 2) {
      return {
        ok: false,
        message: "Stumped wides cannot include completed runs in the current model.",
        ...normalized,
        dismissalKind: normalizedKind,
      };
    }

    return {
      ok: true,
      ...normalized,
      dismissalKind: normalizedKind,
    };
  }

  if (normalized.runsOffBat > 0) {
    return {
      ok: false,
      message: "Only run out deliveries can include completed bat runs with a wicket.",
      ...normalized,
      dismissalKind: normalizedKind,
    };
  }

  if (normalized.extraType || normalized.extraRuns > 0) {
    return {
      ok: false,
      message: "Only run out deliveries currently support wicket-plus-extras.",
      ...normalized,
      dismissalKind: normalizedKind,
    };
  }

  return {
    ok: true,
    ...normalized,
    dismissalKind: normalizedKind,
  };
}

export function deriveWicketPostState({
  strikerId = "",
  nonStrikerId = "",
  incomingBatterId = "",
  dismissedPlayerId = "",
  dismissalKind = "bowled",
  totalRunsOnBall = 0,
  crossed = false,
  overFinishedAfter = false,
  inningsComplete = false,
  bowlerId = "",
  getTurnFor = () => 1,
} = {}) {
  const normalizedKind = String(dismissalKind || "bowled").trim().toLowerCase();
  const normalizedRuns = Math.max(0, toInt(totalRunsOnBall, 0));
  const outWasStriker = dismissedPlayerId === strikerId;

  if (!dismissedPlayerId || (dismissedPlayerId !== strikerId && dismissedPlayerId !== nonStrikerId)) {
    throw new Error("Dismissed player must match the current striker or non-striker.");
  }

  if (!inningsComplete && !incomingBatterId) {
    throw new Error("An incoming batter is required for wicket events before the innings is complete.");
  }

  let nextStrikerId = strikerId;
  let nextNonStrikerId = nonStrikerId;
  let nextBowlerId = bowlerId;
  let needsNextBowler = false;

  if (normalizedKind === "run out") {
    const postRunStrikerId = normalizedRuns % 2 === 1 ? nonStrikerId : strikerId;
    const postRunNonStrikerId = normalizedRuns % 2 === 1 ? strikerId : nonStrikerId;

    nextStrikerId = postRunStrikerId;
    nextNonStrikerId = postRunNonStrikerId;

    if (!inningsComplete) {
      if (dismissedPlayerId === postRunStrikerId) {
        nextStrikerId = incomingBatterId;
      } else if (dismissedPlayerId === postRunNonStrikerId) {
        nextNonStrikerId = incomingBatterId;
      } else {
        throw new Error("Run-out dismissal did not resolve to a current batting end.");
      }
    }

    if (overFinishedAfter && !inningsComplete) {
      [nextStrikerId, nextNonStrikerId] = [nextNonStrikerId, nextStrikerId];
      nextBowlerId = "";
      needsNextBowler = true;
    }
  } else {
    const survivorId = outWasStriker ? nonStrikerId : strikerId;
    const crossedApplies = crossed && outWasStriker;

    if (overFinishedAfter && !inningsComplete) {
      if (outWasStriker) {
        if (crossedApplies) {
          nextStrikerId = survivorId;
          nextNonStrikerId = incomingBatterId;
        } else {
          nextStrikerId = incomingBatterId;
          nextNonStrikerId = survivorId;
        }
      } else {
        nextStrikerId = strikerId;
        nextNonStrikerId = incomingBatterId;
      }
      nextBowlerId = "";
      needsNextBowler = true;
    } else if (outWasStriker) {
      if (crossedApplies) {
        nextStrikerId = survivorId;
        nextNonStrikerId = incomingBatterId;
      } else {
        nextStrikerId = incomingBatterId;
        nextNonStrikerId = survivorId;
      }
    } else {
      nextStrikerId = strikerId;
      nextNonStrikerId = incomingBatterId;
    }
  }

  return buildScorerPostState({
    strikerId: inningsComplete ? strikerId : nextStrikerId,
    nonStrikerId: inningsComplete ? nonStrikerId : nextNonStrikerId,
    strikerTurn: getTurnFor(inningsComplete ? strikerId : nextStrikerId),
    nonStrikerTurn: getTurnFor(inningsComplete ? nonStrikerId : nextNonStrikerId),
    bowlerId: inningsComplete ? bowlerId : nextBowlerId,
    needsNextBowler: inningsComplete ? false : needsNextBowler,
  });
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

export function runsConcededByBowler(ball) {
  if (isAdministrativeBall(ball)) return 0;

  const batRuns = toInt(ball?.runs_off_bat, 0);
  const extraRuns = toInt(ball?.extra_runs, 0);

  if (ball?.extra_type === "bye" || ball?.extra_type === "legbye") {
    return batRuns;
  }

  return batRuns + extraRuns;
}

export function didBatterFaceBall(ball) {
  if (isAdministrativeBall(ball)) return false;
  return ball?.extra_type !== "wide" && ball?.is_wide !== true;
}

export function deriveLegalBallForExtraType(extraType, priorOverBalls = []) {
  const normalizedExtraType = extraType || null;
  const overAlreadyHadIllegal = (priorOverBalls || []).some(
    (ball) => !isAdministrativeBall(ball) && ball?.legal_ball === false
  );

  if (normalizedExtraType === "wide" || normalizedExtraType === "noball") {
    return overAlreadyHadIllegal;
  }

  return true;
}

export function sumWkts(balls) {
  return (balls || []).reduce((total, ball) => {
    return total + (isBattingSideWicket(ball) ? 1 : 0);
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

export function ballVersionValue(ball) {
  const value = ball?.updated_at || ball?.created_at || 0;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function preferNewerBall(existingBall, incomingBall) {
  if (!existingBall) return incomingBall;
  if (!incomingBall) return existingBall;

  const existingVersion = ballVersionValue(existingBall);
  const incomingVersion = ballVersionValue(incomingBall);

  if (incomingVersion > existingVersion) return incomingBall;
  if (incomingVersion < existingVersion) return existingBall;

  if (!existingBall?.id && incomingBall?.id) return incomingBall;
  if (existingBall?.id && !incomingBall?.id) return existingBall;

  return incomingBall;
}

export function mergeBallIntoList(previousBalls, nextBall) {
  const existingBall = (previousBalls || []).find((ball) => (
    (nextBall?.id && ball?.id === nextBall.id)
      || (nextBall?.source_event_id && ball?.source_event_id === nextBall.source_event_id)
      || (nextBall?.local_temp_id && ball?.local_temp_id === nextBall.local_temp_id)
  ));
  const filtered = (previousBalls || []).filter((ball) => {
    if (nextBall?.id && ball?.id === nextBall.id) return false;
    if (nextBall?.source_event_id && ball?.source_event_id === nextBall.source_event_id) return false;
    if (nextBall?.local_temp_id && ball?.local_temp_id === nextBall.local_temp_id) return false;
    return true;
  });

  return sortBallsByPosition([...filtered, preferNewerBall(existingBall, nextBall)]);
}

export function buildScorerPostState({
  strikerId = "",
  nonStrikerId = "",
  strikerTurn = 1,
  nonStrikerTurn = 1,
  bowlerId = "",
  needsNextBowler = false,
} = {}) {
  return {
    striker_id: strikerId || null,
    non_striker_id: nonStrikerId || null,
    striker_turn: toInt(strikerTurn, 1) || 1,
    non_striker_turn: toInt(nonStrikerTurn, 1) || 1,
    bowler_id: bowlerId || null,
    needs_next_bowler: !!needsNextBowler,
  };
}

export function updateBallInList(previousBalls, target, patch) {
  return sortBallsByPosition(
    (previousBalls || []).map((ball) => (
      matchesBallTarget(ball, target) ? applyBallPatch(ball, patch, previousBalls || []) : ball
    ))
  );
}

export function matchesBallTarget(ball, target) {
  if (!ball || !target) return false;
  if (target.id && ball.id === target.id) return true;
  if (target.source_event_id && ball.source_event_id === target.source_event_id) return true;
  if (target.local_temp_id && ball.local_temp_id === target.local_temp_id) return true;
  return false;
}

export function applyBallPatch(ball, patch, allBalls = []) {
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

  const normalized = normalizeDeliveryValues({
    runsOffBat: next.runs_off_bat,
    extraType: next.extra_type,
    extraRuns: next.extra_runs,
  });
  next.runs_off_bat = normalized.runsOffBat;
  next.extra_type = normalized.extraType;
  next.extra_runs = normalized.extraRuns;

  if (!next.wicket) {
    next.dismissal_kind = null;
    next.dismissed_player_id = null;
  }

  const target = {
    id: ball.id || null,
    source_event_id: ball.source_event_id || null,
    local_temp_id: ball.local_temp_id || null,
  };
  const priorOverBalls = (allBalls || []).filter((candidate) => {
    if (!candidate || matchesBallTarget(candidate, target)) return false;
    if (toInt(candidate?.over_no, 0) !== toInt(ball?.over_no, 0)) return false;
    return toInt(candidate?.delivery_in_over, 0) < toInt(ball?.delivery_in_over, 0);
  });
  next.legal_ball = deriveLegalBallForExtraType(next.extra_type, priorOverBalls);

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

export function selectInningsSummary(balls) {
  const totals = buildInningsTotals(null, balls);
  return {
    runs: totals.runs,
    wkts: totals.wkts,
    legalBalls: totals.legalBalls,
    oversText: totals.overs,
  };
}

export function selectWormSeries(balls) {
  const sorted = sortBallsByPosition(balls);
  let cumulativeRuns = 0;
  let cumulativeLegalBalls = 0;
  const points = [{ x: 0, y: 0 }];

  for (const ball of sorted) {
    cumulativeRuns += sumRuns([ball]);
    cumulativeLegalBalls += legalBallsCount([ball]);
    points.push({ x: cumulativeLegalBalls, y: cumulativeRuns });
  }

  return points;
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
  const maxWickets = resolveWicketCap(wicketCap, 10);
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

export function buildCompletedResultText({ matchStatus, innings1Team, innings2Team, innings1, innings2, wicketCap }) {
  const status = String(matchStatus || "").toLowerCase();
  if (status !== "completed") return "";
  if (!innings1 || !innings2) return "";

  const innings1Started = (innings1.balls || []).length > 0 || innings1.completed;
  const innings2Started = (innings2.balls || []).length > 0 || innings2.completed;
  if (!innings1Started || !innings2Started) return "";

  if (innings1.runs === innings2.runs) return "Match tied";

  if (innings2.runs > innings1.runs) {
    const wicketsRemaining = Math.max(0, resolveWicketCap(wicketCap, 10) - toInt(innings2.wkts, 0));
    const name = innings2Team?.name || innings2Team?.short_name || "Winning team";
    return `${name} won by ${wicketsRemaining} wicket${wicketsRemaining === 1 ? "" : "s"}`;
  }

  const margin = Math.abs(innings2.runs - innings1.runs);
  const name = innings1Team?.name || innings1Team?.short_name || "Winning team";
  return `${name} won by ${margin} run${margin === 1 ? "" : "s"}`;
}
