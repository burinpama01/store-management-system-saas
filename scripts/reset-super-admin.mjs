import { randomBytes } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const EMAIL = "burinpama@gmail.com";
const ORG_SLUG = "demo-restaurant";

function loadEnv() {
  const env = {};
  for (const file of [".env.local", ".env"]) {
    if (!existsSync(file)) continue;
    const content = readFileSync(file, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx < 0) continue;
      const key = trimmed.slice(0, idx).trim();
      const value = trimmed.slice(idx + 1).trim().replace(/^['"]|['"]$/g, "");
      if (!(key in env)) env[key] = value;
    }
  }
  return env;
}

function maskId(id) {
  if (!id) return "";
  return `${id.slice(0, 8)}...${id.slice(-6)}`;
}

async function listUsersByEmail(supabase, email) {
  const matches = [];
  let page = 1;
  const perPage = 1000;

  while (true) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) throw new Error(`list users failed: ${error.message}`);
    matches.push(...data.users.filter((user) => user.email?.toLowerCase() === email));
    if (data.users.length < perPage) break;
    page += 1;
  }

  return matches;
}

async function main() {
  const env = loadEnv();
  const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  const appUrl = (env.NEXT_PUBLIC_APP_URL || "http://localhost:3000").replace(/\/$/, "");

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const existingUsers = await listUsersByEmail(supabase, EMAIL);
  for (const user of existingUsers) {
    const { error: membershipError } = await supabase
      .from("memberships")
      .delete()
      .eq("user_id", user.id);
    if (membershipError) throw new Error(`delete memberships failed: ${membershipError.message}`);

    const { error: deleteError } = await supabase.auth.admin.deleteUser(user.id);
    if (deleteError) throw new Error(`delete user failed: ${deleteError.message}`);
  }

  const { data: org, error: orgError } = await supabase
    .from("organizations")
    .select("id, slug")
    .eq("slug", ORG_SLUG)
    .single();
  if (orgError) throw new Error(`load organization failed: ${orgError.message}`);

  const temporaryPassword = `${randomBytes(18).toString("base64url")}Aa1!`;
  const { data: created, error: createError } = await supabase.auth.admin.createUser({
    email: EMAIL,
    password: temporaryPassword,
    email_confirm: true,
    user_metadata: { full_name: "System Super Admin" },
  });
  if (createError) throw new Error(`create user failed: ${createError.message}`);
  if (!created.user) throw new Error("create user returned no user");

  const now = new Date().toISOString();
  const { error: membershipError } = await supabase.from("memberships").insert({
    organization_id: org.id,
    store_id: null,
    user_id: created.user.id,
    role: "super_admin",
    invited_at: now,
    joined_at: now,
  });
  if (membershipError) throw new Error(`insert membership failed: ${membershipError.message}`);

  const { error: resetError } = await supabase.auth.resetPasswordForEmail(EMAIL, {
    redirectTo: `${appUrl}/update-password`,
  });
  if (resetError) {
    await supabase.from("memberships").delete().eq("user_id", created.user.id);
    await supabase.auth.admin.deleteUser(created.user.id);
    throw new Error(`reset email failed; rolled back created user: ${resetError.message}`);
  }

  console.log(JSON.stringify({
    email: EMAIL,
    deletedUsers: existingUsers.length,
    createdUser: maskId(created.user.id),
    emailConfirmed: Boolean(created.user.email_confirmed_at),
    membership: "super_admin:org",
    resetEmailSent: true,
    resetEmailError: null,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
