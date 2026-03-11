import React from "react";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";

import MatchCentre from "../../src/pages/MatchCentre.jsx";
import SpectatorView from "../../src/views/SpectatorView.jsx";
import { createReadUiFixture } from "./fixtures.js";
import { createSupabaseMock } from "./helpers/mockSupabase.js";
import { renderAtRoute, setViewportWidth } from "./helpers/renderHelpers.jsx";

const supabaseState = vi.hoisted(() => ({ current: null }));

vi.mock("../../src/lib/supabase.js", () => ({
  supabase: new Proxy({}, {
    get(_target, prop) {
      return supabaseState.current?.[prop];
    },
  }),
}));

test("SpectatorView renders mobile live context with the replacement batter after retired hurt", async () => {
  setViewportWidth(390);
  const fixture = createReadUiFixture();
  supabaseState.current = createSupabaseMock(fixture.tables);

  renderAtRoute(<SpectatorView />, {
    route: `/spectator/${fixture.fixtureId}`,
    path: "/spectator/:fixtureId",
  });

  expect(await screen.findByText(/Spectator view/i)).toBeVisible();
  expect(
    screen.getAllByText((_, element) => String(element?.textContent || "").replace(/\s+/g, " ").includes("3 / 0")).length
  ).toBeGreaterThan(0);
  expect(screen.getAllByText(/0\.3 overs/i).length).toBeGreaterThan(0);
  expect(screen.getByText(/On strike/i)).toBeVisible();
  expect(screen.getByText(/^Partner$/i)).toBeVisible();
  expect(screen.getByText(/^Bowler$/i)).toBeVisible();
  expect(screen.getByText(/^This over$/i)).toBeVisible();
  expect(screen.getByText(/Casey Charlie\*/i)).toBeVisible();
  expect(screen.getByText("Beth Bravo")).toBeVisible();
  expect(screen.queryByText(/Alice Alpha\*/i)).not.toBeInTheDocument();
});

test("MatchCentre renders parity-safe retired-hurt scorecards, partnerships, and worm graph output", async () => {
  setViewportWidth(390);
  const fixture = createReadUiFixture({ includeSecondInnings: true });
  supabaseState.current = createSupabaseMock(fixture.tables);

  const { container } = renderAtRoute(<MatchCentre />, {
    route: `/fixtures/${fixture.fixtureId}`,
    path: "/fixtures/:fixtureId",
  });

  const retiredHurt = await screen.findByText("Retired Hurt");
  expect(retiredHurt).toBeVisible();
  expect(retiredHurt).toHaveStyle({ color: "#ef4444" });
  expect(container).not.toHaveTextContent(/Out x\s*[12]/i);

  fireEvent.click(screen.getByRole("button", { name: "Partnership" }));
  fireEvent.click(screen.getByRole("button", { name: "Innings 1" }));

  expect(await screen.findByText(/ended by retired hurt/i)).toBeVisible();
  expect(screen.getByText("Casey Charlie & Beth Bravo")).toBeVisible();

  fireEvent.click(screen.getByRole("button", { name: "Worm" }));

  await waitFor(() => {
    expect(container.querySelectorAll("circle[data-worm-wicket]").length).toBe(1);
  });
  expect(container.querySelectorAll("line[data-worm-over-guide]").length).toBe(2);
});
