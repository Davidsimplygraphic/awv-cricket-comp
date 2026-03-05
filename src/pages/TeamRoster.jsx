import { useEffect, useMemo, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { supabase } from "../lib/supabase";

export default function TeamRoster() {
  const { teamId } = useParams();

  const [team, setTeam] = useState(null);
  const [players, setPlayers] = useState([]);

  const [newPlayerName, setNewPlayerName] = useState("");

  // Team rename
  const [editingTeam, setEditingTeam] = useState(false);
  const [teamNameDraft, setTeamNameDraft] = useState("");

  // Player rename
  const [editingPlayerId, setEditingPlayerId] = useState(null);
  const [playerNameDraft, setPlayerNameDraft] = useState("");

  // UI helpers
  const [showInactive, setShowInactive] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");

  const load = async () => {
    setErr("");
    setInfo("");

    // Team
    const t = await supabase.from("teams").select("*").eq("id", teamId).single();
    if (t.error) {
      setErr(t.error.message);
      return;
    }
    setTeam(t.data);
    setTeamNameDraft(t.data?.name || "");
    setEditingTeam(false);

    // Players (using VIEW with has_usage)
    const p = await supabase
      .from("players_with_usage")
      .select("id,team_id,name,active,has_usage")
      .eq("team_id", teamId)
      .order("name");

    if (p.error) {
      setErr(p.error.message);
      return;
    }

    setPlayers(p.data || []);
    setEditingPlayerId(null);
    setPlayerNameDraft("");
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamId]);

  const visiblePlayers = useMemo(() => {
    if (showInactive) return players;
    return players.filter((p) => p.active);
  }, [players, showInactive]);

  // --- Add player ---
  const addPlayer = async () => {
    const name = (newPlayerName || "").trim();
    if (!name) return;

    setSaving(true);
    setErr("");
    setInfo("");

    const res = await supabase
      .from("players")
      .insert({ team_id: teamId, name, active: true })
      .select("id,team_id,name,active")
      .single();

    setSaving(false);

    if (res.error) {
      setErr(res.error.message);
      return;
    }

    // new player has no usage
    const newRow = { ...res.data, has_usage: false };

    setPlayers((prev) =>
      [...prev, newRow].sort((a, b) => (a.name || "").localeCompare(b.name || ""))
    );
    setNewPlayerName("");
    setInfo("Player added ✅");
  };

  // --- Player edit ---
  const startEditPlayer = (player) => {
    setErr("");
    setInfo("");
    setEditingPlayerId(player.id);
    setPlayerNameDraft(player.name || "");
  };

  const cancelEditPlayer = () => {
    setEditingPlayerId(null);
    setPlayerNameDraft("");
  };

  const savePlayerName = async (player) => {
    const newName = (playerNameDraft || "").trim();
    if (!newName) return;

    setSaving(true);
    setErr("");
    setInfo("");

    const res = await supabase
      .from("players")
      .update({ name: newName })
      .eq("id", player.id)
      .select("id,team_id,name,active")
      .single();

    setSaving(false);

    if (res.error) {
      setErr(`Rename failed: ${res.error.message}`);
      return;
    }

    setPlayers((prev) =>
      prev
        .map((p) => (p.id === player.id ? { ...p, ...res.data } : p))
        .sort((a, b) => (a.name || "").localeCompare(b.name || ""))
    );

    cancelEditPlayer();
    setInfo("Player renamed ✅");
  };

  // --- Team edit ---
  const startEditTeam = () => {
    setEditingTeam(true);
    setTeamNameDraft(team?.name || "");
  };

  const cancelEditTeam = () => {
    setEditingTeam(false);
    setTeamNameDraft(team?.name || "");
  };

  const saveTeamName = async () => {
    const newName = (teamNameDraft || "").trim();
    if (!newName) return;

    setSaving(true);
    setErr("");
    setInfo("");

    const res = await supabase.from("teams").update({ name: newName }).eq("id", teamId).select("*").single();

    setSaving(false);

    if (res.error) {
      setErr(`Team rename failed: ${res.error.message}`);
      return;
    }

    setTeam(res.data);
    setEditingTeam(false);
    setInfo("Team renamed ✅");
  };

  // --- Active toggle ---
  const toggleActive = async (player) => {
    setSaving(true);
    setErr("");
    setInfo("");

    const res = await supabase
      .from("players")
      .update({ active: !player.active })
      .eq("id", player.id)
      .select("id,team_id,name,active")
      .single();

    setSaving(false);

    if (res.error) {
      setErr(`Update failed: ${res.error.message}`);
      return;
    }

    setPlayers((prev) => prev.map((p) => (p.id === player.id ? { ...p, ...res.data } : p)));
  };

  // --- Delete vs Archive ---
  const deleteOrArchivePlayer = async (player) => {
    setErr("");
    setInfo("");

    // If player has match usage, must archive (active=false)
    if (player.has_usage) {
      if (!confirm(`"${player.name}" has match history.\n\nArchive them (hide from active list) instead?`)) return;

      setSaving(true);
      const { error } = await supabase.from("players").update({ active: false }).eq("id", player.id);
      setSaving(false);

      if (error) {
        setErr(`Archive failed: ${error.message}`);
        return;
      }

      setPlayers((prev) => prev.map((p) => (p.id === player.id ? { ...p, active: false } : p)));
      setInfo("Player archived ✅");
      return;
    }

    // No usage: safe delete
    if (!confirm(`Delete "${player.name}" permanently?\n\nThis cannot be undone.`)) return;

    setSaving(true);
    const { error } = await supabase.from("players").delete().eq("id", player.id);
    setSaving(false);

    if (error) {
      setErr(`Delete failed: ${error.message}`);
      return;
    }

    setPlayers((prev) => prev.filter((p) => p.id !== player.id));
    setInfo("Player deleted ✅");
  };

  return (
    <div>
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        {!editingTeam ? (
          <>
            <h2 style={{ margin: 0 }}>{team ? `${team.name} — Roster` : "Roster"}</h2>
            {team && (
              <button onClick={startEditTeam} disabled={saving} style={{ marginLeft: 8 }}>
                Edit team name
              </button>
            )}
          </>
        ) : (
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <input
              value={teamNameDraft}
              onChange={(e) => setTeamNameDraft(e.target.value)}
              placeholder="Team name"
              style={{ padding: 10, minWidth: 260 }}
              onKeyDown={(e) => e.key === "Enter" && saveTeamName()}
              disabled={saving}
            />
            <button onClick={saveTeamName} disabled={saving || !teamNameDraft.trim()}>
              {saving ? "Saving..." : "Save"}
            </button>
            <button onClick={cancelEditTeam} disabled={saving}>
              Cancel
            </button>
          </div>
        )}

        <Link to="/teams">← Back to teams</Link>

        <div style={{ marginLeft: "auto", display: "flex", gap: 10, alignItems: "center" }}>
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
            />
            Show inactive
          </label>

          <button onClick={load} disabled={saving}>
            Refresh
          </button>
        </div>
      </div>

      {err && <div style={{ color: "crimson", marginTop: 10 }}>{err}</div>}
      {info && <div style={{ color: "green", marginTop: 10 }}>{info}</div>}

      <div style={{ marginTop: 14, padding: 12, border: "1px solid #eee", borderRadius: 12, maxWidth: 640 }}>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>Add player</div>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            value={newPlayerName}
            onChange={(e) => setNewPlayerName(e.target.value)}
            placeholder="Player name"
            style={{ flex: 1, padding: 10 }}
            onKeyDown={(e) => e.key === "Enter" && addPlayer()}
            disabled={saving}
          />
          <button onClick={addPlayer} disabled={saving || !newPlayerName.trim()} style={{ padding: "10px 14px" }}>
            {saving ? "Adding..." : "Add"}
          </button>
        </div>
      </div>

      <h3 style={{ marginTop: 18 }}>Players</h3>

      {visiblePlayers.length === 0 ? (
        <div style={{ color: "#666" }}>No players to show.</div>
      ) : (
        <div style={{ display: "grid", gap: 8, maxWidth: 640 }}>
          {visiblePlayers.map((p) => (
            <div
              key={p.id}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                border: "1px solid #f0f0f0",
                borderRadius: 10,
                padding: 10,
              }}
            >
              <div style={{ flex: 1 }}>
                {editingPlayerId === p.id ? (
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <input
                      value={playerNameDraft}
                      onChange={(e) => setPlayerNameDraft(e.target.value)}
                      style={{ padding: 8, minWidth: 240 }}
                      onKeyDown={(e) => e.key === "Enter" && savePlayerName(p)}
                      disabled={saving}
                    />
                    <button onClick={() => savePlayerName(p)} disabled={saving || !playerNameDraft.trim()}>
                      {saving ? "Saving..." : "Save"}
                    </button>
                    <button onClick={cancelEditPlayer} disabled={saving}>
                      Cancel
                    </button>
                  </div>
                ) : (
                  <>
                    <div style={{ fontWeight: 700, display: "flex", gap: 8, alignItems: "center" }}>
                      <span>{p.name}</span>
                      {p.has_usage && (
                        <span style={{ fontSize: 12, padding: "2px 6px", border: "1px solid #ddd", borderRadius: 999 }}>
                          has history
                        </span>
                      )}
                      {!p.active && (
                        <span style={{ fontSize: 12, padding: "2px 6px", border: "1px solid #ddd", borderRadius: 999 }}>
                          inactive
                        </span>
                      )}
                    </div>
                    <div style={{ color: "#666", fontSize: 12 }}>{p.active ? "Active" : "Inactive"}</div>
                  </>
                )}
              </div>

              <div style={{ display: "flex", gap: 8 }}>
                {editingPlayerId !== p.id && (
                  <button onClick={() => startEditPlayer(p)} disabled={saving}>
                    Edit
                  </button>
                )}

                <button onClick={() => toggleActive(p)} disabled={saving}>
                  {p.active ? "Deactivate" : "Activate"}
                </button>

                <button onClick={() => deleteOrArchivePlayer(p)} disabled={saving} style={{ color: "crimson" }}>
                  {p.has_usage ? "Archive" : "Delete"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}