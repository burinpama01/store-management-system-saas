/**
 * Creates one test user per role (admin/manager/cashier/staff) in the Demo org
 * for RBAC QA. Idempotent. Service-role; remote-write guarded by --confirm-remote.
 *
 *   node scripts/create-role-test-users.mjs --dry-run
 *   node scripts/create-role-test-users.mjs --confirm-remote --target-host=<host>
 *
 * Password is taken from QA_TEST_PASSWORD env (falls back to a documented default
 * for throwaway test accounts). Never prints the password.
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";

function loadEnv() {
  const env = {};
  for (const line of readFileSync(".env.local", "utf-8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
  return env;
}

const env = loadEnv();
const url = env.NEXT_PUBLIC_SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY;
const args = new Set(process.argv.slice(2));
const argVal = (p) => process.argv.slice(2).find((a) => a.startsWith(p))?.slice(p.length) ?? null;
const isDryRun = args.has("--dry-run");
const confirmRemote = args.has("--confirm-remote");

if (!url || !key) { console.error("missing supabase env"); process.exit(1); }

const host = new URL(url).host;
const isRemote = !["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname);
console.log(`Target: ${host}${isRemote ? " (remote)" : " (local)"}`);

if (isRemote && confirmRemote && argVal("--target-host=") !== host) {
  console.error(`Remote confirmation requires --target-host=${host}`); process.exit(1);
}
if (isRemote && !confirmRemote && !isDryRun) {
  console.error("Refusing remote write without --confirm-remote (use --dry-run to preview)"); process.exit(1);
}

const ORG_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const PASSWORD = env.QA_TEST_PASSWORD || "QaRole!2026";
const ROLE_USERS = [
  { email: "admin@demo.com", role: "admin" },
  { email: "manager@demo.com", role: "manager" },
  { email: "cashier@demo.com", role: "cashier" },
  { email: "staff@demo.com", role: "staff" },
];

if (isDryRun) {
  console.log("DRY RUN — would ensure these users + org-wide memberships in", ORG_ID);
  for (const u of ROLE_USERS) console.log(`  ${u.email} -> ${u.role}`);
  process.exit(0);
}

const s = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

const { data: list, error: listErr } = await s.auth.admin.listUsers();
if (listErr) { console.error("listUsers:", listErr.message); process.exit(1); }

for (const u of ROLE_USERS) {
  let user = list.users.find((x) => x.email === u.email);
  if (!user) {
    const { data, error } = await s.auth.admin.createUser({
      email: u.email,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { full_name: `Demo ${u.role}` },
    });
    if (error) { console.error(`create ${u.email}:`, error.message); continue; }
    user = data.user;
    console.log(`created ${u.email} (${user.id.slice(0, 8)})`);
  } else {
    console.log(`exists  ${u.email} (${user.id.slice(0, 8)})`);
  }

  const { data: existing } = await s
    .from("memberships")
    .select("id, role")
    .eq("organization_id", ORG_ID)
    .eq("user_id", user.id)
    .is("store_id", null)
    .maybeSingle();

  const now = new Date().toISOString();
  if (existing) {
    if (existing.role !== u.role) {
      await s.from("memberships").update({ role: u.role }).eq("id", existing.id);
      console.log(`  membership role -> ${u.role}`);
    } else {
      console.log(`  membership ok (${u.role})`);
    }
  } else {
    const { error: mErr } = await s.from("memberships").insert({
      organization_id: ORG_ID,
      store_id: null,
      user_id: user.id,
      role: u.role,
      invited_at: now,
      joined_at: now,
    });
    if (mErr) console.error(`  membership insert:`, mErr.message);
    else console.log(`  membership created (${u.role})`);
  }
}
console.log("done");
