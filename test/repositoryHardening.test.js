import assert from "node:assert/strict";
import fs from "node:fs";

import { test } from "./test-helpers.js";

const scoreHome = fs.readFileSync(new URL("../src/pages/ScoreHome.jsx", import.meta.url), "utf8");
const scoreView = fs.readFileSync(new URL("../src/pages/ScoreView.jsx", import.meta.url), "utf8");
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

test("retired hurt is explicitly fail-closed until administrative events are implemented", () => {
  assert.match(scoreView, /RETIRED_HURT_UNSUPPORTED_MSG/);
  assert.match(scoreView, /Retired hurt \(coming soon\)/);
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

test("integrations supabase types re-export the authoritative type source", () => {
  assert.equal(integrationTypes, 'export * from "../../types/supabase";');
});

test("wicket event design is documented with delivery and administrative event separation", () => {
  assert.match(wicketEventDesign, /delivery_recorded/);
  assert.match(wicketEventDesign, /administrative_state_changed/);
  assert.match(wicketEventDesign, /completed_runs/);
  assert.match(wicketEventDesign, /dismissals/);
});
