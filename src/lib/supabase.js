import { createClient } from "@supabase/supabase-js";

const supabaseUrl = String(import.meta.env.VITE_SUPABASE_URL || "").trim();
const supabaseAnonKey = String(import.meta.env.VITE_SUPABASE_ANON_KEY || "").trim();

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error("Missing Supabase environment configuration. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.");
}

if (typeof window !== "undefined" && /localhost|127\.0\.0\.1/i.test(supabaseUrl)) {
  console.warn("Supabase is configured against a localhost URL. Verify this is intentional for the current environment.");
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: true,
  },
});
