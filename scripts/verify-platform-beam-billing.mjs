import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

// Fixed local Docker target. Migration, fixture and tests are rolled back together.
const sql = "BEGIN;\n" + readFileSync(new URL("../supabase/migrations/20260921000000_platform_beam_billing.sql", import.meta.url), "utf8")
  + "\n" + readFileSync(new URL("../tests/integration/platform-beam-billing.sql", import.meta.url), "utf8") + "\nROLLBACK;\n";
const result = spawnSync("docker", ["exec", "-i", "supabase_db_Store_management_system_saas", "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1"], { input: sql, encoding: "utf8" });
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
process.exit(result.status ?? 1);
