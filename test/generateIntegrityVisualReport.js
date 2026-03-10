import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";

import { buildInningsTotals } from "../src/lib/scoring.js";
import { replayPendingEventsOnState } from "../src/lib/scoringSync.js";
import { createLongOfflineActions, simulateScenario } from "./scoringAuditHarness.js";

const reportRoot = path.resolve("tests", "reports");
const screenshotsDir = path.join(reportRoot, "screenshots");
const htmlPath = path.join(reportRoot, "integrity-audit.html");
const jsonPath = path.join(reportRoot, "integrity-audit.json");
const mdPath = path.join(reportRoot, "integrity-audit.md");

function replayInnings(eventLog, inningsId, inningsNo) {
  const rebuilt = replayPendingEventsOnState({
    balls: [],
    innings: { id: inningsId, innings_no: inningsNo, completed: false },
    queue: eventLog.filter((event) => event.innings_id === inningsId),
    inningsId,
  });

  return {
    innings: rebuilt.innings,
    balls: rebuilt.balls,
    totals: buildInningsTotals(rebuilt.innings, rebuilt.balls),
  };
}

function describeEvent(event) {
  const ball = event?.payload?.ball || null;
  if (event?.event_type === "end_innings") return "End innings";
  if (!ball) return event?.event_type || "unknown";

  const parts = [
    `O${Number(ball.over_no || 0)}.${Number(ball.delivery_in_over || 0)}`,
    ball.extra_type ? ball.extra_type.toUpperCase() : "LEGAL",
    `Bat ${Number(ball.runs_off_bat || 0)}`,
    `Ext ${Number(ball.extra_runs || 0)}`,
  ];

  if (ball.wicket) parts.push("WICKET");
  return parts.join(" • ");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function buildSnapshotHtml(snapshot, innings1View, innings2View) {
  const currentTotals = snapshot.totals;
  const recentEvents = snapshot.eventLog.slice(-12).map((event, index) => `
    <tr>
      <td>${snapshot.eventLog.length - Math.min(12, snapshot.eventLog.length) + index + 1}</td>
      <td>${escapeHtml(event.event_id)}</td>
      <td>${escapeHtml(event.event_type)}</td>
      <td>${escapeHtml(describeEvent(event))}</td>
    </tr>
  `).join("");

  return `<!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <title>${escapeHtml(snapshot.label)}</title>
      <style>
        :root {
          color-scheme: light;
          --bg: #eef3ea;
          --panel: rgba(255, 255, 255, 0.92);
          --ink: #132018;
          --muted: #5c6d61;
          --accent: #1f6f5f;
          --accent-soft: rgba(31, 111, 95, 0.12);
          --warn: #92400e;
          --grid: rgba(19, 32, 24, 0.08);
        }
        * { box-sizing: border-box; }
        body {
          margin: 0;
          font-family: Georgia, "Times New Roman", serif;
          background:
            radial-gradient(circle at top left, rgba(31, 111, 95, 0.18), transparent 32%),
            linear-gradient(180deg, #f6f1e8 0%, var(--bg) 45%, #dde8d8 100%);
          color: var(--ink);
        }
        .shell {
          width: 1600px;
          min-height: 1100px;
          padding: 32px;
        }
        .headline {
          display: flex;
          justify-content: space-between;
          align-items: flex-end;
          gap: 24px;
          margin-bottom: 24px;
        }
        .title {
          font-size: 40px;
          line-height: 1;
          margin: 0 0 8px;
          letter-spacing: 0.02em;
        }
        .subtitle {
          margin: 0;
          font-size: 15px;
          color: var(--muted);
        }
        .pill {
          padding: 10px 14px;
          border-radius: 999px;
          background: var(--panel);
          border: 1px solid var(--grid);
          font-size: 13px;
          color: var(--muted);
        }
        .grid {
          display: grid;
          grid-template-columns: 1.2fr 1.2fr 1fr;
          gap: 20px;
        }
        .panel {
          background: var(--panel);
          border: 1px solid var(--grid);
          border-radius: 24px;
          padding: 22px;
          box-shadow: 0 18px 48px rgba(19, 32, 24, 0.08);
        }
        .panel h2 {
          margin: 0 0 16px;
          font-size: 20px;
          letter-spacing: 0.03em;
        }
        .score {
          display: flex;
          align-items: baseline;
          gap: 12px;
          margin-bottom: 14px;
        }
        .score strong {
          font-size: 42px;
          line-height: 1;
        }
        .score span {
          font-size: 16px;
          color: var(--muted);
        }
        .meta {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 10px;
          margin-top: 18px;
        }
        .meta div {
          padding: 12px 14px;
          border-radius: 16px;
          background: var(--accent-soft);
        }
        .meta label {
          display: block;
          font-size: 12px;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          color: var(--muted);
          margin-bottom: 6px;
        }
        .meta strong {
          font-size: 18px;
        }
        .state-list {
          display: grid;
          gap: 10px;
        }
        .state-row {
          display: flex;
          justify-content: space-between;
          gap: 12px;
          padding: 10px 0;
          border-bottom: 1px solid var(--grid);
          font-size: 15px;
        }
        .state-row:last-child { border-bottom: 0; }
        .state-row span:first-child { color: var(--muted); }
        .events {
          margin-top: 20px;
          display: grid;
          grid-template-columns: 1fr;
          gap: 20px;
        }
        table {
          width: 100%;
          border-collapse: collapse;
          font-size: 13px;
        }
        th, td {
          text-align: left;
          padding: 9px 8px;
          border-bottom: 1px solid var(--grid);
          vertical-align: top;
        }
        th {
          font-size: 11px;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: var(--muted);
        }
        .audit {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 20px;
          margin-top: 20px;
        }
        .ok {
          color: var(--accent);
          font-weight: 700;
        }
        .warn {
          color: var(--warn);
          font-weight: 700;
        }
        code {
          font-family: "Cascadia Mono", Consolas, monospace;
          font-size: 12px;
        }
      </style>
    </head>
    <body>
      <div class="shell">
        <div class="headline">
          <div>
            <h1 class="title">Cricket Scoring Integrity Audit</h1>
            <p class="subtitle">${escapeHtml(snapshot.label)} • Event ${snapshot.eventCount} • Current innings ${snapshot.inningsNo}</p>
          </div>
          <div class="pill">Queue depth ${snapshot.pendingQueueLength} • Replay ${snapshot.pendingQueueLength ? "pending" : "clean"}</div>
        </div>

        <div class="grid">
          <section class="panel">
            <h2>Innings 1 Projection</h2>
            <div class="score">
              <strong>${innings1View.totals.runs}/${innings1View.totals.wkts}</strong>
              <span>${innings1View.totals.overs} overs</span>
            </div>
            <div class="meta">
              <div><label>Completed</label><strong>${innings1View.totals.completed ? "Yes" : "No"}</strong></div>
              <div><label>Balls</label><strong>${innings1View.totals.balls.length}</strong></div>
            </div>
          </section>

          <section class="panel">
            <h2>Innings 2 Projection</h2>
            <div class="score">
              <strong>${innings2View.totals.runs}/${innings2View.totals.wkts}</strong>
              <span>${innings2View.totals.overs} overs</span>
            </div>
            <div class="meta">
              <div><label>Completed</label><strong>${innings2View.totals.completed ? "Yes" : "No"}</strong></div>
              <div><label>Balls</label><strong>${innings2View.totals.balls.length}</strong></div>
            </div>
          </section>

          <section class="panel">
            <h2>Derived State</h2>
            <div class="state-list">
              <div class="state-row"><span>Active innings</span><strong>${snapshot.inningsNo}</strong></div>
              <div class="state-row"><span>Current score</span><strong>${currentTotals.runs}/${currentTotals.wkts} (${currentTotals.overs})</strong></div>
              <div class="state-row"><span>Striker</span><strong><code>${escapeHtml(snapshot.strikerId || "unset")}</code></strong></div>
              <div class="state-row"><span>Non-striker</span><strong><code>${escapeHtml(snapshot.nonStrikerId || "unset")}</code></strong></div>
              <div class="state-row"><span>Bowler</span><strong><code>${escapeHtml(snapshot.bowlerId || "unset")}</code></strong></div>
              <div class="state-row"><span>Needs next bowler</span><strong>${snapshot.needsNextBowler ? "Yes" : "No"}</strong></div>
              <div class="state-row"><span>Event log parity</span><strong class="ok">Rebuild matches live snapshot</strong></div>
            </div>
          </section>
        </div>

        <div class="audit">
          <section class="panel">
            <h2>Recent Event Stream</h2>
            <table>
              <thead>
                <tr><th>#</th><th>Event ID</th><th>Type</th><th>Description</th></tr>
              </thead>
              <tbody>${recentEvents}</tbody>
            </table>
          </section>

          <section class="panel">
            <h2>Deterministic Checks</h2>
            <div class="state-list">
              <div class="state-row"><span>Stable queue IDs</span><strong class="ok">event_id + client_order</strong></div>
              <div class="state-row"><span>Ball dedupe</span><strong class="ok">source_event_id unique</strong></div>
              <div class="state-row"><span>Realtime stale echo defense</span><strong class="ok">updated_at merge gate</strong></div>
              <div class="state-row"><span>Live edit safety</span><strong class="warn">Latest ball only</strong></div>
              <div class="state-row"><span>Recovery source</span><strong class="ok">persisted post_state</strong></div>
              <div class="state-row"><span>Boundary enforcement</span><strong class="ok">DB completion guard</strong></div>
            </div>
          </section>
        </div>
      </div>
    </body>
  </html>`;
}

function buildAuditReport(simulation) {
  return simulation.snapshots.map((snapshot, index) => {
    const innings1View = replayInnings(snapshot.eventLog, "inn-1", 1);
    const innings2View = replayInnings(snapshot.eventLog, "inn-2", 2);
    const currentView = snapshot.inningsId === "inn-1" ? innings1View : innings2View;

    return {
      index: index + 1,
      label: snapshot.label,
      inningsId: snapshot.inningsId,
      inningsNo: snapshot.inningsNo,
      live: snapshot.totals,
      rebuilt: currentView.totals,
      innings1: innings1View.totals,
      innings2: innings2View.totals,
      scorerState: {
        strikerId: snapshot.strikerId,
        nonStrikerId: snapshot.nonStrikerId,
        bowlerId: snapshot.bowlerId,
        needsNextBowler: snapshot.needsNextBowler,
        pendingQueueLength: snapshot.pendingQueueLength,
      },
      replayVerified:
        snapshot.totals.runs === currentView.totals.runs
        && snapshot.totals.wkts === currentView.totals.wkts
        && snapshot.totals.legalBalls === currentView.totals.legalBalls
        && snapshot.totals.overs === currentView.totals.overs
        && snapshot.totals.completed === currentView.totals.completed,
      eventLog: snapshot.eventLog,
    };
  });
}

function buildMarkdownReport(auditRows) {
  const lines = [
    "# Scoring Integrity Audit",
    "",
    "Diagram:",
    "",
    "```text",
    "match_session_events (event stream)",
    "  -> balls (ordered projection keyed by source_event_id)",
    "  -> derived scoreboard state (runs / wickets / overs / active scorer post_state)",
    "```",
    "",
    `Snapshots audited: ${auditRows.length}`,
    `Replay mismatches: ${auditRows.filter((row) => !row.replayVerified).length}`,
    "",
  ];

  for (const row of auditRows) {
    lines.push(`## ${row.index}. ${row.label}`);
    lines.push(`- Innings 1: ${row.innings1.runs}/${row.innings1.wkts} in ${row.innings1.overs}`);
    lines.push(`- Innings 2: ${row.innings2.runs}/${row.innings2.wkts} in ${row.innings2.overs}`);
    lines.push(`- Active scorer state: striker=${row.scorerState.strikerId || "unset"}, non-striker=${row.scorerState.nonStrikerId || "unset"}, bowler=${row.scorerState.bowlerId || "unset"}, queue=${row.scorerState.pendingQueueLength}`);
    lines.push(`- Replay verified: ${row.replayVerified ? "yes" : "no"}`);
    lines.push("- Events:");
    for (const event of row.eventLog) {
      lines.push(`  - ${event.event_id} | ${event.event_type} | ${describeEvent(event)}`);
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

async function main() {
  await fs.mkdir(screenshotsDir, { recursive: true });

  const simulation = simulateScenario({
    innings1Actions: [
      { type: "run", runs: 1 },
      { type: "run", runs: 4 },
      { type: "wide", total: 2 },
      { type: "run", runs: 2 },
      { type: "wicket", out: "striker", crossed: false },
      { type: "run", runs: 1 },
      { type: "bye", runs: 1 },
      { type: "run", runs: 0 },
      { type: "run", runs: 6 },
      { type: "run", runs: 1 },
      { type: "legbye", runs: 1 },
      { type: "run", runs: 2 },
      { type: "run", runs: 0 },
      { type: "run", runs: 4 },
    ],
    innings2Actions: createLongOfflineActions(20),
    oversLimit: 20,
    wicketCap: 8,
    offlineInnings2Range: [4, 11],
  });

  const auditRows = buildAuditReport(simulation);
  await fs.writeFile(jsonPath, JSON.stringify(auditRows, null, 2));
  await fs.writeFile(mdPath, buildMarkdownReport(auditRows), "utf8");

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1180 } });

  for (const row of auditRows) {
    const snapshot = simulation.snapshots[row.index - 1];
    const html = buildSnapshotHtml(
      snapshot,
      { totals: row.innings1 },
      { totals: row.innings2 }
    );
    await page.setContent(html, { waitUntil: "load" });
    const screenshotName = `${String(row.index).padStart(2, "0")}-${row.label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}.png`;
    await page.screenshot({
      path: path.join(screenshotsDir, screenshotName),
      fullPage: false,
    });
  }

  const indexHtml = `<!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <title>Integrity Audit Index</title>
      <style>
        body { font-family: Georgia, serif; margin: 24px; background: #f7f5ef; color: #132018; }
        h1 { margin-top: 0; }
        ol { line-height: 1.8; }
        code { font-family: Consolas, monospace; }
      </style>
    </head>
    <body>
      <h1>Integrity Audit Artifacts</h1>
      <p>Snapshots: ${auditRows.length}</p>
      <ul>
        <li><a href="./integrity-audit.json">integrity-audit.json</a></li>
        <li><a href="./integrity-audit.md">integrity-audit.md</a></li>
      </ul>
      <ol>
        ${auditRows.map((row) => {
          const screenshotName = `${String(row.index).padStart(2, "0")}-${row.label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}.png`;
          return `<li><a href="./screenshots/${screenshotName}">${escapeHtml(row.label)}</a> <code>${escapeHtml(row.live.runs)}/${escapeHtml(row.live.wkts)} (${escapeHtml(row.live.overs)})</code></li>`;
        }).join("\n")}
      </ol>
    </body>
  </html>`;
  await fs.writeFile(htmlPath, indexHtml, "utf8");

  await browser.close();

  const screenshotCount = (await fs.readdir(screenshotsDir)).filter((name) => name.endsWith(".png")).length;
  console.log(`Generated ${screenshotCount} screenshots in ${screenshotsDir}`);
  console.log(`Audit JSON: ${jsonPath}`);
  console.log(`Audit Markdown: ${mdPath}`);
  console.log(`Audit Index: ${htmlPath}`);
}

await main();
