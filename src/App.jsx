import { Suspense, lazy, useEffect, useState } from "react";
import { Routes, Route, Link, useNavigate } from "react-router-dom";
import { supabase } from "./lib/supabase";

import Home from "./pages/Home";

const Teams = lazy(() => import("./pages/Teams"));
const TeamRoster = lazy(() => import("./pages/TeamRoster"));
const Fixtures = lazy(() => import("./pages/Fixtures"));
const Leaderboards = lazy(() => import("./pages/Leaderboards"));
const ScoreHome = lazy(() => import("./pages/ScoreHome"));
const ScoreView = lazy(() => import("./pages/ScoreView"));
const SpectatorView = lazy(() => import("./views/SpectatorView"));
const Login = lazy(() => import("./pages/Login"));
const MatchCentre = lazy(() => import("./pages/MatchCentre"));

function RouteLoadingFallback({ label = "Loading..." }) {
  return (
    <div
      style={{
        padding: "14px 16px",
        borderRadius: 16,
        border: "1px solid rgba(15,23,42,0.10)",
        background: "linear-gradient(180deg, rgba(248,250,252,0.96), rgba(241,245,249,0.94))",
        color: "#0f172a",
        boxShadow: "0 10px 24px rgba(15,23,42,0.06)",
      }}
    >
      <div style={{ fontSize: 14, fontWeight: 900 }}>{label}</div>
      <div style={{ marginTop: 6, fontSize: 13, color: "rgba(15,23,42,0.65)" }}>
        Preparing this view for mobile.
      </div>
    </div>
  );
}

function renderLazyPage(element, label) {
  return (
    <Suspense fallback={<RouteLoadingFallback label={label} />}>
      {element}
    </Suspense>
  );
}

export default function App() {
  const [user, setUser] = useState(null);
  const nav = useNavigate();

  const BRAND = {
    name: "AWV Hit & Run Cricket Comp",
    logoUrl: "https://africanwildlifevets.org/wp-content/uploads/2021/10/MicrosoftTeams-image-39.png",
    logoAlt: "African Wildlife Vets",
  };

  useEffect(() => {
    // initial session
    supabase.auth.getSession().then(({ data }) => {
      setUser(data?.session?.user || null);
    });

    // updates
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user || null);
    });

    return () => sub.subscription.unsubscribe();
  }, []);

  const logout = async () => {
    await supabase.auth.signOut();
    nav("/");
  };

  // Simple route guard for scorer pages
  const RequireAuth = ({ children }) => {
    if (!user) {
      return (
        <div style={{ padding: 12, border: "1px solid #eee", borderRadius: 12, maxWidth: 720 }}>
          <div style={{ fontWeight: 900, marginBottom: 6 }}>Scorer access</div>
          <div style={{ color: "#555" }}>You need to be logged in to access the scorer.</div>
          <div style={{ marginTop: 10 }}>
            <Link to="/login">Go to login</Link>
          </div>
        </div>
      );
    }
    return children;
  };

  return (
    <div style={{ maxWidth: 980, margin: "0 auto", padding: 18 }}>
      <div style={{ display: "flex", gap: 14, alignItems: "center", marginBottom: 16, flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <img
            src={BRAND.logoUrl}
            alt={BRAND.logoAlt}
            width={40}
            height={40}
            style={{ display: "block", width: 40, height: 40, borderRadius: 10, objectFit: "contain" }}
            loading="eager"
          />
          <div style={{ fontWeight: 900, fontSize: 22, lineHeight: 1.1 }}>{BRAND.name}</div>
        </div>

        <nav style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <Link to="/">Home</Link>
          <Link to="/fixtures">Fixtures / Results</Link>
          <Link to="/leaderboards">Leaderboards</Link>
          <Link to="/teams">Teams</Link>
          {user ? <Link to="/score">Scorer</Link> : null}

          <span style={{ marginLeft: 10, opacity: 0.5 }}>|</span>

          {!user ? (
            <Link to="/login">Login</Link>
          ) : (
            <button
              onClick={logout}
              style={{
                border: "1px solid #111",
                background: "#111",
                color: "white",
                borderRadius: 10,
                padding: "6px 10px",
                cursor: "pointer",
              }}
            >
              Logout
            </button>
          )}
        </nav>
      </div>

      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/fixtures" element={renderLazyPage(<Fixtures />, "Loading fixtures...")} />
        <Route path="/leaderboards" element={renderLazyPage(<Leaderboards />, "Loading leaderboards...")} />
        <Route path="/teams" element={renderLazyPage(<Teams />, "Loading teams...")} />
        <Route
          path="/teams/:teamId"
          element={
            <RequireAuth>
              {renderLazyPage(<TeamRoster />, "Loading squad...")}
            </RequireAuth>
          }
        />
        <Route path="/login" element={renderLazyPage(<Login />, "Loading login...")} />

        {/* Fixture-level match centre */}
        <Route path="/match-centre/:fixtureId" element={renderLazyPage(<MatchCentre />, "Loading match centre...")} />

        <Route
          path="/score"
          element={
            <RequireAuth>
              {renderLazyPage(<ScoreHome />, "Loading scorer home...")}
            </RequireAuth>
          }
        />
        <Route
          path="/score/:fixtureId"
          element={
            <RequireAuth>
              {renderLazyPage(<ScoreView />, "Loading scorer...")}
            </RequireAuth>
          }
        />

        <Route path="/match/:fixtureId" element={renderLazyPage(<SpectatorView />, "Loading live match...")} />
      </Routes>
    </div>
  );
}
