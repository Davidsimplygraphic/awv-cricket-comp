import assert from "node:assert/strict";
import fs from "node:fs";

import { test } from "./test-helpers.js";

const scoreHome = fs.readFileSync(new URL("../src/pages/ScoreHome.jsx", import.meta.url), "utf8");
const scoreView = fs.readFileSync(new URL("../src/pages/ScoreView.jsx", import.meta.url), "utf8");
const scorecardTables = fs.readFileSync(new URL("../src/components/ScorecardTables.jsx", import.meta.url), "utf8");
const ballByBall = fs.readFileSync(new URL("../src/components/BallByBall.jsx", import.meta.url), "utf8");
const partnerships = fs.readFileSync(new URL("../src/components/Partnerships.jsx", import.meta.url), "utf8");
const wormGraph = fs.readFileSync(new URL("../src/components/WormGraph.jsx", import.meta.url), "utf8");
const leaderboards = fs.readFileSync(new URL("../src/pages/Leaderboards.jsx", import.meta.url), "utf8");
const integrationTypes = fs.readFileSync(new URL("../src/integrations/supabase/types.ts", import.meta.url), "utf8").trim();
const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const wicketEventDesign = fs.readFileSync(new URL("../docs/wicket-event-design.md", import.meta.url), "utf8");
const remoteSchemaSql = fs.readFileSync(
  new URL("../supabase/migrations/20260310082624_remote_schema.sql", import.meta.url),
  "utf8"
);
const integrityHardeningSql = fs.readFileSync(
  new URL("../supabase/migrations/20260310114500_integrity_hardening.sql", import.meta.url),
  "utf8"
);
const wicketEventModelSql = fs.readFileSync(
  new URL("../supabase/migrations/20260310153000_wicket_event_model.sql", import.meta.url),
  "utf8"
);
const migrationNames = fs
  .readdirSync(new URL("../supabase/migrations/", import.meta.url))
  .filter((name) => name.endsWith(".sql"));

test("destructive scorer admin flows require hardened RPCs and no longer fall back to direct table deletes", () => {
  assert.doesNotMatch(scoreHome, /legacyDeleteMatch|legacyResetMatch/);
  assert.doesNotMatch(scoreView, /legacyResetMatchData/);
  assert.doesNotMatch(scoreHome, /\.from\("balls"\)\.delete\(\)/);
  assert.doesNotMatch(scoreView, /\.from\("balls"\)\.delete\(\)/);
  assert.match(scoreHome, /missingRequiredRpcMessage\("delete_match_state"/);
  assert.match(scoreHome, /missingRequiredRpcMessage\("reset_match_state"/);
  assert.match(scoreView, /missingRequiredRpcMessage\("reset_match_state"/);
});

test("retired hurt now uses an administrative state event instead of a fake delivery", () => {
  assert.match(scoreView, /ADMINISTRATIVE_STATE_CHANGED_EVENT_TYPE/);
  assert.match(scoreView, /action_type: "retired_hurt"/);
  assert.doesNotMatch(scoreView, /RETIRED_HURT_UNSUPPORTED_MSG/);
});

test("wicket scorer flow does not reference removed wicket-ended-over state", () => {
  assert.doesNotMatch(scoreView, /setWicketEndedOver/);
});

test("ScoreView relies on shared scoring helpers instead of redefining scorer math locally", () => {
  assert.match(scoreView, /from "\.\.\/lib\/scoring"/);
  assert.doesNotMatch(scoreView, /^function (toInt|isAdministrativeBall|isCompetitiveBall|sumRuns|sumWkts|legalBallsCount|oversTextFromLegal|getOverBalls|getOverCounts|isOverFinished|computeNextPosition|sortBallsByPosition|countLegalBallsBowledBy)\(/m);
});

test("display read-model components rely on the shared ball sorter", () => {
  for (const source of [scorecardTables, ballByBall, partnerships]) {
    assert.match(source, /sortBallsByPosition/);
    assert.doesNotMatch(source, /^function sortBalls\(/m);
    assert.doesNotMatch(source, /\.sort\(\(a, b\) => .*over_no.*delivery_in_over/m);
  }
});

test("WormGraph relies on the shared worm-series selector", () => {
  assert.match(wormGraph, /selectWormSeries/);
  assert.doesNotMatch(wormGraph, /^function buildCumulativeSeries\(/m);
});

test("bowling read models use authoritative bowler wicket-credit helpers instead of raw wicket flags", () => {
  assert.match(scorecardTables, /isBowlerCreditedWicket/);
  assert.doesNotMatch(scorecardTables, /if \(x\.wicket\) wkts \+= 1;/);

  assert.match(scoreView, /isBowlerCreditedWicket/);
  assert.doesNotMatch(scoreView, /if \(b\.wicket\) s\.wickets \+= 1;/);

  assert.match(leaderboards, /isBowlerCreditedWicket/);
  assert.match(leaderboards, /function computeWktsByBowlerPerInnings[\s\S]*isBowlerCreditedWicket/);
  assert.doesNotMatch(leaderboards, /const row = perPlayer\.get\(bowlerId\);[\s\S]*if \(b\.wicket\) row\.wkts \+= 1;/);
});

test("bowling read models use authoritative bowler-conceded run helpers instead of raw run plus extra sums", () => {
  assert.match(scorecardTables, /runsConcededByBowler/);
  assert.match(scoreView, /runsConcededByBowler/);
  assert.match(leaderboards, /runsConcededByBowler/);
  assert.doesNotMatch(leaderboards, /row\.runs \+= toInt\(b\.runs_off_bat, 0\) \+ toInt\(b\.extra_runs, 0\);/);
});

test("ScorecardTables and Leaderboards rely on the shared innings summary selector", () => {
  assert.match(scorecardTables, /selectInningsSummary/);
  assert.doesNotMatch(scorecardTables, /^function legalBallsCount\(/m);
  assert.match(leaderboards, /selectInningsSummary/);
  assert.doesNotMatch(leaderboards, /^function (sumRuns|sumWkts|countLegal|oversTextFromLegal)\(/m);
});

test("stale scorer backup files are not kept in the repository", () => {
  assert.equal(fs.existsSync(new URL("../src/pages/ScoreView.jsx.bak", import.meta.url)), false);
});

test("db integration scripts are wired into the repository", () => {
  assert.equal(packageJson.scripts["test:db"], "node test/run-db-tests.js");
  assert.equal(packageJson.scripts["test:all"], "npm test && npm run test:db");
});

test("supabase migration versions are unique for clean local replay", () => {
  const versions = migrationNames.map((name) => name.split("_")[0]);
  assert.equal(new Set(versions).size, versions.length);
});

test("ball event idempotency uses the partial source_event_id index predicate correctly", () => {
  assert.match(remoteSchemaSql, /on conflict \(source_event_id\) where source_event_id is not null do nothing/i);
  assert.match(integrityHardeningSql, /on conflict \(source_event_id\) where source_event_id is not null do nothing/i);
});

test("latest event ordering relies on per-call timestamps rather than transaction-scoped now()", () => {
  assert.match(integrityHardeningSql, /applied_at = clock_timestamp\(\)/);
  assert.doesNotMatch(integrityHardeningSql, /applied_at = now\(\)/);
});

test("forward wicket event migration distinguishes delivery and administrative events", () => {
  assert.match(wicketEventModelSql, /v_effective_event_type := case/);
  assert.match(wicketEventModelSql, /v_effective_event_type = 'delivery_recorded'/);
  assert.match(wicketEventModelSql, /v_effective_event_type = 'administrative_state_changed'/);
  assert.match(wicketEventModelSql, /Use administrative_state_changed for retired hurt events/);
});

test("integrations supabase types re-export the authoritative type source", () => {
  assert.equal(integrationTypes, 'export * from "../../types/supabase";');
});

test("wicket event design is documented with delivery and administrative event separation", () => {
  assert.match(wicketEventDesign, /delivery_recorded/);
  assert.match(wicketEventDesign, /administrative_state_changed/);
  assert.match(wicketEventDesign, /completed_runs/);
  assert.match(wicketEventDesign, /dismissals/);
});
