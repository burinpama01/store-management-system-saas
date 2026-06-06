import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";

function loadEnv() {
  const env = {};
  const content = readFileSync(".env.local", "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx < 0) continue;
    env[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
  }
  return env;
}

const env = loadEnv();
const supabase = createClient(env["NEXT_PUBLIC_SUPABASE_URL"], env["SUPABASE_SERVICE_ROLE_KEY"], {
  auth: { autoRefreshToken: false, persistSession: false },
});

const { data, error } = await supabase
  .from("memberships")
  .select("id, user_id, role, store_id, organization_id, joined_at, invited_at");

console.log("Memberships:", JSON.stringify(data, null, 2));
if (error) console.error("Error:", error);

const { data: orgs } = await supabase.from("organizations").select("id, name, owner_id");
console.log("\nOrganizations:", JSON.stringify(orgs, null, 2));

const { data: stores } = await supabase.from("stores").select("id, name, is_active");
console.log("\nStores:", JSON.stringify(stores, null, 2));
