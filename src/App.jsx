import { useEffect, useState } from "react";
import { Routes, Route, Link, useNavigate } from "react-router-dom";
import { supabase } from "./lib/supabase";

import Home from "./pages/Home";
import Teams from "./pages/Teams";
import TeamRoster from "./pages/TeamRoster";
import Fixtures from "./pages/Fixtures";
import Leaderboards from "./pages/Leaderboards";
import ScoreHome from "./pages/ScoreHome";
import ScoreView from "./pages/ScoreView";
import SpectatorView from "./views/SpectatorView";
import Login from "./pages/Login";
import MatchCentre from "./pages/MatchCentre";

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
        <Route path="/fixtures" element={<Fixtures />} />
        <Route path="/leaderboards" element={<Leaderboards />} />
        <Route path="/teams" element={<Teams />} />
        <Route path="/teams/:teamId" element={<TeamRoster />} />
        <Route path="/login" element={<Login />} />

        {/* Fixture-level match centre */}
        <Route path="/match-centre/:fixtureId" element={<MatchCentre />} />

        <Route
          path="/score"
          element={
            <RequireAuth>
              <ScoreHome />
            </RequireAuth>
          }
        />
        <Route
          path="/score/:fixtureId"
          element={
            <RequireAuth>
              <ScoreView />
            </RequireAuth>
          }
        />

        <Route path="/match/:fixtureId" element={<SpectatorView />} />
      </Routes>
    </div>
  );
}