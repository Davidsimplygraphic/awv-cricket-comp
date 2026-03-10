import { spawnSync } from "node:child_process";
import process from "node:process";

const supabaseCommand = process.platform === "win32" ? "supabase.exe" : "supabase";
const dbOnlyExcludes = [
  "gotrue",
  "realtime",
  "storage-api",
  "imgproxy",
  "kong",
  "mailpit",
  "postgrest",
  "postgres-meta",
  "studio",
  "edge-runtime",
  "logflare",
  "vector",
  "supavisor",
];

function run(command, args, { allowFailure = false, capture = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
  });

  if (!allowFailure && result.status !== 0) {
    const message = result.stderr || result.stdout || `${command} ${args.join(" ")} failed`;
    throw new Error(message.trim());
  }

  return result;
}

function ensureLocalSupabase() {
  const status = run(supabaseCommand, ["status", "-o", "json"], { allowFailure: true, capture: true });
  if (status.status === 0) return;

  console.log("Local Supabase is not running. Attempting to start it...");
  const started = run(supabaseCommand, ["start", "-x", dbOnlyExcludes.join(",")], { allowFailure: true });
  if (started.status === 0) return;

  throw new Error(
    "Unable to start local Supabase. Ensure Docker Desktop is running and this command can access the Docker engine."
  );
}

try {
  ensureLocalSupabase();
  run(supabaseCommand, ["db", "reset", "--local", "--no-seed", "--yes"]);
  run(supabaseCommand, ["test", "db", "supabase/tests", "--local"]);
} catch (error) {
  console.error(error?.message || error);
  process.exitCode = 1;
}
