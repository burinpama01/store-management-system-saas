import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const root = process.cwd();
const migrationPath = "supabase/migrations/20260905000005_api_key_inventory_scope.sql";

function read(path: string) {
  return readFileSync(join(root, path), "utf8");
}

function normalized(path: string) {
  return read(path).toLowerCase().replace(/\s+/g, " ");
}

async function loadAuth(row: {
  id: string;
  organization_id: string;
  revoked_at: string | null;
  scopes: string[] | null;
} | null) {
  vi.resetModules();
  const maybeSingle = vi.fn(async () => ({ data: row, error: null }));
  const selectQuery: Record<string, unknown> = {};
  selectQuery.eq = vi.fn(() => selectQuery);
  selectQuery.maybeSingle = maybeSingle;
  const usageEq = vi.fn(async () => ({ error: null }));
  const supabase = {
    from: vi.fn(() => ({
      select: vi.fn(() => selectQuery),
      update: vi.fn(() => ({ eq: usageEq })),
    })),
  };

  vi.doMock("@/server/integrations/supabase/server", () => ({
    createSupabaseServiceClient: vi.fn(async () => supabase),
  }));
  vi.doMock("@/modules/billing/billing-service", () => ({
    getOrganizationBillingState: vi.fn(async () => ({})),
  }));
  vi.doMock("@/modules/billing/types", () => ({
    canUseFeature: vi.fn(() => true),
    DEFAULT_BILLING_STATE: {},
  }));

  return { auth: await import("@/modules/api-keys/auth"), supabase, usageEq };
}

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe("inventory API scopes", () => {
  it("migrates only empty legacy keys and creates a private movement claim ledger", () => {
    expect(existsSync(join(root, migrationPath))).toBe(true);
    const sql = normalized(migrationPath);

    expect(sql).toMatch(/alter table public\.api_keys alter column scopes set default array\[\s*'products\.read', 'inventory\.read', 'orders\.read'\s*\]::text\[\]/);
    expect(sql).toMatch(/update public\.api_keys set scopes = array\[\s*'products\.read', 'inventory\.read', 'orders\.read'\s*\]::text\[\] where coalesce\(cardinality\(scopes\), 0\) = 0/);
    expect(sql).not.toMatch(/update public\.api_keys set scopes = .*where .*@>/);
    expect(sql).toContain("create table public.stock_movement_notification_claims");
    expect(sql).toContain("movement_id uuid primary key references public.stock_movements(id) on delete cascade");
    expect(sql).toContain("alter table public.stock_movement_notification_claims enable row level security");
    expect(sql).toContain("revoke all privileges on table public.stock_movement_notification_claims from public, anon, authenticated");
    expect(sql).toContain("grant select, insert, delete on table public.stock_movement_notification_claims to service_role");
    expect(sql).not.toContain("security definer");
    expect(sql).toContain("create unique index notifications_stock_movement_idempotency_idx on public.notifications ((metadata ->> 'stockmovementid')) where type = 'stock_alert' and nullif(metadata ->> 'stockmovementid', '') is not null");
  });

  it("returns 401 for missing, invalid, or revoked keys", async () => {
    const missing = await loadAuth(null);
    await expect(missing.auth.authenticateApiKey(new Request("https://example.test"))).resolves.toMatchObject({ ok: false, status: 401 });
    expect(missing.supabase.from).not.toHaveBeenCalled();

    const invalid = await loadAuth(null);
    await expect(invalid.auth.authenticateApiKey(new Request("https://example.test", { headers: { authorization: "Bearer bad" } }))).resolves.toMatchObject({ ok: false, status: 401 });

    const revoked = await loadAuth({ id: "key-1", organization_id: "org-1", revoked_at: "2026-08-01T00:00:00Z", scopes: ["inventory.read"] });
    await expect(revoked.auth.authenticateApiKey(new Request("https://example.test", { headers: { "x-api-key": "revoked" } }), "inventory.read")).resolves.toMatchObject({ ok: false, status: 401 });
  });

  it("returns 403 for a missing required scope and returns identity plus scopes on success", async () => {
    const denied = await loadAuth({ id: "key-1", organization_id: "org-1", revoked_at: null, scopes: ["products.read"] });
    await expect(denied.auth.authenticateApiKey(new Request("https://example.test", { headers: { authorization: "Bearer valid" } }), "inventory.read")).resolves.toMatchObject({ ok: false, status: 403 });
    expect(denied.usageEq).not.toHaveBeenCalled();

    const allowed = await loadAuth({ id: "key-2", organization_id: "org-1", revoked_at: null, scopes: ["products.read", "inventory.read"] });
    await expect(allowed.auth.authenticateApiKey(new Request("https://example.test", { headers: { authorization: "Bearer valid" } }), "inventory.read")).resolves.toEqual({
      ok: true,
      organizationId: "org-1",
      apiKeyId: "key-2",
      scopes: ["products.read", "inventory.read"],
    });
  });

  it("enforces route scopes and explicitly scopes Pool inventory by organization and optional store", () => {
    const products = normalized("src/app/api/v1/products/route.ts");
    const orders = normalized("src/app/api/v1/orders/route.ts");
    const inventory = normalized("src/app/api/v1/inventory/route.ts");

    expect(products).toContain('authenticateapikey(req, "products.read")');
    expect(orders).toContain('authenticateapikey(req, "orders.read")');
    expect(inventory).toContain('authenticateapikey(req, "inventory.read")');
    expect(inventory).toContain('.from("stock_pools")');
    expect(inventory).toContain('.eq("organization_id", auth.organizationid)');
    expect(inventory).toContain('url.searchparams.get("store_id")');
    expect(inventory).toContain('.eq("store_id", storeid)');
    expect(inventory).toContain('.from("variant_stock_links")');
    expect(inventory).toContain('.from("product_variants")');
    expect(inventory).toContain('.from("products")');
    // สัญญาเดิมของ API ต้องไม่พัง: ยังคืนเป็นแถวระดับ variant พร้อม stock_quantity
    // เดิม แล้วเติม stock_pool + available_quantity เข้าไป (ไม่ใช่เปลี่ยนเป็นแถว Pool)
    expect(inventory).toContain('"id, product_id, name, stock_quantity, track_stock, is_active"');
    expect(inventory).toContain('stock_pool:');
    expect(inventory).toContain('available_quantity');
    expect(inventory).toContain('consumption_quantity');
  });
});
