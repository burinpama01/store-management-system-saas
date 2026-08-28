import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "../..");
const readRepo = (rel: string) => readFileSync(path.join(repoRoot, rel), "utf8");

describe("store setup_profile migration contract (static SQL)", () => {
  const sql = readRepo("supabase/migrations/20260827000001_store_setup_profile.sql");

  it("adds a not-null jsonb column defaulted to an empty object (legacy rows keep behaving)", () => {
    expect(sql).toContain("alter table public.stores add column setup_profile jsonb not null default '{}'::jsonb;");
  });

  it("constrains the column to a JSON object via a named check", () => {
    expect(sql).toContain("stores_setup_profile_object_chk");
    expect(sql).toContain("check (jsonb_typeof(setup_profile) = 'object')");
  });

  it("is additive only — never drops, deletes or truncates", () => {
    expect(sql).not.toMatch(/drop\s+(column|table)/i);
    expect(sql).not.toMatch(/delete\s+from/i);
    expect(sql).not.toMatch(/truncate/i);
  });

  it("is UTF-8 clean (no replacement chars / mojibake markers)", () => {
    expect(sql).not.toContain("\uFFFD");
  });
});

describe("setup profile server action contract (source guards)", () => {
  const actions = readRepo("src/app/onboarding/actions.ts");

  it("requires the settings.manage_store permission", () => {
    expect(actions).toContain('requirePermission("settings.manage_store")');
  });

  it("parses input through the allowlist parser (unknown keys rejected)", () => {
    expect(actions).toContain("parseSetupProfile(");
  });

  it("updates the store row scoped by id AND organization_id", () => {
    expect(actions).toContain('updateStoreSetupProfile(ctx.storeId, ctx.organizationId');
  });
  it("updates the store row scoped by id AND organization_id (repository)", () => {
    expect(readRepo("src/modules/stores/repository.ts")).toMatch(
      /updateStoreSetupProfile[\s\S]*?\.eq\("id", storeId\)[\s\S]*?\.eq\("organization_id", organizationId\)/,
    );
  });

  it("writes an audit log with before/after", () => {
    expect(actions).toContain('"audit_logs"');
    expect(actions).toContain("before");
  });

  it("revalidates the onboarding page after saving", () => {
    expect(actions).toContain('revalidatePath("/onboarding")');
  });
});

describe("readiness repository contract (source guards)", () => {
  const repo = readRepo("src/modules/onboarding/repository.ts");

  it("scopes every count query by organization_id and store_id", () => {
    expect(repo).toContain('.eq("store_id", storeId)');
    expect(repo).toContain('.eq("organization_id", organizationId)');
  });

  it("counts real paid orders, not just products", () => {
    expect(repo).toContain('"orders"');
    expect(repo).toContain('countRows("orders"');
    expect(repo).toContain('{ status: "paid" }');
  });

  it("derives profileComplete from real store fields", () => {
    expect(repo).toContain("profileComplete");
  });
});

describe("dashboard nav filter contract (source guards)", () => {
  const layout = readRepo("src/app/(dashboard)/layout.tsx");

  it("hides the QR Order nav item only when a saved profile says the store does not use tables", () => {
    expect(layout).toContain("qrOrdersVisible");
    expect(layout).toContain("usesTables !== false");
  });

  it("keeps legacy stores (no profile) on the legacy navigation", () => {
    expect(layout).toContain("parseSetupProfileOrNull");
  });
});