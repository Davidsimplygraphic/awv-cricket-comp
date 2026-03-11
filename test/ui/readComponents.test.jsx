import React from "react";
import { render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";

import Partnerships from "../../src/components/Partnerships.jsx";
import ScorecardTables from "../../src/components/ScorecardTables.jsx";
import WormGraph from "../../src/components/WormGraph.jsx";
import { setViewportWidth } from "./helpers/renderHelpers.jsx";
import { createReadUiFixture } from "./fixtures.js";

const supabaseState = vi.hoisted(() => ({ current: null }));

vi.mock("../../src/lib/supabase.js", () => ({
  supabase: new Proxy({}, {
    get(_target, prop) {
      return supabaseState.current?.[prop];
    },
  }),
}));

const { ScorerStickyHeader } = await import("../../src/pages/ScoreView.jsx");

test("ScorecardTables renders retired hurt and plain out in mobile cards", () => {
  setViewportWidth(390);
  const fixture = createReadUiFixture({ includeSecondInnings: true });
  const innings1Id = fixture.innings[0].id;
  const battingTimeline = [
    ...fixture.displayBallsByInnings[innings1Id],
    {
      id: "inn1-ball-4",
      match_id: fixture.matchId,
      innings_id: innings1Id,
      over_no: 0,
      delivery_in_over: 4,
      striker_id: "a1",
      non_striker_id: "a3",
      bowler_id: "b1",
      batting_turn: 2,
      runs_off_bat: 0,
      extra_runs: 0,
      extra_type: null,
      wicket: true,
      dismissal_kind: "bowled",
      dismissed_player_id: "a1",
      legal_ball: true,
      created_at: "2026-03-11T10:00:40.000Z",
    },
  ];

  const { container } = render(
    <ScorecardTables
      title="Innings 1"
      balls={battingTimeline}
      playersById={fixture.playersById}
      theme="light"
    />
  );

  const retiredHurt = screen.getByText("Retired Hurt");
  expect(retiredHurt).toBeVisible();
  expect(retiredHurt).toHaveStyle({ color: "#ef4444" });
  expect(screen.getAllByText("Out").length).toBeGreaterThan(0);
  expect(container).not.toHaveTextContent(/Out x\s*1/i);
  expect(container.querySelector("table")).not.toBeInTheDocument();
});

test("Partnerships renders retired-hurt reset and incoming batter partnership context", () => {
  const fixture = createReadUiFixture();
  const innings1Id = fixture.innings[0].id;

  render(
    <Partnerships
      balls={fixture.displayBallsByInnings[innings1Id]}
      playersById={fixture.playersById}
      theme="dark"
      compact
    />
  );

  const endedByRetiredHurt = screen.getByText(/ended by retired hurt/i);
  expect(endedByRetiredHurt).toBeVisible();
  expect(endedByRetiredHurt).toHaveStyle({ color: "#fca5a5" });
  expect(screen.getByText("Alice Alpha & Beth Bravo")).toBeVisible();
  expect(screen.getByText("Casey Charlie & Beth Bravo")).toBeVisible();
});

test("WormGraph renders wicket markers and over guides, but not retired-hurt markers", () => {
  const fixture = createReadUiFixture({ includeSecondInnings: true });
  const innings1Id = fixture.innings[0].id;
  const innings2Id = fixture.innings[1].id;

  const { container, rerender } = render(
    <WormGraph
      innings1Balls={fixture.displayBallsByInnings[innings1Id]}
      innings2Balls={fixture.displayBallsByInnings[innings2Id]}
      playersById={fixture.playersById}
      target={8}
      theme="light"
      maxOvers={2}
    />
  );

  expect(container.querySelectorAll("circle[data-worm-wicket]").length).toBe(1);
  expect(container.querySelectorAll("line[data-worm-over-guide]").length).toBe(2);
  expect(container.querySelector("circle[data-worm-wicket] title")).toHaveTextContent(/Devon Dash/i);

  rerender(
    <WormGraph
      innings1Balls={fixture.displayBallsByInnings[innings1Id]}
      innings2Balls={[]}
      playersById={fixture.playersById}
      theme="light"
      maxOvers={2}
    />
  );

  expect(container.querySelectorAll("circle[data-worm-wicket]").length).toBe(0);
});

test("ScorerStickyHeader renders compact score context and badges", () => {
  render(
    <ScorerStickyHeader
      visible
      score="74 / 2"
      oversText="9.3"
      context="Need 21 off 15"
      strikerLabel="Casey Charlie*"
      bowlerLabel="Blair Bowler"
      badges={["Offline", "Queued 2"]}
    />
  );

  expect(screen.getByText("74 / 2")).toBeVisible();
  expect(screen.getByText("9.3 ov")).toBeVisible();
  expect(screen.getByText("Casey Charlie* | Blair Bowler")).toBeVisible();
  expect(screen.getByText("Offline")).toBeVisible();
  expect(screen.getByText("Queued 2")).toBeVisible();
});

test("ScorerStickyHeader renders phone actor chips without losing score context", () => {
  render(
    <ScorerStickyHeader
      visible
      score="74 / 2"
      oversText="9.3"
      context="Need 21 off 15"
      strikerLabel="Casey Charlie*"
      bowlerLabel="Blair Bowler"
      badges={["Offline", "Queued 2"]}
      isPhoneViewport
    />
  );

  expect(screen.getByText("74 / 2")).toBeVisible();
  expect(screen.getByText(/9\.3 ov/i)).toBeVisible();
  expect(screen.getByText("Bat")).toBeVisible();
  expect(screen.getByText("Bowl")).toBeVisible();
  expect(screen.getByText("Casey Charlie*")).toBeVisible();
  expect(screen.getByText("Blair Bowler")).toBeVisible();
});
