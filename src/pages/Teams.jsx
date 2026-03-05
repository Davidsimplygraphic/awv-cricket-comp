import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabase";

export default function Teams() {
  const [teams, setTeams] = useState([]);
  const [err, setErr] = useState("");

  useEffect(() => {
    (async () => {
      setErr("");
      const res = await supabase.from("teams").select("*").order("name");
      if (res.error) setErr(res.error.message);
      setTeams(res.data || []);
    })();
  }, []);

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Teams</h2>
      {err && <div style={{ color: "crimson" }}>{err}</div>}

      {teams.length === 0 ? (
        <div style={{ color: "#666" }}>No teams found.</div>
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          {teams.map((t) => (
            <div key={t.id} style={{ border: "1px solid #eee", borderRadius: 12, padding: 12 }}>
              <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
                <div style={{ fontWeight: 800, fontSize: 18 }}>{t.name}</div>
                {t.short_name && <div style={{ color: "#666" }}>({t.short_name})</div>}
              </div>

              <div style={{ marginTop: 8 }}>
                <Link to={`/teams/${t.id}`}>Manage roster</Link>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
