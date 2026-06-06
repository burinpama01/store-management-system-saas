/**
 * Generates a one-time Supabase recovery (set-password) link via the admin API,
 * bypassing email delivery. Hand the link to the account owner to set their
 * password. The link is single-use and short-lived.
 *
 *   node scripts/gen-recovery-link.mjs <email> [redirectBaseUrl]
 *
 * Defaults: email=burinpama@gmail.com, redirect=http://localhost:3010/update-password
 */
import { readFileSync, existsSync } from "fs";
import { createClient } from "@supabase/supabase-js";

function loadEnv() {
  const env = {};
  for (const file of [".env.local", ".env"]) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const i = t.indexOf("=");
      if (i < 0) continue;
      const k = t.slice(0, i).trim();
      if (!(k in env)) env[k] = t.slice(i + 1).trim().replace(/^['"]|['"]$/g, "");
    }
  }
  return env;
}

const env = loadEnv();
const url = env.NEXT_PUBLIC_SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.error("missing supabase env"); process.exit(1); }

const email = process.argv[2] || "burinpama@gmail.com";
const base = (process.argv[3] || "http://localhost:3010").replace(/\/$/, "");

const s = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
const { data, error } = await s.auth.admin.generateLink({
  type: "recovery",
  email,
  options: { redirectTo: `${base}/update-password` },
});
if (error) { console.error("generateLink failed:", error.message); process.exit(1); }

console.log("email:", email);
console.log("recovery link (one-time, open in browser to set password):");
console.log(data.properties?.action_link ?? "(no link returned)");
