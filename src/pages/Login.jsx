import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";

export default function Login() {
  const nav = useNavigate();
  const [email, setEmail] = useState("");
  const [sending, setSending] = useState(false);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data?.session?.user) nav("/");
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session?.user) nav("/");
    });

    return () => sub.subscription.unsubscribe();
  }, [nav]);

  const sendMagicLink = async (e) => {
    e.preventDefault();
    setSending(true);
    setMsg("");

    const { error } = await supabase.auth.signInWithOtp({ email });

    setSending(false);
    if (error) setMsg(error.message);
    else setMsg("Check your email for the login link.");
  };

  return (
    <div style={{ maxWidth: 520 }}>
      <h2>Scorer Login</h2>
      <p style={{ marginTop: -6, color: "#555" }}>
        Enter your email and we’ll send you a magic login link.
      </p>

      <form onSubmit={sendMagicLink} style={{ display: "flex", gap: 8 }}>
        <input
          type="email"
          placeholder="you@email.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          style={{ flex: 1, padding: 10, border: "1px solid #ccc", borderRadius: 8 }}
        />
        <button
          type="submit"
          disabled={!email || sending}
          style={{ padding: "10px 14px", borderRadius: 8, border: "1px solid #111", background: "#111", color: "white" }}
        >
          {sending ? "Sending..." : "Send link"}
        </button>
      </form>

      {msg && <div style={{ marginTop: 10, color: msg.includes("Check") ? "green" : "crimson" }}>{msg}</div>}
    </div>
  );
}
