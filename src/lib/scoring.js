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

export function isChaseCompleteForScoring({
  inningsNo = 1,
  innings1Ready = false,
  innings1Runs = 0,
  totalRuns = 0,
  reopenedForContinuation = false,
} = {}) {
  if (inningsNo !== 2) return false;
  if (!innings1Ready) return false;
  if (reopenedForContinuation) return false;
  return toInt(totalRuns, 0) >= (toInt(innings1Runs, 0) + 1);
}

export function isAdministrativeBall(ball) {
  return ball?.extra_type === ADMIN_EXTRA_TYPE_RETIRED_HURT || ball?.dismissal_kind === "retired hurt";
}

export function isRetiredHurtBall(ball) {
  return isAdministrativeBall(ball) && String(ball?.dismissal_kind || "").trim().toLowerCase() === "retired hurt";
}

export function isBattingSideWicket(ball) {
  if (!ball?.wicket) return false;
  if (isAdministrativeBall(ball)) return false;

  const dismissalKind = String(ball?.dismissal_kind || "").trim().toLowerCase();
  if (dismissalKind === "retired hurt") return false;

  return true;
}

export function isPartnershipBreak(ball) {
  return isBattingSideWicket(ball) || isRetiredHurtBall(ball);
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

function inferIncomingBatterFromPostState(originalBall, preEditPostState) {
  if (!originalBall || !preEditPostState || typeof preEditPostState !== "object") return null;

  const preBallIds = new Set([originalBall.striker_id, originalBall.non_striker_id].filter(Boolean));
  const postBallIds = [preEditPostState.striker_id, preEditPostState.non_striker_id].filter(Boolean);
  const incoming = postBallIds.filter((playerId) => !preBallIds.has(playerId));

  if (incoming.length !== 1) return null;
  return incoming[0];
}

function inferCrossedFromPostState(originalBall, preEditPostState, incomingBatterId) {
  if (!originalBall || !preEditPostState || !incomingBatterId) return null;
  if (originalBall.dismissed_player_id !== originalBall.striker_id) return false;

  const survivorId = originalBall.non_striker_id || "";
  const postStrikerId = preEditPostState.striker_id || "";
  const postNonStrikerId = preEditPostState.non_striker_id || "";

  if (postStrikerId === incomingBatterId && postNonStrikerId === survivorId) return false;
  if (postStrikerId === survivorId && postNonStrikerId === incomingBatterId) return true;
  return null;
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

export function reconcileLatestBallEditSelectionState({
  originalBall = null,
  editedBall = null,
  ballsAfterEdit = [],
  preEditPostState = null,
  inningsCompleted = false,
} = {}) {
  if (!originalBall || !editedBall) {
    return {
      strikerId: "",
      nonStrikerId: "",
      bowlerId: "",
      needsNextBowler: false,
      battingAmbiguous: true,
      bowlerAmbiguous: true,
    };
  }

  const overFinishedAfter = isOverFinished(getOverCounts(ballsAfterEdit || [], editedBall.over_no));
  const bowlerId = !inningsCompleted && overFinishedAfter
    ? ""
    : (editedBall.bowler_id || originalBall.bowler_id || preEditPostState?.bowler_id || "");
  const needsNextBowler = !inningsCompleted && overFinishedAfter;
  // No ball penalty run (extra_runs=1) doesn't represent physical running, exclude from rotation.
  const totalRunsOnBall = editedBall.extra_type === "noball"
    ? toInt(editedBall.runs_off_bat, 0)
    : toInt(editedBall.runs_off_bat, 0) + toInt(editedBall.extra_runs, 0);

  const resolved = {
    strikerId: "",
    nonStrikerId: "",
    bowlerId,
    needsNextBowler,
    battingAmbiguous: false,
    bowlerAmbiguous: false,
  };

  if (!editedBall.wicket) {
    let nextStrikerId = originalBall.striker_id || "";
    let nextNonStrikerId = originalBall.non_striker_id || "";

    if (totalRunsOnBall % 2 === 1) {
      [nextStrikerId, nextNonStrikerId] = [nextNonStrikerId, nextStrikerId];
    }

    if (!inningsCompleted && overFinishedAfter) {
      [nextStrikerId, nextNonStrikerId] = [nextNonStrikerId, nextStrikerId];
    }

    resolved.strikerId = nextStrikerId;
    resolved.nonStrikerId = nextNonStrikerId;
    return resolved;
  }

  if (inningsCompleted) {
    resolved.strikerId = preEditPostState?.striker_id || originalBall.striker_id || "";
    resolved.nonStrikerId = preEditPostState?.non_striker_id || originalBall.non_striker_id || "";
    return resolved;
  }

  if (!originalBall.wicket) {
    resolved.battingAmbiguous = true;
    return resolved;
  }

  const incomingBatterId = inferIncomingBatterFromPostState(originalBall, preEditPostState);
  if (!incomingBatterId) {
    resolved.battingAmbiguous = true;
    return resolved;
  }

  const dismissalKind = String(editedBall.dismissal_kind || originalBall.dismissal_kind || "bowled").trim().toLowerCase();
  const dismissedPlayerId = editedBall.dismissed_player_id || originalBall.dismissed_player_id || originalBall.striker_id || "";

  let crossed = false;
  if (dismissalKind !== "run out" && dismissedPlayerId === originalBall.striker_id) {
    const originalDismissalKind = String(originalBall.dismissal_kind || "").trim().toLowerCase();
    if (originalDismissalKind === "run out" || !originalDismissalKind) {
      resolved.battingAmbiguous = true;
      return resolved;
    }

    const inferredCrossed = inferCrossedFromPostState(originalBall, preEditPostState, incomingBatterId);
    if (inferredCrossed === null) {
      resolved.battingAmbiguous = true;
      return resolved;
    }
    crossed = inferredCrossed;
  }

  const wicketPostState = deriveWicketPostState({
    strikerId: originalBall.striker_id || "",
    nonStrikerId: originalBall.non_striker_id || "",
    incomingBatterId,
    dismissedPlayerId,
    dismissalKind,
    totalRunsOnBall,
    crossed,
    overFinishedAfter,
    inningsComplete: false,
    bowlerId: editedBall.bowler_id || originalBall.bowler_id || "",
    getTurnFor: () => 1,
  });

  resolved.strikerId = wicketPostState.striker_id || "";
  resolved.nonStrikerId = wicketPostState.non_striker_id || "";
  resolved.bowlerId = wicketPostState.bowler_id || resolved.bowlerId;
  resolved.needsNextBowler = !!wicketPostState.needs_next_bowler;
  return resolved;
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

export function countDismissalsForPlayer(balls, playerId) {
  if (!playerId) return 0;

  return sortBallsByPosition(balls).reduce((total, ball) => {
    if (!isBattingSideWicket(ball)) return total;
    return total + (ball?.dismissed_player_id === playerId ? 1 : 0);
  }, 0);
}

export function countBattingExitsForPlayer(balls, playerId) {
  if (!playerId) return 0;

  return sortBallsByPosition(balls).reduce((total, ball) => {
    if (!ball?.wicket || ball?.dismissed_player_id !== playerId) return total;
    return total + 1;
  }, 0);
}

export function selectBatterStatus({
  balls = [],
  playerId = "",
  turn = 1,
  isAtCrease = false,
} = {}) {
  if (!playerId) return { label: "", tone: "idle" };
  if (isAtCrease) return { label: "Not out", tone: "not_out" };

  const exitEvents = sortBallsByPosition(balls).filter((ball) => (
    ball?.wicket && ball?.dismissed_player_id === playerId
  ));
  const exitEvent = exitEvents[Math.max(0, toInt(turn, 1) - 1)] || null;

  if (!exitEvent) return { label: "Not out", tone: "not_out" };
  if (isRetiredHurtBall(exitEvent)) return { label: "Retired Hurt", tone: "retired_hurt" };
  return { label: "Out", tone: "out" };
}

export function materializeAdministrativeStateBalls({
  balls = [],
  sessionEvents = [],
} = {}) {
  const competitiveBalls = sortBallsByPosition(balls);
  const adminEvents = [...(sessionEvents || [])]
    .filter((event, index, list) => {
      if (!event?.event_id) return false;
      return list.findIndex((candidate) => candidate?.event_id === event.event_id) === index;
    })
    .filter((event) => event?.event_type === ADMINISTRATIVE_STATE_CHANGED_EVENT_TYPE)
    .sort((a, b) => {
      const appliedDiff = new Date(a?.applied_at || a?.created_at || 0).getTime()
        - new Date(b?.applied_at || b?.created_at || 0).getTime();
      if (appliedDiff !== 0) return appliedDiff;
      return String(a?.event_id || "").localeCompare(String(b?.event_id || ""));
    });

  if (!adminEvents.length) return competitiveBalls;

  let ballCursor = 0;
  let anchorBall = competitiveBalls[0] || null;
  const adminBalls = [];

  for (const event of adminEvents) {
    const payload = event?.payload && typeof event.payload === "object" ? event.payload : {};
    const result = event?.result && typeof event.result === "object" ? event.result : {};
    const actionType = String(
      payload?.action_type
      || result?.administrative_state?.action_type
      || ""
    ).trim().toLowerCase();

    if (actionType !== "retired_hurt") continue;

    const eventTime = new Date(event?.applied_at || event?.created_at || 0).getTime();
    while (ballCursor < competitiveBalls.length) {
      const candidate = competitiveBalls[ballCursor];
      const candidateTime = new Date(candidate?.created_at || 0).getTime();
      if (candidateTime > eventTime) break;
      anchorBall = candidate;
      ballCursor += 1;
    }

    if (!anchorBall) continue;

    const postState = result?.post_state || payload?.post_state || {};
    adminBalls.push({
      id: null,
      source_event_id: event.event_id,
      local_temp_id: event.event_id,
      created_at: event?.applied_at || event?.created_at || new Date().toISOString(),
      over_no: anchorBall.over_no,
      delivery_in_over: anchorBall.delivery_in_over,
      striker_id: postState?.striker_id || null,
      non_striker_id: postState?.non_striker_id || null,
      bowler_id: postState?.bowler_id || anchorBall.bowler_id || null,
      batting_turn: null,
      wicket: true,
      dismissal_kind: "retired hurt",
      dismissed_player_id: payload?.dismissed_player_id
        || result?.administrative_state?.dismissed_player_id
        || null,
      extra_type: ADMIN_EXTRA_TYPE_RETIRED_HURT,
      extra_runs: 0,
      runs_off_bat: 0,
      legal_ball: false,
    });
  }

  return sortBallsByPosition([...competitiveBalls, ...adminBalls]);
}

export function selectPartnerships(balls = []) {
  const sorted = sortBallsByPosition(balls);
  const partnerships = [];
  let startBall = null;
  let lastCompetitiveBall = null;
  let pair = null;
  let standBalls = [];

  const overText = (ball) => {
    const over = toInt(ball?.over_no, 0) + 1;
    const delivery = toInt(ball?.delivery_in_over, 0);
    return `${over}.${delivery}`;
  };

  const flushStand = ({ endBall, endedByWicket = false, endedByRetiredHurt = false, current = false } = {}) => {
    if (!startBall || !standBalls.length || !endBall) return;

    partnerships.push({
      runs: sumRuns(standBalls),
      balls: legalBallsCount(standBalls),
      startOver: overText(startBall),
      endOver: overText(endBall),
      endedByWicket,
      endedByRetiredHurt,
      current,
      ...pair,
    });
  };

  for (const ball of sorted) {
    if (!isAdministrativeBall(ball)) {
      if (!startBall) startBall = ball;
      if (!pair) {
        pair = {
          strikerId: ball.striker_id || null,
          nonStrikerId: ball.non_striker_id || null,
        };
      }

      standBalls.push(ball);
      lastCompetitiveBall = ball;
    }

    if (!startBall || !isPartnershipBreak(ball)) continue;

    flushStand({
      endBall: ball,
      endedByWicket: isBattingSideWicket(ball),
      endedByRetiredHurt: isRetiredHurtBall(ball),
      current: false,
    });

    startBall = null;
    lastCompetitiveBall = null;
    pair = null;
    standBalls = [];
  }

  flushStand({ endBall: lastCompetitiveBall, current: true });
  return partnerships;
}

export function selectCurrentPartnership(balls = []) {
  const partnerships = selectPartnerships(balls);
  const current = partnerships.at(-1);
  return current?.current ? current : null;
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

export function formatBallOutcomeToken(ball) {
  if (!ball || isAdministrativeBall(ball)) return "";
  if (ball.wicket) return "W";

  const totalRuns = toInt(ball?.runs_off_bat, 0) + toInt(ball?.extra_runs, 0);
  const extraType = String(ball?.extra_type || "").toLowerCase();

  if (extraType === "wide") return totalRuns > 2 ? `Wd${totalRuns}` : "Wd";
  if (extraType === "noball") {
    const batRuns = toInt(ball?.runs_off_bat, 0);
    return batRuns > 0 ? `Nb+${batRuns}` : "Nb";
  }
  if (extraType === "bye") return `B${Math.max(1, toInt(ball?.extra_runs, 0))}`;
  if (extraType === "legbye") return `Lb${Math.max(1, toInt(ball?.extra_runs, 0))}`;

  return String(totalRuns);
}

export function describeBallOutcomeBadge(ball) {
  if (!ball || isAdministrativeBall(ball)) return null;

  const totalRuns = toInt(ball?.runs_off_bat, 0) + toInt(ball?.extra_runs, 0);
  const extraType = String(ball?.extra_type || "").toLowerCase();

  if (ball.wicket) return { label: "WICKET", tone: "wicket" };
  if (extraType === "wide") return { label: "WIDE", tone: "extra" };
  if (extraType === "noball") return { label: "NO BALL", tone: "extra" };
  if (extraType === "bye") return { label: "BYE", tone: "extra" };
  if (extraType === "legbye") return { label: "LEG BYE", tone: "extra" };
  if (toInt(ball?.runs_off_bat, 0) === 6) return { label: "SIX", tone: "boundary" };
  if (toInt(ball?.runs_off_bat, 0) === 4) return { label: "FOUR", tone: "boundary" };
  if (totalRuns === 0) return { label: "DOT", tone: "dot" };
  return { label: `${totalRuns} RUN${totalRuns === 1 ? "" : "S"}`, tone: "runs" };
}

export function selectOverSummaries(balls) {
  const sorted = sortBallsByPosition((balls || []).filter((ball) => !isAdministrativeBall(ball)));
  const overMap = new Map();
  const overs = [];

  for (const ball of sorted) {
    const overNo = toInt(ball?.over_no, 0);
    if (!overMap.has(overNo)) {
      const summary = {
        overNo,
        balls: [],
      };
      overMap.set(overNo, summary);
      overs.push(summary);
    }
    overMap.get(overNo).balls.push(ball);
  }

  return overs.map((summary) => ({
    ...summary,
    runs: sumRuns(summary.balls),
    wickets: sumWkts(summary.balls),
    legalBalls: legalBallsCount(summary.balls),
  }));
}

export function selectCurrentOverSummary(balls) {
  const overs = selectOverSummaries(balls);
  return overs.length ? overs[overs.length - 1] : null;
}

export function formatOverSummaryText(summary) {
  if (!summary) return "";
  return summary.wickets
    ? `${summary.runs} runs • ${summary.wickets} wicket${summary.wickets === 1 ? "" : "s"}`
    : `${summary.runs} runs`;
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

export function selectWormWicketPoints(balls) {
  const sorted = sortBallsByPosition(balls);
  let cumulativeRuns = 0;
  let cumulativeLegalBalls = 0;
  const points = [];

  for (const ball of sorted) {
    cumulativeRuns += sumRuns([ball]);
    cumulativeLegalBalls += legalBallsCount([ball]);

    if (!isBattingSideWicket(ball)) continue;

    points.push({
      key: ball?.id || ball?.source_event_id || ball?.local_temp_id || `${toInt(ball?.over_no, 0)}-${toInt(ball?.delivery_in_over, 0)}`,
      x: cumulativeLegalBalls,
      y: cumulativeRuns,
      overNo: toInt(ball?.over_no, 0),
      deliveryInOver: toInt(ball?.delivery_in_over, 0),
      dismissedPlayerId: ball?.dismissed_player_id || null,
      dismissalKind: ball?.dismissal_kind || null,
    });
  }

  return points;
}

export function selectOverBoundaryTicks({ balls = [], maxOvers = null } = {}) {
  const observedOvers = sortBallsByPosition(balls).reduce((highest, ball) => {
    if (isAdministrativeBall(ball)) return highest;
    return Math.max(highest, toInt(ball?.over_no, 0) + 1);
  }, 0);
  const configuredOvers = Math.max(0, toInt(maxOvers, 0));
  const resolvedOvers = Math.max(observedOvers, configuredOvers);

  return Array.from({ length: resolvedOvers }, (_, index) => index + 1);
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

function selectTopBattingAppearance(balls, playersById = {}) {
  const byAppearance = new Map();

  for (const ball of sortBallsByPosition((balls || []).filter((entry) => !isAdministrativeBall(entry)))) {
    const batterId = ball?.striker_id || null;
    if (!batterId) continue;

    const battingTurn = toInt(ball?.batting_turn, 1) || 1;
    const key = `${batterId}:${battingTurn}`;
    if (!byAppearance.has(key)) {
      byAppearance.set(key, {
        playerId: batterId,
        turn: battingTurn,
        runs: 0,
        balls: 0,
        name: playersById?.[batterId]?.name || "Batter",
      });
    }

    const row = byAppearance.get(key);
    row.runs += toInt(ball?.runs_off_bat, 0);
    if (didBatterFaceBall(ball)) row.balls += 1;
  }

  return [...byAppearance.values()]
    .sort((a, b) => (
      b.runs - a.runs
      || a.balls - b.balls
      || String(a.name).localeCompare(String(b.name))
    ))[0] || null;
}

function selectBestBowlerSummary(balls, playersById = {}) {
  const byBowler = new Map();

  for (const ball of sortBallsByPosition((balls || []).filter((entry) => !isAdministrativeBall(entry)))) {
    const bowlerId = ball?.bowler_id || null;
    if (!bowlerId) continue;

    if (!byBowler.has(bowlerId)) {
      byBowler.set(bowlerId, {
        playerId: bowlerId,
        name: playersById?.[bowlerId]?.name || "Bowler",
        wickets: 0,
        runs: 0,
        legalBalls: 0,
      });
    }

    const row = byBowler.get(bowlerId);
    row.runs += runsConcededByBowler(ball);
    if (ball?.legal_ball !== false) row.legalBalls += 1;
    if (isBowlerCreditedWicket(ball)) row.wickets += 1;
  }

  return [...byBowler.values()]
    .sort((a, b) => (
      b.wickets - a.wickets
      || a.runs - b.runs
      || a.legalBalls - b.legalBalls
      || String(a.name).localeCompare(String(b.name))
    ))[0] || null;
}

function selectTurningPointSummary({ innings1, innings2, innings2Balls }) {
  if (!innings1 || !innings2) return null;
  const overs = selectOverSummaries(innings2Balls);
  if (!overs.length) return null;

  const chaseWon = toInt(innings2.runs, 0) > toInt(innings1.runs, 0);
  const ranked = [...overs].sort((a, b) => {
    if (chaseWon) {
      return b.runs - a.runs || b.wickets - a.wickets || b.overNo - a.overNo;
    }
    return b.wickets - a.wickets || a.runs - b.runs || b.overNo - a.overNo;
  });

  const selected = ranked[0];
  if (!selected) return null;

  let text;
  if (selected.wickets > 0) {
    text = `Turning point: Over ${selected.overNo + 1} went for ${selected.runs} run${selected.runs === 1 ? "" : "s"} and ${selected.wickets} wicket${selected.wickets === 1 ? "" : "s"}.`;
  } else if (chaseWon) {
    text = `Turning point: Over ${selected.overNo + 1} yielded ${selected.runs} run${selected.runs === 1 ? "" : "s"}.`;
  } else {
    text = `Turning point: Over ${selected.overNo + 1} went for ${selected.runs} run${selected.runs === 1 ? "" : "s"}.`;
  }

  return {
    overNo: selected.overNo,
    runs: selected.runs,
    wickets: selected.wickets,
    text,
  };
}

export function buildAutomaticMatchSummary({
  matchStatus,
  innings1Team,
  innings2Team,
  innings1,
  innings2,
  innings1Balls = [],
  innings2Balls = [],
  playersById = {},
  wicketCap,
} = {}) {
  const headline = buildCompletedResultText({
    matchStatus,
    innings1Team,
    innings2Team,
    innings1,
    innings2,
    wicketCap,
  });

  if (!headline) return null;

  const allBalls = [...(innings1Balls || []), ...(innings2Balls || [])];
  const topBatter = selectTopBattingAppearance(allBalls, playersById);
  const bestBowler = selectBestBowlerSummary(allBalls, playersById);
  const turningPoint = selectTurningPointSummary({ innings1, innings2, innings2Balls });

  return {
    headline: `${headline}.`,
    topBatter: topBatter
      ? `Top scorer: ${topBatter.name} ${topBatter.runs} (${topBatter.balls})`
      : "",
    bestBowler: bestBowler
      ? `Best bowler: ${bestBowler.name} ${bestBowler.wickets}/${bestBowler.runs}`
      : "",
    turningPoint: turningPoint?.text || "",
  };
}
