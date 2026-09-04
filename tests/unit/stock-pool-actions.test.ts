import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const root = process.cwd();
const repositoryPath = "src/modules/stock/pool-repository.ts";
const migrationPath = "supabase/migrations/20260905000002_stock_pool_adjustment_rpc.sql";

function read(path: string) {
  return readFileSync(join(root, path), "utf8");
}

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

async function importActions(options: {
  permissionError?: Error;
  featureError?: Error;
  adjustmentResult?: { ok: boolean; error: { userMessage: string } | null };
} = {}) {
  vi.resetModules();
  const requirePermission = vi.fn(async () => {
    if (options.permissionError) throw options.permissionError;
  });
  const requireFeature = vi.fn(async () => {
    if (options.featureError) throw options.featureError;
  });
  const getResolvedCurrentPermissions = vi.fn(async () => ({
    ctx: { storeId: "store-current" },
    resolved: { can: () => true },
  }));
  const adjustStockPool = vi.fn(async () => options.adjustmentResult ?? {
    ok: true,
    error: null,
    data: { id: "pool-1", quantity: 10 },
  });
  const logSystemEvent = vi.fn(async () => {});
  const setVariantStock = vi.fn(async () => ({ ok: true, error: null }));
  const revalidatePath = vi.fn();

  class AuthorizationError extends Error {}
  vi.doMock("next/cache", () => ({ revalidatePath }));
  vi.doMock("@/modules/auth/guards", () => ({
    AuthorizationError,
    getResolvedCurrentPermissions,
    requireFeature,
    requirePermission,
  }));
  vi.doMock("@/modules/stock/pool-repository", () => ({ adjustStockPool }));
  vi.doMock("@/modules/stock/repository", () => ({ setVariantStock }));
  vi.doMock("@/modules/system/event-log", () => ({ logSystemEvent }));

  const actions = await import("@/app/(dashboard)/stock/actions");
  return {
    actions,
    adjustStockPool,
    getResolvedCurrentPermissions,
    revalidatePath,
    requireFeature,
    requirePermission,
    setVariantStock,
    logSystemEvent,
  };
}

async function importPoolRepository(supabase: {
  from: ReturnType<typeof vi.fn>;
  rpc: ReturnType<typeof vi.fn>;
}) {
  vi.resetModules();
  vi.doUnmock("@/modules/stock/pool-repository");
  vi.doMock("@/server/integrations/supabase/server", () => ({
    createSupabaseServerClient: vi.fn(async () => supabase),
  }));
  return import("@/modules/stock/pool-repository");
}

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe("stock pool adjustment server action", () => {
  it.each([undefined, "", "   ", "1.5", "-1", "12x", "9007199254740992"])(
    "rejects raw quantity before Number conversion: %o",
    async (quantity) => {
      const { actions, adjustStockPool } = await importActions();
      const data = form({ poolId: "pool-1", mode: "receive", reason: "รับสินค้า" });
      if (quantity !== undefined) data.set("quantity", quantity);
      const result = await actions.adjustStockPoolAction(
        { ok: false, error: null },
        data,
      );

      expect(result).toEqual({ ok: false, error: "กรุณากรอกจำนวนเต็มตั้งแต่ 0 ขึ้นไป" });
      expect(adjustStockPool).not.toHaveBeenCalled();
    },
  );

  it("rejects zero receive but accepts set_balance zero only with a reason", async () => {
    const { actions, adjustStockPool } = await importActions();
    const receive = await actions.adjustStockPoolAction(
      { ok: false, error: null },
      form({ poolId: "pool-1", mode: "receive", quantity: "0", reason: "รับสินค้า" }),
    );
    expect(receive.ok).toBe(false);
    expect(adjustStockPool).not.toHaveBeenCalled();

    const balance = await actions.adjustStockPoolAction(
      { ok: false, error: null },
      form({ poolId: "pool-1", mode: "set_balance", quantity: "0", reason: "สินค้าสูญหาย" }),
    );
    expect(balance).toEqual({ ok: true, error: null });
    expect(adjustStockPool).toHaveBeenCalledWith({
      poolId: "pool-1",
      storeId: "store-current",
      mode: "set_balance",
      quantity: 0,
      reason: "สินค้าสูญหาย",
    });
  });

  it("sends a positive receive with the active store to the repository", async () => {
    const { actions, adjustStockPool } = await importActions();
    const result = await actions.adjustStockPoolAction(
      { ok: false, error: null },
      form({ poolId: "pool-1", mode: "receive", quantity: "7", reason: "รับสินค้าเข้า" }),
    );

    expect(result).toEqual({ ok: true, error: null });
    expect(adjustStockPool).toHaveBeenCalledWith({
      poolId: "pool-1",
      storeId: "store-current",
      mode: "receive",
      quantity: 7,
      reason: "รับสินค้าเข้า",
    });
  });

  it("accepts the PostgreSQL integer maximum but rejects the next integer before mutation", async () => {
    const { actions, adjustStockPool } = await importActions();
    const max = await actions.adjustStockPoolAction(
      { ok: false, error: null },
      form({ poolId: "pool-1", mode: "receive", quantity: "2147483647", reason: "รับสินค้าเข้า" }),
    );
    const tooLarge = await actions.adjustStockPoolAction(
      { ok: false, error: null },
      form({ poolId: "pool-1", mode: "receive", quantity: "2147483648", reason: "รับสินค้าเข้า" }),
    );

    expect(max).toEqual({ ok: true, error: null });
    expect(adjustStockPool).toHaveBeenCalledTimes(1);
    expect(adjustStockPool).toHaveBeenLastCalledWith(expect.objectContaining({ quantity: 2147483647 }));
    expect(tooLarge).toEqual({ ok: false, error: "กรุณากรอกจำนวนเต็มตั้งแต่ 0 ขึ้นไป" });
  });

  it("fails closed for an unknown mode and blank set_balance reason", async () => {
    const { actions, adjustStockPool } = await importActions();
    const unknown = await actions.adjustStockPoolAction(
      { ok: false, error: null },
      form({ poolId: "pool-1", mode: "sale", quantity: "1", reason: "x" }),
    );
    const blankReason = await actions.adjustStockPoolAction(
      { ok: false, error: null },
      form({ poolId: "pool-1", mode: "set_balance", quantity: "0", reason: "   " }),
    );

    expect(unknown.ok).toBe(false);
    expect(blankReason.ok).toBe(false);
    expect(adjustStockPool).not.toHaveBeenCalled();
  });

  it("enforces permission and package feature before repository mutation", async () => {
    const denied = new Error("denied");
    const { actions, adjustStockPool, requireFeature, requirePermission } = await importActions({ permissionError: denied });
    await expect(actions.adjustStockPoolAction(
      { ok: false, error: null },
      form({ poolId: "pool-1", mode: "receive", quantity: "1", reason: "รับสินค้า" }),
    )).resolves.toMatchObject({ ok: false });
    expect(requirePermission).toHaveBeenCalledWith("stock.manage");
    expect(requireFeature).not.toHaveBeenCalled();
    expect(adjustStockPool).not.toHaveBeenCalled();

    const gated = await importActions({ featureError: denied });
    await expect(gated.actions.adjustStockPoolAction(
      { ok: false, error: null },
      form({ poolId: "pool-1", mode: "receive", quantity: "1", reason: "รับสินค้า" }),
    )).resolves.toMatchObject({ ok: false });
    expect(gated.requirePermission).toHaveBeenCalledWith("stock.manage");
    expect(gated.requireFeature).toHaveBeenCalledWith("stockManagement");
    expect(gated.adjustStockPool).not.toHaveBeenCalled();
  });

  it("keeps the legacy variant action behind the package gate and rejects blank quantity", async () => {
    const { actions, requireFeature, setVariantStock } = await importActions();
    const result = await actions.setStockAction(
      { ok: false, error: null },
      form({ variantId: "variant-1", quantity: "   " }),
    );
    expect(result).toEqual({ ok: false, error: "กรุณากรอกจำนวนเต็มตั้งแต่ 0 ขึ้นไป" });
    expect(requireFeature).toHaveBeenCalledWith("stockManagement");
    expect(setVariantStock).not.toHaveBeenCalled();
  });

  it("keeps the legacy action within the PostgreSQL integer range", async () => {
    const { actions, setVariantStock } = await importActions();
    const result = await actions.setStockAction(
      { ok: false, error: null },
      form({ variantId: "variant-1", quantity: "2147483648" }),
    );

    expect(result).toEqual({ ok: false, error: "กรุณากรอกจำนวนเต็มตั้งแต่ 0 ขึ้นไป" });
    expect(setVariantStock).not.toHaveBeenCalled();
  });
});

describe("stock pool adjustment persistence boundary", () => {
  it("hides a technical precheck error from the action response", async () => {
    const query = {
      select: vi.fn(),
      eq: vi.fn(),
      maybeSingle: vi.fn(async () => ({
        data: null,
        error: { code: "08006", message: "connection to db.internal timed out" },
      })),
    };
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    const rpc = vi.fn();
    const repository = await importPoolRepository({ from: vi.fn(() => query), rpc });

    const result = await repository.adjustStockPool({
      poolId: "pool-1",
      storeId: "store-current",
      mode: "receive",
      quantity: 1,
      reason: "รับสินค้า",
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        message: "connection to db.internal timed out",
        userMessage: "ไม่สามารถตรวจสอบ Stock Pool ได้",
      },
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("returns a stable safe message when the store-scoped pool is absent", async () => {
    const query = {
      select: vi.fn(),
      eq: vi.fn(),
      maybeSingle: vi.fn(async () => ({ data: null, error: null })),
    };
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    const rpc = vi.fn();
    const repository = await importPoolRepository({ from: vi.fn(() => query), rpc });

    const result = await repository.adjustStockPool({
      poolId: "pool-1",
      storeId: "store-current",
      mode: "receive",
      quantity: 1,
      reason: "รับสินค้า",
    });

    expect(result).toMatchObject({
      ok: false,
      error: { userMessage: "ไม่พบ Stock Pool หรือไม่มีสิทธิ์เข้าถึง" },
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("fails safely when the adjustment RPC returns no pool row", async () => {
    const query = {
      select: vi.fn(),
      eq: vi.fn(),
      maybeSingle: vi.fn(async () => ({ data: { id: "pool-1" }, error: null })),
    };
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    const rpc = vi.fn(async () => ({ data: null, error: null }));
    const repository = await importPoolRepository({ from: vi.fn(() => query), rpc });

    const result = await repository.adjustStockPool({
      poolId: "pool-1",
      storeId: "store-current",
      mode: "receive",
      quantity: 1,
      reason: "รับสินค้า",
    });

    expect(result).toMatchObject({
      ok: false,
      error: { userMessage: "ไม่สามารถปรับสต็อกได้" },
    });
  });

  it("uses a store-scoped precheck before the typed adjustment RPC", () => {
    expect(existsSync(join(root, repositoryPath))).toBe(true);
    const source = read(repositoryPath);
    expect(source).toContain('from("stock_pools")');
    expect(source).toContain('.eq("store_id", input.storeId)');
    expect(source).toContain('rpc("adjust_stock_pool"');
    expect(source).toContain("p_pool_id: input.poolId");
    expect(source).toContain("p_mode: input.mode");
    expect(source).toContain("p_quantity: input.quantity");
    expect(source).toContain("p_reason: input.reason");
  });
});

describe("stock pool existing-link persistence boundary", () => {
  it("uses one typed RPC with the active store and no direct table mutation", async () => {
    const row = {
      variant_id: "variant-1",
      stock_pool_id: "pool-1",
      consumption_quantity: 3,
      created_at: "2026-08-04T00:00:00.000Z",
    };
    const from = vi.fn(() => { throw new Error("direct table access is forbidden"); });
    const rpc = vi.fn(async () => ({ data: row, error: null }));
    const repository = await importPoolRepository({ from, rpc });

    await expect(repository.linkVariantToStockPool({
      variantId: "variant-1",
      poolId: "pool-1",
      storeId: "store-current",
      consumptionQuantity: 3,
    })).resolves.toEqual({ ok: true, error: null });
    expect(from).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith("link_variant_to_stock_pool", {
      p_variant_id: "variant-1",
      p_pool_id: "pool-1",
      p_store_id: "store-current",
      p_consumption_quantity: 3,
    });
  });

  it.each([
    { data: null, error: null },
    { data: null, error: { code: "23505", message: "duplicate key at db.internal" } },
    { data: { variant_id: null, stock_pool_id: "pool-1", consumption_quantity: 1 }, error: null },
  ])("fails safely for an RPC error, null row, or invalid row: %o", async (rpcResult) => {
    const from = vi.fn(() => { throw new Error("direct table access is forbidden"); });
    const rpc = vi.fn(async () => rpcResult);
    const repository = await importPoolRepository({ from, rpc });

    const result = await repository.linkVariantToStockPool({
      variantId: "variant-1",
      poolId: "pool-1",
      storeId: "store-current",
      consumptionQuantity: 1,
    });

    expect(result).toMatchObject({
      ok: false,
      error: { userMessage: "ไม่สามารถเชื่อม Stock Pool ได้" },
    });
    expect(JSON.stringify(result)).not.toContain("db.internal");
    expect(from).not.toHaveBeenCalled();
  });
});

describe("stock pool database authorization and feature gate", () => {
  it("enforces effective stock permission and current plan entitlement in the RPC and write policies", () => {
    const sql = read(migrationPath).toLowerCase().replace(/\s+/g, " ");

    expect(sql).toContain("create or replace function public.organization_has_stock_management");
    expect(sql).toMatch(/organization_has_stock_management\([\s\S]*?security definer[\s\S]*?set search_path = public, pg_temp/);
    expect(sql).toContain("status in ('active', 'trialing', 'past_due')");
    expect(sql).toContain("plan in ('standard', 'premium')");
    expect(sql).toContain("plan = 'enterprise'");
    expect(sql).toContain("plan = 'business'");
    expect(sql).toContain("current_period_end > now()");
    expect(sql).toContain("business_features @> '[\"stockmanagement\"]'::jsonb");
    expect(sql).toContain("business_seats between 1 and 500");
    expect(sql).toContain("business_stores between 1 and 50");
    expect(sql).toMatch(/revoke all on function public\.organization_has_stock_management.* from public/);
    expect(sql).toMatch(/grant execute on function public\.organization_has_stock_management.* to authenticated/);

    expect(sql).toContain("auth_user_has_permission(v_pool.organization_id, v_pool.store_id, 'stock.manage')");
    expect(sql).toContain("organization_has_stock_management(v_pool.organization_id)");
    for (const policy of ["stock_pools_manage", "variant_stock_links_manage", "stock_movements_insert"]) {
      expect(sql).toContain(`drop policy if exists "${policy}"`);
    }
    expect(sql).toContain("auth_user_has_permission(organization_id, store_id, 'stock.manage')");
    expect(sql).toContain("organization_has_stock_management(organization_id)");
    expect(sql).toContain("auth_user_has_permission(sp.organization_id, sp.store_id, 'stock.manage')");
    expect(sql).toContain("organization_has_stock_management(sp.organization_id)");
  });
});

describe("package version lockstep", () => {
  it("keeps both package-lock version fields at the release version", () => {
    const packageJson = JSON.parse(read("package.json")) as { version: string };
    const lock = JSON.parse(read("package-lock.json")) as {
      version: string;
      packages: { "": { version: string } };
    };

    expect(lock.version).toBe(packageJson.version);
    expect(lock.packages[""].version).toBe(packageJson.version);
  });
});

describe("stock pool adjustment migration", () => {
  it("locks, authorizes, validates, and writes pool + ledger atomically", () => {
    expect(existsSync(join(root, migrationPath))).toBe(true);
    const sql = read(migrationPath).toLowerCase().replace(/\s+/g, " ");

    expect(sql).toContain("create or replace function public.adjust_stock_pool");
    expect(sql).toContain("security definer");
    expect(sql).toMatch(/set search_path(?:\s*=| to) public, pg_temp/);
    expect(sql).toContain("for update");
    expect(sql).toContain("auth_user_has_permission");
    expect(sql).toContain("auth.uid()");
    expect(sql).toContain("p_mode not in ('receive', 'set_balance')");
    expect(sql).toContain("p_quantity is null or p_quantity < 0");
    expect(sql).toContain("p_mode = 'receive' and p_quantity <= 0");
    expect(sql).toContain("p_mode = 'set_balance' and nullif(btrim(coalesce(p_reason, '')), '') is null");
    expect(sql).toMatch(/2147483647|integer range|bigint/);
    expect(sql).toContain("update public.stock_pools set quantity = v_after");
    expect(sql).toContain("insert into public.stock_movements");
    expect(sql).toContain("v_after - v_before");
  });

  it("removes authenticated bypasses while retaining only constrained RPC execution", () => {
    const sql = read(migrationPath).toLowerCase().replace(/\s+/g, " ");

    expect(sql).toMatch(/revoke .*update.*quantity.*on (table )?public\.stock_pools from authenticated/);
    expect(sql).toMatch(/revoke .*insert.*quantity.*on (table )?public\.stock_pools from authenticated/);
    expect(sql).toMatch(/revoke (insert|update|delete|all).*on (table )?public\.stock_movements from authenticated/);
    expect(sql).toContain("revoke all on function public.adjust_stock_pool");
    expect(sql).toMatch(/grant execute on function public\.adjust_stock_pool.* to authenticated/);
    expect(sql).toMatch(/grant execute on function public\.adjust_stock_pool.* to service_role/);
    expect(sql).toMatch(/revoke execute on function public\.adjust_stock_pool.* from anon/);
    expect(read("supabase/migrations/20260905000001_stock_pools.sql"))
      .toContain("check (after_quantity = before_quantity + quantity_delta)");
  });
});
