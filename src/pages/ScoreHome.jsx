import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabase";

export default function ScoreHome() {
  const [user, setUser] = useState(null);

  const [matches, setMatches] = useState([]);
  const [teams, setTeams] = useState([]);

  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(""); // used for delete/edit buttons

  // Add fixture state
  const [newTeamA, setNewTeamA] = useState("");
  const [newTeamB, setNewTeamB] = useState("");
  const [newOvers, setNewOvers] = useState(20);
  const [creating, setCreating] = useState(false);

  // Inline edit state
  const [editingId, setEditingId] = useState(null);
  const [editTeamA, setEditTeamA] = useState("");
  const [editTeamB, setEditTeamB] = useState("");
  const [editOvers, setEditOvers] = useState(20);
  const [editStatus, setEditStatus] = useState("draft");
  const [saving, setSaving] = useState(false);

  const statusOptions = useMemo(() => ["draft", "live", "completed"], []);

  const load = async () => {
    setLoading(true);
    setErr("");
    setInfo("");

    const sess = await supabase.auth.getSession();
    const u = sess?.data?.session?.user || null;
    setUser(u);

    // teams
    const t = await supabase.from("teams").select("id,name,short_name").order("name");
    if (t.error) {
      setErr(`Teams load error: ${t.error.message}`);
      setLoading(false);
      return;
    }
    setTeams(t.data || []);

    // matches with joined team names
    const m = await supabase
      .from("matches")
      .select(
        `
        id,
        fixture_id,
        scheduled_at,
        team_a_id,
        team_b_id,
        overs_limit,
        status,
        scorer_user_id,
        created_at,
        team_a:teams!matches_team_a_id_fkey ( id, name, short_name ),
        team_b:teams!matches_team_b_id_fkey ( id, name, short_name )
      `
      )
      .order("created_at", { ascending: false });

    if (m.error) {
      setErr(`Matches load error: ${m.error.message}`);
      setLoading(false);
      return;
    }

    setMatches(m.data || []);
    setLoading(false);
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const formatTeam = (team) => {
    if (!team) return "—";
    return team.short_name ? `${team.name} (${team.short_name})` : team.name;
  };

  // -------------------------
  // CREATE (Add fixture)
  // -------------------------
  const createFixture = async () => {
    setErr("");
    setInfo("");

    if (!user?.id) {
      setErr("You must be logged in to create fixtures.");
      return;
    }
    if (!newTeamA || !newTeamB) {
      setErr("Select Team A and Team B.");
      return;
    }
    if (newTeamA === newTeamB) {
      setErr("Team A and Team B must be different.");
      return;
    }
    const overs = Number(newOvers);
    if (!Number.isFinite(overs) || overs <= 0) {
      setErr("Overs must be a positive number.");
      return;
    }

    setCreating(true);

    // NOTE:
    // The scorer / spectator / match-centre routes use :fixtureId.
    // ScoreView queries matches by matches.fixture_id (NOT matches.id),
    // so when creating a match from this page we must also set fixture_id.
    const fixtureId = crypto?.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;

    const res = await supabase
      .from("matches")
      .insert({
        fixture_id: fixtureId,
        // Put it into today's list unless you later edit scheduled times elsewhere.
        scheduled_at: new Date().toISOString(),
        team_a_id: newTeamA,
        team_b_id: newTeamB,
        overs_limit: overs,
        status: "draft",
        scorer_user_id: user.id,
      })
      .select(
        `
        id,
        fixture_id,
        scheduled_at,
        team_a_id,
        team_b_id,
        overs_limit,
        status,
        scorer_user_id,
        created_at,
        team_a:teams!matches_team_a_id_fkey ( id, name, short_name ),
        team_b:teams!matches_team_b_id_fkey ( id, name, short_name )
      `
      )
      .single();

    setCreating(false);

    if (res.error) {
      setErr(`Create fixture error: ${res.error.message}`);
      return;
    }

    setMatches((prev) => [res.data, ...prev]);
    setInfo("Fixture created ✅");

    setNewTeamA("");
    setNewTeamB("");
    setNewOvers(20);
  };

  // -------------------------
  // EDIT
  // -------------------------
  const startEdit = (match) => {
    setErr("");
    setInfo("");
    setEditingId(match.id);
    setEditTeamA(match.team_a_id || "");
    setEditTeamB(match.team_b_id || "");
    setEditOvers(match.overs_limit || 20);
    setEditStatus(match.status || "draft");
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditTeamA("");
    setEditTeamB("");
    setEditOvers(20);
    setEditStatus("draft");
  };

  const saveEdit = async () => {
    setErr("");
    setInfo("");

    if (!editingId) return;

    if (!editTeamA || !editTeamB) {
      setErr("Please select both Team A and Team B.");
      return;
    }
    if (editTeamA === editTeamB) {
      setErr("Team A and Team B must be different.");
      return;
    }

    const overs = Number(editOvers);
    if (!Number.isFinite(overs) || overs <= 0) {
      setErr("Overs must be a positive number.");
      return;
    }

    setSaving(true);
    setBusyId(editingId);

    const res = await supabase
      .from("matches")
      .update({
        team_a_id: editTeamA,
        team_b_id: editTeamB,
        overs_limit: overs,
        status: editStatus,
      })
      .eq("id", editingId)
      .select(
        `
        id,
        fixture_id,
        scheduled_at,
        team_a_id,
        team_b_id,
        overs_limit,
        status,
        scorer_user_id,
        created_at,
        team_a:teams!matches_team_a_id_fkey ( id, name, short_name ),
        team_b:teams!matches_team_b_id_fkey ( id, name, short_name )
      `
      )
      .single();

    setSaving(false);
    setBusyId("");

    if (res.error) {
      setErr(`Update error: ${res.error.message}`);
      return;
    }

    setMatches((prev) => prev.map((m) => (m.id === editingId ? res.data : m)));
    setInfo("Match updated ✅");
    cancelEdit();
  };

  // -------------------------
  // DELETE (with hard checks)
  // -------------------------
  const deleteMatch = async (match) => {
    setErr("");
    setInfo("");

    const label = `${formatTeam(match.team_a)} vs ${formatTeam(match.team_b)}`;

    // eslint-disable-next-line no-restricted-globals
    if (!confirm(`Delete match: ${label}?\n\nThis will delete innings and balls too.`)) return;

    setBusyId(match.id);

    // 1) delete balls
    const delBalls = await supabase.from("balls").delete().eq("match_id", match.id);
    if (delBalls.error) {
      setBusyId("");
      setErr(`Delete balls error: ${delBalls.error.message}`);
      return;
    }

    // 2) delete innings
    const delInnings = await supabase.from("innings").delete().eq("match_id", match.id);
    if (delInnings.error) {
      setBusyId("");
      setErr(`Delete innings error: ${delInnings.error.message}`);
      return;
    }

    // 3) delete match
    const delMatch = await supabase.from("matches").delete().eq("id", match.id);
    if (delMatch.error) {
      setBusyId("");
      setErr(`Delete match error: ${delMatch.error.message}`);
      return;
    }

    setMatches((prev) => prev.filter((m) => m.id !== match.id));
    setBusyId("");
    setInfo("Match deleted ✅");

    if (editingId === match.id) cancelEdit();
  };

  if (loading) return <div>Loading...</div>;

  return (
    <div>
      <div style={{ display: "flex", gap: 12, alignItems: "baseline", flexWrap: "wrap" }}>
        <h2 style={{ marginTop: 0 }}>Matches</h2>
        <button onClick={load} disabled={creating || saving || !!busyId}>
          Refresh
        </button>
      </div>

      {err && <div style={{ color: "crimson", marginBottom: 10 }}>{err}</div>}
      {info && <div style={{ color: "green", marginBottom: 10 }}>{info}</div>}

      {/* Add fixture */}
      <div style={{ border: "1px solid #eee", borderRadius: 12, padding: 12, maxWidth: 980, marginBottom: 14 }}>
        <div style={{ fontWeight: 900, marginBottom: 10 }}>Add fixture</div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 140px auto", gap: 10 }}>
          <div>
            <div style={labelStyle}>Team A</div>
            <select value={newTeamA} onChange={(e) => setNewTeamA(e.target.value)} style={inputStyle} disabled={creating}>
              <option value="">Select team…</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <div style={labelStyle}>Team B</div>
            <select value={newTeamB} onChange={(e) => setNewTeamB(e.target.value)} style={inputStyle} disabled={creating}>
              <option value="">Select team…</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <div style={labelStyle}>Overs</div>
            <input
              type="number"
              min={1}
              value={newOvers}
              onChange={(e) => setNewOvers(e.target.value)}
              style={inputStyle}
              disabled={creating}
            />
          </div>

          <div style={{ display: "flex", alignItems: "end" }}>
            <button onClick={createFixture} disabled={creating || !newTeamA || !newTeamB || newTeamA === newTeamB}>
              {creating ? "Creating..." : "Create fixture"}
            </button>
          </div>
        </div>

        <div style={{ marginTop: 8, color: "#666", fontSize: 12 }}>
          Scorer will be set to your logged-in user.
        </div>
      </div>

      {/* Matches list */}
      {matches.length === 0 ? (
        <div style={{ color: "#666" }}>No matches found.</div>
      ) : (
        <div style={{ display: "grid", gap: 10, maxWidth: 980 }}>
          {matches.map((m) => {
            const isEditing = editingId === m.id;
            const isBusy = busyId === m.id;

            return (
              <div key={m.id} style={{ border: "1px solid #eee", borderRadius: 12, padding: 12 }}>
                {!isEditing ? (
                  <>
                    <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
                      <div style={{ fontWeight: 900, fontSize: 16 }}>
                        {formatTeam(m.team_a)} <span style={{ color: "#666" }}>vs</span> {formatTeam(m.team_b)}
                      </div>
                      <div style={{ color: "#666", fontSize: 13 }}>
                        Status: <b>{m.status || "draft"}</b> · Overs: <b>{m.overs_limit || 20}</b>
                      </div>
                    </div>

                    <div style={{ marginTop: 8, display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
                      <Link to={`/score/${m.fixture_id || m.id}`}>Open scorer</Link>
                      <Link to={`/match/${m.fixture_id || m.id}`}>Open spectator</Link>

                      <button onClick={() => startEdit(m)} disabled={creating || saving || isBusy}>
                        Edit
                      </button>
                      <button onClick={() => deleteMatch(m)} disabled={creating || saving || isBusy} style={{ color: "crimson" }}>
                        {isBusy ? "Deleting..." : "Delete"}
                      </button>
                    </div>

                    <div style={{ marginTop: 6, color: "#999", fontSize: 12 }}>
                      Fixture ID: {m.fixture_id || "—"} <span style={{ opacity: 0.6 }}>•</span> Match ID: {m.id}
                    </div>
                  </>
                ) : (
                  <>
                    <div style={{ fontWeight: 900, fontSize: 16, marginBottom: 10 }}>Edit fixture</div>

                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 140px 160px", gap: 10 }}>
                      <div>
                        <div style={labelStyle}>Team A</div>
                        <select value={editTeamA} onChange={(e) => setEditTeamA(e.target.value)} style={inputStyle}>
                          <option value="">Select team…</option>
                          {teams.map((t) => (
                            <option key={t.id} value={t.id}>
                              {t.name}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <div style={labelStyle}>Team B</div>
                        <select value={editTeamB} onChange={(e) => setEditTeamB(e.target.value)} style={inputStyle}>
                          <option value="">Select team…</option>
                          {teams.map((t) => (
                            <option key={t.id} value={t.id}>
                              {t.name}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <div style={labelStyle}>Overs</div>
                        <input
                          type="number"
                          min={1}
                          value={editOvers}
                          onChange={(e) => setEditOvers(e.target.value)}
                          style={inputStyle}
                        />
                      </div>

                      <div>
                        <div style={labelStyle}>Status</div>
                        <select value={editStatus} onChange={(e) => setEditStatus(e.target.value)} style={inputStyle}>
                          {statusOptions.map((s) => (
                            <option key={s} value={s}>
                              {s}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>

                    <div style={{ marginTop: 12, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                      <button onClick={saveEdit} disabled={saving || isBusy}>
                        {saving ? "Saving..." : "Save"}
                      </button>
                      <button onClick={cancelEdit} disabled={saving || isBusy}>
                        Cancel
                      </button>

                      <div style={{ marginLeft: "auto", display: "flex", gap: 12 }}>
                        <Link to={`/score/${m.fixture_id || m.id}`}>Open scorer</Link>
                        <Link to={`/match/${m.fixture_id || m.id}`}>Open spectator</Link>
                      </div>
                    </div>

                    <div style={{ marginTop: 6, color: "#999", fontSize: 12 }}>Match ID: {m.id}</div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const labelStyle = { fontSize: 12, color: "#666", marginBottom: 6 };
const inputStyle = { width: "100%", padding: 10 };
