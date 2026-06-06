/**
 * สร้าง test user สำหรับ dev/local
 * ใช้ once: node scripts/create-test-user.mjs
 *
 * ต้องมี .env.local ที่มี NEXT_PUBLIC_SUPABASE_URL และ SUPABASE_SERVICE_ROLE_KEY
 */

import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";

// โหลด .env.local แบบ manual (ไม่ต้องใช้ dotenv)
function loadEnv() {
  const env = {};
  try {
    const content = readFileSync(".env.local", "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx < 0) continue;
      const key = trimmed.slice(0, idx).trim();
      const val = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
      env[key] = val;
    }
  } catch {
    console.error("ไม่พบ .env.local");
    process.exit(1);
  }
  return env;
}

const env = loadEnv();
const supabaseUrl = env["NEXT_PUBLIC_SUPABASE_URL"];
const serviceRoleKey = env["SUPABASE_SERVICE_ROLE_KEY"];
const args = new Set(process.argv.slice(2));
const isDryRun = args.has("--dry-run");
const confirmRemote = args.has("--confirm-remote");
const argValue = (prefix) => {
  const match = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : null;
};

if (!supabaseUrl || !serviceRoleKey) {
  console.error("ต้องมี NEXT_PUBLIC_SUPABASE_URL และ SUPABASE_SERVICE_ROLE_KEY ใน .env.local");
  process.exit(1);
}

const LOCAL_TEST_EMAIL = "owner@demo.com";
const LOCAL_TEST_PASSWORD = "Demo1234!";
const SEED_USER_ID = "00000000-0000-0000-0000-000000000001";

let targetHost = "unknown";
let isRemoteTarget = true;
try {
  const targetUrl = new URL(supabaseUrl);
  targetHost = targetUrl.host;
  isRemoteTarget = !["localhost", "127.0.0.1", "[::1]"].includes(targetUrl.hostname);
} catch {
  console.error("NEXT_PUBLIC_SUPABASE_URL is invalid");
  process.exit(1);
}

console.log(`Target Supabase: ${targetHost}${isRemoteTarget ? " (remote)" : " (local)"}`);

if (isRemoteTarget && confirmRemote && argValue("--target-host=") !== targetHost) {
  console.error(`Remote confirmation requires --target-host=${targetHost}.`);
  process.exit(1);
}

if (isRemoteTarget && !confirmRemote && !isDryRun) {
  console.error("Refusing to mutate remote Supabase without --confirm-remote.");
  console.error("Use --dry-run to inspect the planned test user action without network writes.");
  process.exit(1);
}

const TEST_EMAIL = isRemoteTarget ? env["TEST_USER_EMAIL"] : env["TEST_USER_EMAIL"] || LOCAL_TEST_EMAIL;
const TEST_PASSWORD = isRemoteTarget ? env["TEST_USER_PASSWORD"] : env["TEST_USER_PASSWORD"] || LOCAL_TEST_PASSWORD;

if (!isDryRun && (!TEST_EMAIL || !TEST_PASSWORD)) {
  console.error("Remote test user creation requires TEST_USER_EMAIL and TEST_USER_PASSWORD in .env.local.");
  process.exit(1);
}

if (isRemoteTarget && !isDryRun && (TEST_EMAIL === LOCAL_TEST_EMAIL || TEST_PASSWORD === LOCAL_TEST_PASSWORD)) {
  console.error("Refusing to use hardcoded demo credentials against remote Supabase.");
  process.exit(1);
}

if (isDryRun) {
  console.log("DRY RUN: no Supabase auth or database writes will be performed.");
  console.log(`Would ensure test user: ${TEST_EMAIL || "<set TEST_USER_EMAIL for remote writes>"}`);
  console.log(`Would update memberships and organizations from seed user ${SEED_USER_ID} to the real auth user id.`);
  process.exit(0);
}

const supabase = env["SCRIPT_TEST_SCENARIO"]
  ? createMockSupabase(env["SCRIPT_TEST_SCENARIO"])
  : createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

async function run() {
  console.log("🔧 สร้าง test user...");

  // ลอง list users ก่อนเพื่อดูว่ามีอยู่แล้วไหม
  const { data: existing, error: listErr } = await supabase.auth.admin.listUsers();
  if (listErr) {
    console.error("list users error:", listErr.message);
    process.exit(1);
  }

  const found = existing.users.find((u) => u.email === TEST_EMAIL);
  if (found) {
    console.log(`✅ User ${TEST_EMAIL} มีอยู่แล้ว (id: ${found.id})`);
    try {
      await applySeedMapping(found.id);
    } catch (membershipError) {
      console.error("membership mapping failed for existing user:", membershipError.message);
      try {
        await rollbackSeedMapping(membershipError.touchedMapping);
      } catch (rollbackError) {
        console.error("database rollback failed:", rollbackError.message);
      }
      process.exit(1);
    }
    return;
  }

  // สร้าง user ใหม่ด้วย id เดิมจาก seed (ถ้า Supabase อนุญาต)
  const { data, error } = await supabase.auth.admin.createUser({
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
    email_confirm: true,
    user_metadata: { full_name: "Demo Owner" },
  });

  if (error) {
    console.error("create user error:", error.message);
    process.exit(1);
  }

  console.log(`✅ สร้าง user สำเร็จ: ${data.user.email} (id: ${data.user.id})`);
  try {
    await applySeedMapping(data.user.id);
  } catch (membershipError) {
    console.error("membership mapping failed after user creation:", membershipError.message);
    try {
      await rollbackSeedMapping(membershipError.touchedMapping);
    } catch (rollbackError) {
      console.error("database rollback failed:", rollbackError.message);
    }
    const { error: deleteErr } = await supabase.auth.admin.deleteUser(data.user.id);
    if (deleteErr) {
      console.error("rollback delete user failed:", deleteErr.message);
    } else {
      console.error("rolled back created auth user");
    }
    process.exit(1);
  }
}

async function applySeedMapping(userId) {
  const touchedMapping = { membershipIds: [], organizationIds: [] };
  try {
    await updateMembership(userId, touchedMapping);
  } catch (error) {
    error.touchedMapping = touchedMapping;
    throw error;
  }
}

async function updateMembership(userId, touchedMapping) {
  if (userId === SEED_USER_ID) {
    console.log("ℹ️  user_id ตรงกับ seed แล้ว ไม่ต้องอัปเดต");
    return;
  }

  console.log(`🔧 อัปเดต membership และ organizations owner_id → ${userId}`);

  const { data: membershipRows, error: memErr } = await supabase
    .from("memberships")
    .update({ user_id: userId })
    .eq("user_id", SEED_USER_ID)
    .select("id");

  if (memErr) throw new Error(`membership update error: ${memErr.message}`);
  touchedMapping.membershipIds.push(...(membershipRows ?? []).map((row) => row.id));
  if (touchedMapping.membershipIds.length === 0) {
    throw new Error("membership update touched 0 rows; seed mapping is missing or was already moved");
  }
  console.log("✅ memberships อัปเดตแล้ว");

  const { data: organizationRows, error: orgErr } = await supabase
    .from("organizations")
    .update({ owner_id: userId })
    .eq("owner_id", SEED_USER_ID)
    .select("id");

  if (orgErr) throw new Error(`organizations update error: ${orgErr.message}`);
  touchedMapping.organizationIds.push(...(organizationRows ?? []).map((row) => row.id));
  if (touchedMapping.organizationIds.length === 0) {
    throw new Error("organizations update touched 0 rows; seed mapping is missing or was already moved");
  }
  console.log("✅ organizations owner_id อัปเดตแล้ว");

  console.log("\n📋 Test credentials:");
  console.log(`   Email:    ${TEST_EMAIL}`);
  console.log("   Password: configured in TEST_USER_PASSWORD or local demo fallback");
}

async function rollbackSeedMapping(touchedMapping = { membershipIds: [], organizationIds: [] }) {
  let failed = false;

  if (touchedMapping.membershipIds.length > 0) {
    const { error: memRollbackErr } = await supabase
      .from("memberships")
      .update({ user_id: SEED_USER_ID })
      .in("id", touchedMapping.membershipIds)
      .select("id");

    if (memRollbackErr) {
      failed = true;
      console.error("memberships rollback error:", memRollbackErr.message);
    } else {
      console.error("rolled back memberships mapping");
    }
  } else {
    console.error("no membership mapping touched in this attempt");
  }

  if (touchedMapping.organizationIds.length > 0) {
    const { error: orgRollbackErr } = await supabase
      .from("organizations")
      .update({ owner_id: SEED_USER_ID })
      .in("id", touchedMapping.organizationIds)
      .select("id");

    if (orgRollbackErr) {
      failed = true;
      console.error("organizations rollback error:", orgRollbackErr.message);
    } else {
      console.error("rolled back organizations owner_id mapping");
    }
  } else {
    console.error("no organization mapping touched in this attempt");
  }

  if (failed) {
    throw new Error("manual remediation required for partially mapped test user");
  }
}

function createMockSupabase(scenario) {
  const mockUser = { id: "11111111-1111-1111-1111-111111111111", email: TEST_EMAIL };
  const hasExistingUser = scenario === "existing-user-org-fail-after-membership";

  return {
    auth: {
      admin: {
        async listUsers() {
          return { data: { users: hasExistingUser ? [mockUser] : [] }, error: null };
        },
        async createUser() {
          console.log("MOCK create auth user");
          return { data: { user: mockUser }, error: null };
        },
        async deleteUser(userId) {
          console.error(`MOCK delete auth user ${userId}`);
          return { error: null };
        },
      },
    },
    from(table) {
      return {
        update(values) {
          const buildResult = (column, value) => {
            const isForwardOrgUpdate =
              (scenario === "org-fail-after-membership" || scenario === "existing-user-org-fail-after-membership") &&
              table === "organizations" &&
              column === "owner_id" &&
              value === SEED_USER_ID;
            const isNoSeedMapping =
              scenario === "no-seed-mapping" &&
              (table === "memberships" || table === "organizations") &&
              (column === "user_id" || column === "owner_id") &&
              value === SEED_USER_ID;

            const rowId = `${table}-row-1`;

            return {
              async select() {
                if (isForwardOrgUpdate) {
                  return { data: null, error: new Error("mock organizations update failed") };
                }
                if (isNoSeedMapping) {
                  console.error(`MOCK update ${table} touched 0 rows where ${column}=${JSON.stringify(value)}`);
                  return { data: [], error: null };
                }

                console.error(`MOCK update ${table} set ${JSON.stringify(values)} where ${column}=${JSON.stringify(value)}`);
                return { data: [{ id: rowId }], error: null };
              },
            };
          };

          return {
            eq(column, value) {
              return buildResult(column, value);
            },
            in(column, values) {
              return buildResult(column, values);
            },
          };
        },
      };
    },
  };
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
