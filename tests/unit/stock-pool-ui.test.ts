import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { afterEach, vi } from "vitest";

const root = process.cwd();

async function importWorkflowActions(options: {
  catalogPermission?: boolean;
  productStoreId?: string;
  variantError?: string;
  createPoolError?: string;
  linkPoolError?: string;
  permissionDenied?: boolean;
  featureDenied?: boolean;
} = {}) {
  vi.resetModules();
  class AuthorizationError extends Error {}
  const requirePermission = vi.fn(async () => {
    if (options.permissionDenied) throw new AuthorizationError("denied");
  });
  const requireFeature = vi.fn(async () => {
    if (options.featureDenied) throw new Error("feature denied");
  });
  const createVariant = vi.fn(async () => options.variantError
    ? { data: null, error: { userMessage: options.variantError } }
    : { data: { id: "variant-new", productId: "product-current", name: "1 ขวด", priceAdjustment: 0, trackStock: true, isActive: true, sortOrder: 0 }, error: null });
  const getProduct = vi.fn(async () => ({ data: { storeId: options.productStoreId ?? "store-current" }, error: null }));
  const createStockPoolAndLinkVariant = vi.fn(async () => options.createPoolError
    ? { ok: false, error: { userMessage: options.createPoolError } }
    : { ok: true, data: { id: "pool-new", storeId: "store-current", organizationId: "org-current", name: "เบียร์", unitLabel: "ขวด", quantity: 0, lowStockThreshold: 0, isActive: true }, error: null });
  const linkVariantToStockPool = vi.fn(async () => options.linkPoolError
    ? { ok: false, error: { userMessage: options.linkPoolError } }
    : { ok: true, error: null });
  vi.doMock("next/cache", () => ({ revalidatePath: vi.fn() }));
  vi.doMock("@/modules/auth/guards", () => ({ AuthorizationError, requirePermission, requireFeature, getResolvedCurrentPermissions: vi.fn(async () => ({ ctx: { storeId: "store-current", organizationId: "org-current" }, resolved: { can: (permission: string) => permission !== "catalog.manage" || options.catalogPermission !== false } })) }));
  vi.doMock("@/modules/catalog/repository", () => ({ createVariant, getProduct }));
  vi.doMock("@/modules/stock/pool-repository", () => ({ createStockPoolAndLinkVariant, linkVariantToStockPool, adjustStockPool: vi.fn() }));
  const actions = await import("@/app/(dashboard)/stock/actions");
  return { actions, createVariant, getProduct, createStockPoolAndLinkVariant, linkVariantToStockPool, requireFeature, requirePermission };
}

afterEach(() => { vi.resetModules(); vi.clearAllMocks(); });

describe("stock pool inline workflow", () => {
  it("moves through the fail-closed dialog states and skips pool choice for a linked variant", async () => {
    const { nextStockStep } = await import("@/app/(dashboard)/stock/AddStockDialog");
    const product = { id: "product-1", variants: [{ id: "variant-1" }] };

    expect(nextStockStep({ id: "empty", variants: [] })).toBe("ensure_variant");
    expect(nextStockStep(product)).toBe("ensure_variant");
    expect(nextStockStep(product, "variant-1")).toBe("choose_pool");
    expect(nextStockStep(product, "variant-1", "pool-1")).toBe("adjust");
  });

  it("validates shared-pool consumption and explains both adjustment previews", async () => {
    const { adjustmentPreview, validateConsumptionQuantity } = await import("@/app/(dashboard)/stock/AddStockDialog");

    expect(validateConsumptionQuantity("3")).toEqual({ ok: true, value: 3 });
    expect(validateConsumptionQuantity("0")).toMatchObject({ ok: false });
    expect(validateConsumptionQuantity("1.5")).toMatchObject({ ok: false });
    expect(adjustmentPreview(30, "receive", 12)).toContain("30 + 12 = 42");
    expect(adjustmentPreview(30, "set_balance", 27)).toContain("30 → 27");
  });

  it("keeps the approved Thai explanations and accessible dialog contracts in the page components", () => {
    const source = readFileSync(join(root, "src/app/(dashboard)/stock/AddStockDialog.tsx"), "utf8");
    const cards = readFileSync(join(root, "src/app/(dashboard)/stock/StockPoolCard.tsx"), "utf8");
    const adjustment = readFileSync(join(root, "src/app/(dashboard)/stock/StockPoolAdjustmentForm.tsx"), "utf8");
    const manager = readFileSync(join(root, "src/app/(dashboard)/stock/StockManager.tsx"), "utf8");
    const modal = readFileSync(join(root, "src/shared/components/ui/ModalDialog.tsx"), "utf8");

    for (const phrase of [
      "Variant = รูปแบบย่อย/หน่วยขายของสินค้า",
      "ยอดสต๊อกกลางที่หลาย Variant",
      "ขาย Variant นี้ 1 รายการ ตัดกี่หน่วยจาก Stock Pool",
      "ต้องมีสิทธิ์จัดการเมนูสินค้าและสต๊อก",
      "role=\"alert\"",
      "min-h-11",
      "grid-cols-1",
    ]) expect(source).toContain(phrase);

    expect(adjustment).toContain("รับเข้า");
    expect(adjustment).toContain("กำหนดยอดใหม่");

    expect(cards).toContain("เชื่อมกับ:");
    expect(manager).toContain("เพิ่มสต๊อกสินค้า");
    expect(manager).toContain("AddStockDialog");
    expect(manager).not.toContain("href=\"/catalog");
    expect(manager).toContain("stockDataError");
    expect(modal).toContain("min-h-11 min-w-11");
  });

  it("fails closed for catalog permission, cross-store Variant creation, and invalid shared-pool consumption", async () => {
    const denied = await importWorkflowActions({ catalogPermission: false });
    const variantForm = new FormData(); variantForm.set("productId", "product-current"); variantForm.set("variantName", "1 ขวด"); variantForm.set("priceAdjustment", "0");
    await expect(denied.actions.createVariantFromStockAction(variantForm)).resolves.toEqual({ ok: false, error: "ต้องมีสิทธิ์จัดการเมนูสินค้าและสต๊อก" });
    expect(denied.createVariant).not.toHaveBeenCalled();

    const crossStore = await importWorkflowActions({ productStoreId: "other-store" });
    await expect(crossStore.actions.createVariantFromStockAction(variantForm)).resolves.toEqual({ ok: false, error: "ไม่มีสิทธิ์" });
    expect(crossStore.createVariant).not.toHaveBeenCalled();

    const link = await importWorkflowActions();
    const linkForm = new FormData(); linkForm.set("variantId", "variant-1"); linkForm.set("poolId", "pool-1"); linkForm.set("consumptionQuantity", "0");
    await expect(link.actions.linkVariantToStockPoolAction(linkForm)).resolves.toEqual({ ok: false, error: "จำนวนที่ตัดต้องเป็นจำนวนเต็มมากกว่า 0" });
    expect(link.linkVariantToStockPool).not.toHaveBeenCalled();
  });

  it("requires a single atomic RPC for creating and linking a new Stock Pool", () => {
    const repository = readFileSync(join(root, "src/modules/stock/pool-repository.ts"), "utf8");
    const adjustmentMigration = readFileSync(join(root, "supabase/migrations/20260905000002_stock_pool_adjustment_rpc.sql"), "utf8");
    const createLinkPath = join(root, "supabase/migrations/20260905000003_stock_pool_create_link_rpc.sql");
    const dialog = readFileSync(join(root, "src/app/(dashboard)/stock/AddStockDialog.tsx"), "utf8");

    expect(adjustmentMigration).not.toContain("create_stock_pool_and_link_variant");
    expect(existsSync(createLinkPath)).toBe(true);
    const createLinkMigration = readFileSync(createLinkPath, "utf8");
    expect(createLinkMigration).toContain("create_stock_pool_and_link_variant");
    expect(createLinkMigration).toContain("for update");
    expect(createLinkMigration).toContain("revoke all on function public.create_stock_pool_and_link_variant");
    expect(repository).toContain('rpc("create_stock_pool_and_link_variant"');
    expect(dialog).toContain("createStockPoolAndLinkVariantAction");
    expect(dialog).not.toContain("createStockPoolAction(form)");
  });

  it("links an existing Pool only through an atomic active-store RPC", () => {
    const repository = readFileSync(join(root, "src/modules/stock/pool-repository.ts"), "utf8");
    const migration = readFileSync(join(root, "supabase/migrations/20260905000003_stock_pool_create_link_rpc.sql"), "utf8").toLowerCase().replace(/\s+/g, " ");
    const databaseTypes = readFileSync(join(root, "src/server/integrations/supabase/database.types.ts"), "utf8");
    const linkFunction = repository.slice(repository.indexOf("export async function linkVariantToStockPool"), repository.indexOf("export async function adjustStockPool"));
    const linkRpc = migration.slice(migration.indexOf("create or replace function public.link_variant_to_stock_pool"));

    expect(linkRpc).toContain("create or replace function public.link_variant_to_stock_pool");
    expect(linkRpc).toContain("returns public.variant_stock_links");
    expect(linkRpc).toContain("security definer");
    expect(linkRpc).toContain("set search_path = public, pg_temp");
    expect(linkRpc).toContain("pv.is_active = true");
    expect(linkRpc).toContain("p.is_active = true");
    expect(linkRpc).toContain("sp.is_active = true");
    expect(linkRpc).toContain("auth_user_has_permission(v_product.organization_id, v_product.store_id, 'stock.manage')");
    expect(linkRpc).toContain("organization_has_stock_management(v_product.organization_id)");
    expect(linkRpc.match(/for update/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(linkRpc).toContain("p_store_id");
    expect(linkRpc).toContain("p_consumption_quantity is null or p_consumption_quantity <= 0");
    expect(linkRpc).toContain("variant นี้เชื่อมกับ stock pool แล้ว");
    expect(linkRpc).toMatch(/revoke insert, update, delete on (table )?public\.variant_stock_links from authenticated/);
    expect(linkRpc).toContain("revoke all on function public.link_variant_to_stock_pool");
    expect(linkRpc).toContain("revoke execute on function public.link_variant_to_stock_pool");
    expect(linkRpc).toContain("grant execute on function public.link_variant_to_stock_pool");
    expect(databaseTypes).toContain("link_variant_to_stock_pool:");
    expect(linkFunction).toContain('rpc("link_variant_to_stock_pool"');
    expect(linkFunction).toContain("p_store_id: input.storeId");
    expect(linkFunction).not.toContain('.from("variant_stock_links")');
    expect(linkFunction).not.toContain(".insert(");
  });

  it("passes the new pool and consumption data through one atomic action", async () => {
    const { actions, createStockPoolAndLinkVariant } = await importWorkflowActions();
    const form = new FormData();
    form.set("variantId", "variant-1"); form.set("name", "เบียร์สิงห์"); form.set("unitLabel", "ขวด"); form.set("lowStockThreshold", "3"); form.set("consumptionQuantity", "3");

    await expect(actions.createStockPoolAndLinkVariantAction(form)).resolves.toMatchObject({ ok: true, pool: { id: "pool-new" } });
    expect(createStockPoolAndLinkVariant).toHaveBeenCalledWith({ variantId: "variant-1", storeId: "store-current", name: "เบียร์สิงห์", unitLabel: "ขวด", lowStockThreshold: 3, consumptionQuantity: 3 });
  });

  it("keeps existing-Pool links behind permission, feature, and active-store gates", async () => {
    const data = new FormData();
    data.set("variantId", "variant-1"); data.set("poolId", "pool-1"); data.set("consumptionQuantity", "3");

    const allowed = await importWorkflowActions();
    await expect(allowed.actions.linkVariantToStockPoolAction(data)).resolves.toEqual({ ok: true, error: null });
    expect(allowed.requirePermission).toHaveBeenCalledWith("stock.manage");
    expect(allowed.requireFeature).toHaveBeenCalledWith("stockManagement");
    expect(allowed.linkVariantToStockPool).toHaveBeenCalledWith({
      variantId: "variant-1", poolId: "pool-1", storeId: "store-current", consumptionQuantity: 3,
    });

    const denied = await importWorkflowActions({ permissionDenied: true });
    await expect(denied.actions.linkVariantToStockPoolAction(data)).resolves.toMatchObject({ ok: false });
    expect(denied.linkVariantToStockPool).not.toHaveBeenCalled();

    const gated = await importWorkflowActions({ featureDenied: true });
    await expect(gated.actions.linkVariantToStockPoolAction(data)).resolves.toMatchObject({ ok: false });
    expect(gated.linkVariantToStockPool).not.toHaveBeenCalled();
  });

  it("blocks the workflow for any stock loader failure and documents the one-pool Variant rule", () => {
    const page = readFileSync(join(root, "src/app/(dashboard)/stock/page.tsx"), "utf8");
    const manager = readFileSync(join(root, "src/app/(dashboard)/stock/StockManager.tsx"), "utf8");
    const dialog = readFileSync(join(root, "src/app/(dashboard)/stock/AddStockDialog.tsx"), "utf8");

    expect(page).toContain("productsRes.error || poolsRes.error || linksRes.error");
    expect(page).toContain("stockDataError");
    expect(manager).toContain("stockDataError");
    expect(manager).toContain("disabled={!canManageStock || stockDataError}");
    expect(manager).toContain("role=\"alert\"");
    expect(dialog).toContain("หลาย Variant จากคนละสินค้าสามารถใช้ Stock Pool เดียวกันได้ แต่ Variant หนึ่งเชื่อมได้กับ Stock Pool เพียงหนึ่งรายการเท่านั้น");
  });

  it("gives the stock dialog an accessible Thai description without changing optional legacy dialogs", () => {
    const modal = readFileSync(join(root, "src/shared/components/ui/ModalDialog.tsx"), "utf8");
    const dialog = readFileSync(join(root, "src/app/(dashboard)/stock/AddStockDialog.tsx"), "utf8");

    expect(modal).toContain("description?: string");
    expect(modal).toContain("aria-describedby={description ? descriptionId : undefined}");
    expect(modal).toContain("id={descriptionId}");
    expect(dialog).toContain("description=\"เลือกสินค้า Variant และ Stock Pool เพื่อเพิ่มหรือกำหนดยอดสต๊อก โดยไม่ออกจากหน้านี้\"");
  });

  it("keeps Stock Pool as the stock source for linked variants and the legacy editor only for unlinked ones", () => {
    const manager = readFileSync(join(root, "src/app/(dashboard)/stock/StockManager.tsx"), "utf8");
    const card = readFileSync(join(root, "src/app/(dashboard)/stock/StockPoolCard.tsx"), "utf8");

    // variant ที่ผูก Pool แล้วต้องแก้ยอดผ่าน Pool เท่านั้น — แต่ variant ที่ยังไม่ผูก
    // ต้องมีที่ให้แก้สต๊อกเดิม ไม่งั้นข้อมูลเก่าที่ track_stock อยู่จะปรับไม่ได้เลย
    expect(manager).toContain("linkedVariantIds");
    expect(manager).toContain("!linkedVariantIds.has(variant.id)");
    expect(manager).toContain("setStockAction");
    expect(card).toContain("pool.quantity");
  });

  it("maps unknown repository errors to stable Thai action messages", async () => {
    const internal = "duplicate key violates variant_stock_links_pkey at db.internal";
    const variant = await importWorkflowActions({ variantError: internal });
    const variantForm = new FormData(); variantForm.set("productId", "product-current"); variantForm.set("variantName", "1 ขวด"); variantForm.set("priceAdjustment", "0");
    const variantResult = await variant.actions.createVariantFromStockAction(variantForm);
    expect(variantResult).toEqual({ ok: false, error: "ไม่สามารถสร้าง Variant ได้" });
    expect(JSON.stringify(variantResult)).not.toContain(internal);

    const pool = await importWorkflowActions({ createPoolError: internal });
    const poolForm = new FormData(); poolForm.set("variantId", "variant-1"); poolForm.set("name", "เบียร์"); poolForm.set("unitLabel", "ขวด"); poolForm.set("lowStockThreshold", "0"); poolForm.set("consumptionQuantity", "1");
    const poolResult = await pool.actions.createStockPoolAndLinkVariantAction(poolForm);
    expect(poolResult).toEqual({ ok: false, error: "ไม่สามารถสร้าง Stock Pool ได้" });
    expect(JSON.stringify(poolResult)).not.toContain(internal);

    const link = await importWorkflowActions({ linkPoolError: internal });
    const linkForm = new FormData(); linkForm.set("variantId", "variant-1"); linkForm.set("poolId", "pool-1"); linkForm.set("consumptionQuantity", "1");
    const linkResult = await link.actions.linkVariantToStockPoolAction(linkForm);
    expect(linkResult).toEqual({ ok: false, error: "ไม่สามารถเชื่อม Stock Pool ได้" });
    expect(JSON.stringify(linkResult)).not.toContain(internal);
  });

  it("returns fresh default drafts for every dialog reset", async () => {
    const { createInitialAddStockDraft } = await import("@/app/(dashboard)/stock/AddStockDialog");
    const { createInitialAdjustmentDraft } = await import("@/app/(dashboard)/stock/StockPoolAdjustmentForm");

    const first = createInitialAddStockDraft();
    first.newPool.name = "changed";
    expect(createInitialAddStockDraft()).toEqual({
      step: "choose_product", query: "", product: null, variant: null, pool: null,
      consumptionQuantity: "1", newPool: { name: "", unitLabel: "ชิ้น", lowStockThreshold: "0" }, error: null,
    });
    expect(createInitialAdjustmentDraft()).toEqual({ mode: "receive", quantity: "", reason: "" });
  });

  it("fails closed when a Variant link references a Pool outside the loaded store snapshot", async () => {
    const { resolveVariantStockPool } = await import("@/app/(dashboard)/stock/AddStockDialog");
    const pools = [{ id: "pool-current" }];

    expect(resolveVariantStockPool("variant-free", [], pools)).toEqual({ ok: true, pool: null });
    expect(resolveVariantStockPool("variant-linked", [{ variantId: "variant-linked", stockPoolId: "pool-current" }], pools)).toEqual({ ok: true, pool: pools[0] });
    expect(resolveVariantStockPool("variant-stale", [{ variantId: "variant-stale", stockPoolId: "pool-other" }], pools)).toEqual({ ok: false, error: "โหลด Stock Pool ที่เชื่อมกับ Variant ไม่สำเร็จ" });
  });

  it("loads links by current-store Variant IDs so inactive or missing Pools fail closed", () => {
    const repository = readFileSync(join(root, "src/modules/stock/pool-repository.ts"), "utf8");
    const page = readFileSync(join(root, "src/app/(dashboard)/stock/page.tsx"), "utf8");
    const dialog = readFileSync(join(root, "src/app/(dashboard)/stock/AddStockDialog.tsx"), "utf8");
    const modal = readFileSync(join(root, "src/shared/components/ui/ModalDialog.tsx"), "utf8");
    const linkFunction = repository.slice(repository.indexOf("export async function listStockPoolLinks"), repository.indexOf("export async function createStockPoolAndLinkVariant"));

    expect(linkFunction).toContain("variantIds");
    expect(linkFunction).toContain('.in("variant_id", scopedVariantIds)');
    expect(linkFunction).not.toContain("listStockPools(");
    expect(page).toContain("(productsRes.data ?? []).flatMap");
    expect(page).toContain("listStockPoolLinks(ctx.storeId, variantIds)");
    expect(page).not.toContain("listStockPoolLinks(ctx.storeId, poolIds)");
    expect(dialog).toContain("stepFocusRef");
    expect(dialog).toContain("tabIndex={-1}");
    expect(modal).toContain("!dialogRef.current?.contains(document.activeElement)");
  });
});
