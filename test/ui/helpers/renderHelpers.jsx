import { render } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

const TEST_ROUTER_FUTURE = {
  v7_startTransition: true,
  v7_relativeSplatPath: true,
};

export function setViewportWidth(width) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value: width,
  });
  window.dispatchEvent(new Event("resize"));
}

export function renderAtRoute(element, { route, path }) {
  return render(
    <MemoryRouter initialEntries={[route]} future={TEST_ROUTER_FUTURE}>
      <Routes>
        <Route path={path} element={element} />
      </Routes>
    </MemoryRouter>
  );
}
