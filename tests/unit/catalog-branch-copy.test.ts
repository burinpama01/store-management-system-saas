import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8");

function fd(values: Record<string, string | string[]>) {
  const formData = new FormData();
  for (const [key, value] of Object.entries(values)) {
    if (Array.isArray(value)) {
      for (const item of value) formData.append(key, item);
    } else {
      formData.set(key, value);
    }
  }
  return formData;
}

const repositoryMockShape = (copyProductsAcrossBranches: ReturnType<typeof vi.fn>) => ({
  createCategory: vi.fn(),
  updateCategory: vi.fn(),
  deleteCategory: vi.fn(),
  createProduct: vi.fn(),
  updateProduct: vi.fn(),
  deleteProduct: vi.fn(),
  createVariantTemplate: vi.fn(),
  deleteVariantTemplate: vi.fn(),
  getVariantTemplate: vi.fn(),
  createVariant: vi.fn(),
  deleteVariant: vi.fn(),
  listModifierGroupTemplates: vi.fn(),
  createModifierGroupTemplate: vi.fn(),
  deleteModifierGroupTemplate: vi.fn(),
  getModifierGroupTemplate: vi.fn(),
  createModifierGroup: vi.fn(),
  deleteModifierGroup: vi.fn(),
  createModifierOptionTemplate: vi.fn(),
  deleteModifierOptionTemplate: vi.fn(),
  createModifierOption: vi.fn(),
  deleteModifierOption: vi.fn(),
  getProduct: vi.fn(),
  getModifierGroupStoreId: vi.fn(),
  copyProductsAcrossBranches,
});

type FakeRow = Record<string, unknown>;

class FakeSupabaseQuery {
  private action: "select" | "insert" | "update" | "delete" = "select";
  private filters: Array<{ type: "eq" | "in"; column: string; value: unknown }> = [];
  private payload: FakeRow | FakeRow[] | null = null;
  private wantsSingle = false;

  constructor(
    private readonly client: FakeSupabaseClient,
    private readonly table: string,
  ) {}

  select() {
    return this;
  }

  eq(column: string, value: unknown) {
    this.filters.push({ type: "eq", column, value });
    return this;
  }

  in(column: string, value: unknown[]) {
    this.filters.push({ type: "in", column, value });
    return this;
  }

  insert(payload: FakeRow | FakeRow[]) {
    this.action = "insert";
    this.payload = payload;
    return this;
  }

  update(payload: FakeRow) {
    this.action = "update";
    this.payload = payload;
    return this;
  }

  delete() {
    this.action = "delete";
    return this;
  }

  single() {
    this.wantsSingle = true;
    return this;
  }

  then<TResult1 = { data: unknown; error: null }, TResult2 = never>(
    onfulfilled?: ((value: { data: unknown; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ) {
    return Promise.resolve(this.execute()).then(onfulfilled, onrejected);
  }

  private execute() {
    if (this.action === "insert") {
      const payloads = Array.isArray(this.payload) ? this.payload : [this.payload ?? {}];
      const createdRows = payloads.map((payload) => this.client.insert(this.table, payload));
      return { data: this.wantsSingle ? createdRows[0] : createdRows, error: null };
    }

    if (this.action === "update" || this.action === "delete") {
      return { data: null, error: null };
    }

    const rows = this.client.select(this.table, this.filters);
    return { data: this.wantsSingle ? (rows[0] ?? null) : rows, error: null };
  }
}

class FakeSupabaseClient {
  readonly inserted: Record<string, FakeRow[]> = {};

  constructor(private readonly rows: Record<string, FakeRow[]>) {}

  from(table: string) {
    return new FakeSupabaseQuery(this, table);
  }

  insert(table: string, payload: FakeRow) {
    const id = `${table}-created-${(this.inserted[table]?.length ?? 0) + 1}`;
    const row = {
      id,
      created_at: "2026-06-22T00:00:00.000Z",
      updated_at: "2026-06-22T00:00:00.000Z",
      ...payload,
    };
    this.rows[table] = [...(this.rows[table] ?? []), row];
    this.inserted[table] = [...(this.inserted[table] ?? []), payload];
    return row;
  }

  select(table: string, filters: Array<{ type: "eq" | "in"; column: string; value: unknown }>) {
    return (this.rows[table] ?? []).filter((row) =>
      filters.every((filter) => {
        if (filter.type === "eq") return row[filter.column] === filter.value;
        return Array.isArray(filter.value) && filter.value.includes(row[filter.column]);
      }),
    );
  }
}

async function importRepositoryWithSupabase(supabase: FakeSupabaseClient) {
  vi.resetModules();
  vi.doMock("@/server/integrations/supabase/server", () => ({
    createSupabaseServerClient: vi.fn(async () => supabase),
  }));

  return import("@/modules/catalog/repository");
}

async function importActions(options: { multiBranchEnabled?: boolean } = {}) {
  vi.resetModules();
  const multiBranchEnabled = options.multiBranchEnabled ?? true;
  const copyProductsAcrossBranches = vi.fn(async () => ({
    data: { created: 2, updated: 0, skipped: 1 },
    error: null,
  }));
  const requirePermission = vi.fn(async () => undefined);
  const revalidatePath = vi.fn();

  vi.doMock("next/cache", () => ({ revalidatePath }));
  vi.doMock("@/modules/auth/guards", () => ({ requirePermission }));
  vi.doMock("@/modules/auth/session", () => ({
    getCurrentUser: vi.fn(async () => ({ id: "manager-1", email: "owner@example.com" })),
    getUserStores: vi.fn(async () => ({
      data: [
        { id: "source-store", organizationId: "org-1", name: "สาขาต้นทาง" },
        { id: "target-a", organizationId: "org-1", name: "สาขาปลายทาง A" },
        { id: "target-b", organizationId: "org-1", name: "สาขาปลายทาง B" },
      ],
      error: null,
    })),
    resolveCurrentStore: vi.fn(() => ({
      storeId: "source-store",
      organizationId: "org-1",
      name: "สาขาต้นทาง",
    })),
  }));
  vi.doMock("@/modules/billing/billing-service", () => ({
    getOrganizationBillingState: vi.fn(async () => ({
      plan: "enterprise",
      status: "active",
      currentPeriodEnd: "2099-12-31T23:59:59Z",
      cancelAtPeriodEnd: false,
      trialEnd: null,
    })),
  }));
  vi.doMock("@/modules/billing/types", async () => {
    const actual = await vi.importActual<typeof import("@/modules/billing/types")>(
      "@/modules/billing/types",
    );
    return {
      ...actual,
      getPlanFeatures: vi.fn(() => ({
        ...actual.getPlanFeatures(actual.DEFAULT_BILLING_STATE),
        multiBranchReporting: multiBranchEnabled,
      })),
    };
  });
  vi.doMock("@/modules/catalog/repository", () => repositoryMockShape(copyProductsAcrossBranches));

  const actions = await import("@/app/(dashboard)/catalog/actions");
  return { actions, copyProductsAcrossBranches, requirePermission, revalidatePath };
}

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe("catalog cross-branch menu copy", () => {
  it("adds a menu_link_id schema marker without creating a new exposed table", () => {
    const migrations = fs
      .readdirSync(path.join(process.cwd(), "supabase/migrations"))
      .filter((file) => file.endsWith(".sql"))
      .map((file) => read(path.join("supabase/migrations", file)))
      .join("\n");
    const databaseTypes = read("src/server/integrations/supabase/database.types.ts");
    const catalogTypes = read("src/modules/catalog/types.ts");

    expect(migrations).toContain("alter table public.products add column if not exists menu_link_id uuid");
    expect(migrations).toContain("update public.products set menu_link_id = id where menu_link_id is null");
    expect(migrations).toContain("create unique index if not exists products_store_menu_link_unique_idx");
    expect(migrations).toContain("where menu_link_id is not null");
    expect(migrations).not.toContain("products_menu_link_id_fkey");
    expect(migrations).not.toContain("references public.products(id)");
    expect(migrations).not.toContain("create table public.product_links");
    expect(databaseTypes).toContain("menu_link_id: string | null");
    expect(catalogTypes).toContain("menuLinkId?: string");
  });

  it("keeps copy logic in the catalog repository and clones product children", () => {
    const repository = read("src/modules/catalog/repository.ts");

    expect(repository).toContain("export async function copyProductsAcrossBranches");
    expect(repository).toContain("targetStoreIds");
    expect(repository).toContain("priceMode");
    expect(repository).toContain("duplicateMode");
    expect(repository).toContain("menu_link_id");
    expect(repository).toContain(".from(\"product_variants\")");
    expect(repository).toContain(".from(\"modifier_groups\")");
    expect(repository).toContain(".from(\"modifier_options\")");
    expect(repository).toContain("copyCatalogTemplateLibrary");
    expect(repository).toContain(".from(\"catalog_variant_templates\")");
    expect(repository).toContain(".from(\"catalog_modifier_group_templates\")");
    expect(repository).toContain(".from(\"catalog_modifier_option_templates\")");
    expect(repository).toContain(".eq(\"organization_id\", input.organizationId)");
    expect(repository).toContain(".eq(\"store_id\", input.sourceStoreId)");
    expect(repository).toContain("rollbackSteps");
    expect(repository).toContain("restoreExistingProductSnapshot");
    expect(repository).toContain("deleteCopiedProduct");
    expect(repository).toContain("runRollbackSteps");
  });

  it("copies template rows with the same normalized name when the price differs", async () => {
    const supabase = new FakeSupabaseClient({
      stores: [
        { id: "source-store", organization_id: "org-1", is_active: true },
        { id: "target-a", organization_id: "org-1", is_active: true },
      ],
      categories: [
        {
          id: "source-category",
          organization_id: "org-1",
          store_id: "source-store",
          name: "Coffee",
          description: null,
          sort_order: 1,
          is_active: true,
        },
      ],
      products: [
        {
          id: "product-1",
          organization_id: "org-1",
          store_id: "source-store",
          category_id: "source-category",
          menu_link_id: null,
          name: "Latte",
          description: null,
          barcode: null,
          image_url: null,
          base_price: 35,
          is_active: true,
          available_for_pos: true,
          available_for_qr: true,
          sort_order: 1,
          created_at: "2026-06-22T00:00:00.000Z",
          updated_at: "2026-06-22T00:00:00.000Z",
        },
        {
          id: "target-product-1",
          organization_id: "org-1",
          store_id: "target-a",
          category_id: "target-category",
          menu_link_id: "product-1",
          name: "Latte",
          description: null,
          barcode: null,
          image_url: null,
          base_price: 35,
          is_active: true,
          available_for_pos: true,
          available_for_qr: true,
          sort_order: 1,
          created_at: "2026-06-22T00:00:00.000Z",
          updated_at: "2026-06-22T00:00:00.000Z",
        },
      ],
      product_variants: [],
      modifier_groups: [],
      modifier_options: [],
      catalog_variant_templates: [
        {
          id: "source-variant-1",
          store_id: "source-store",
          name: "เพิ่มช็อต",
          price_adjustment: 0,
          sort_order: 1,
          created_at: "2026-06-22T00:00:00.000Z",
          updated_at: "2026-06-22T00:00:00.000Z",
        },
        {
          id: "source-variant-2",
          store_id: "source-store",
          name: " เพิ่มช็อต ",
          price_adjustment: 10,
          sort_order: 2,
          created_at: "2026-06-22T00:00:00.000Z",
          updated_at: "2026-06-22T00:00:00.000Z",
        },
      ],
      catalog_modifier_group_templates: [
        {
          id: "source-group-1",
          store_id: "source-store",
          name: "ระดับความหวาน",
          selection_type: "single",
          is_required: true,
          min_selections: 1,
          max_selections: 1,
          sort_order: 1,
          created_at: "2026-06-22T00:00:00.000Z",
          updated_at: "2026-06-22T00:00:00.000Z",
        },
      ],
      catalog_modifier_option_templates: [
        {
          id: "source-option-1",
          group_template_id: "source-group-1",
          name: "หวานปกติ",
          price_adjustment: 0,
          is_default: true,
          sort_order: 1,
          created_at: "2026-06-22T00:00:00.000Z",
          updated_at: "2026-06-22T00:00:00.000Z",
        },
        {
          id: "source-option-2",
          group_template_id: "source-group-1",
          name: " หวานปกติ ",
          price_adjustment: 5,
          is_default: false,
          sort_order: 2,
          created_at: "2026-06-22T00:00:00.000Z",
          updated_at: "2026-06-22T00:00:00.000Z",
        },
      ],
    });
    const repository = await importRepositoryWithSupabase(supabase);

    const result = await repository.copyProductsAcrossBranches({
      organizationId: "org-1",
      sourceStoreId: "source-store",
      targetStoreIds: ["target-a"],
      productIds: ["product-1"],
      priceMode: "copy",
      duplicateMode: "skip",
    });

    expect(result.error).toBeNull();
    expect(result.data).toEqual({ created: 0, updated: 0, skipped: 1 });
    expect(supabase.inserted.catalog_variant_templates).toEqual([
      expect.objectContaining({ store_id: "target-a", name: "เพิ่มช็อต", price_adjustment: 0 }),
      expect.objectContaining({ store_id: "target-a", name: " เพิ่มช็อต ", price_adjustment: 10 }),
    ]);
    expect(supabase.inserted.catalog_modifier_group_templates).toEqual([
      expect.objectContaining({
        store_id: "target-a",
        name: "ระดับความหวาน",
        selection_type: "single",
      }),
    ]);
    expect(supabase.inserted.catalog_modifier_option_templates).toEqual([
      expect.objectContaining({
        group_template_id: "catalog_modifier_group_templates-created-1",
        name: "หวานปกติ",
        price_adjustment: 0,
      }),
      expect.objectContaining({
        group_template_id: "catalog_modifier_group_templates-created-1",
        name: " หวานปกติ ",
        price_adjustment: 5,
      }),
    ]);
  });

  it("activates existing-product rollback only after the product update succeeds", () => {
    const repository = read("src/modules/catalog/repository.ts");
    const existingBranch = repository.slice(repository.indexOf("if (existingProduct)"));
    const updateFailureIndex = existingBranch.indexOf("if (updateError) return rollbackAndReturn(updateError);");
    const rollbackIndex = existingBranch.indexOf(
      "rollbackSteps.push(async () => restoreExistingProductSnapshot(supabase, existingProduct));",
    );
    const deleteChildrenIndex = existingBranch.indexOf("const childrenError = await deleteProductChildren");

    expect(updateFailureIndex).toBeGreaterThan(0);
    expect(rollbackIndex).toBeGreaterThan(updateFailureIndex);
    expect(deleteChildrenIndex).toBeGreaterThan(rollbackIndex);
  });

  it("server action sends selected products and target branches to repository", async () => {
    const { actions, copyProductsAcrossBranches, requirePermission, revalidatePath } = await importActions();

    const result = await actions.copyProductsAcrossBranchesAction(
      { error: null, message: null },
      fd({
        productIds: ["product-1", "product-2"],
        targetStoreIds: ["target-a", "target-b"],
        priceMode: "copy",
        duplicateMode: "skip",
      }),
    );

    expect(result.error).toBeNull();
    expect(result.message).toContain("คัดลอกสินค้า");
    expect(requirePermission).toHaveBeenCalledWith("catalog.manage");
    expect(copyProductsAcrossBranches).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-1",
        sourceStoreId: "source-store",
        targetStoreIds: ["target-a", "target-b"],
        productIds: ["product-1", "product-2"],
        priceMode: "copy",
        duplicateMode: "skip",
      }),
    );
    expect(revalidatePath).toHaveBeenCalledWith("/catalog");
  });

  it("server action blocks copy when multi-branch feature is unavailable", async () => {
    const { actions, copyProductsAcrossBranches } = await importActions({ multiBranchEnabled: false });

    const result = await actions.copyProductsAcrossBranchesAction(
      { error: null, message: null },
      fd({
        productIds: "product-1",
        targetStoreIds: "target-a",
        priceMode: "copy",
        duplicateMode: "skip",
      }),
    );

    expect(result.error).toContain("หลายสาขา");
    expect(copyProductsAcrossBranches).not.toHaveBeenCalled();
  });

  it("catalog UI exposes copy controls with price and duplicate policies", () => {
    const manager = read("src/app/(dashboard)/catalog/CatalogManager.tsx");
    const page = read("src/app/(dashboard)/catalog/page.tsx");

    expect(page).toContain("listBranchStores");
    expect(page).toContain("canUseMultiBranch={features.multiBranchReporting}");
    expect(manager).toContain("canUseMultiBranch");
    expect(manager).toContain("CatalogToolsDialogs");
    expect(manager).toContain('dialogMode === "branch-copy"');
    expect(manager).toContain('dialogMode === "variant-templates"');
    expect(manager).toContain('dialogMode === "modifier-group-templates"');
    expect(manager).toContain("เปิดคัดลอกสินค้าไปสาขา");
    expect(manager).toContain("เปิดคลังตัวเลือกสินค้า");
    expect(manager).toContain("เปิดคลังกลุ่มตัวเลือก");
    expect(manager).toContain("คัดลอกสินค้าไปสาขา");
    expect(manager).toContain("สาขาปลายทาง");
    expect(manager).toContain("คัดลอกราคาเหมือนต้นทาง");
    expect(manager).toContain("คงราคาสาขาปลายทาง");
    expect(manager).toContain("ข้ามสินค้าที่เชื่อมโยงแล้ว");
    expect(manager).toContain("อัปเดตข้อมูล แต่คงราคาตาม policy");
  });

  it("catalog UI shows localized loading inside dialogs while product or branch-copy actions run", () => {
    const manager = read("src/app/(dashboard)/catalog/CatalogManager.tsx");
    const productFormStart = manager.indexOf("function ProductForm(");
    const productFormSource = manager.slice(productFormStart, manager.indexOf("// ─── Variant", productFormStart));
    const branchCopyStart = manager.indexOf("function BranchCopyPanel(");
    const branchCopySource = manager.slice(branchCopyStart, manager.indexOf("function CatalogToolsDialogs", branchCopyStart));

    expect(manager).toContain("LocalizedLoading");
    expect(productFormSource).toContain("isPending &&");
    expect(productFormSource).toContain("กำลังบันทึกสินค้า");
    expect(branchCopySource).toContain("isPending &&");
    expect(branchCopySource).toContain("กำลังคัดลอกสินค้าไปสาขา");
    expect(branchCopySource).toContain("relative");
  });
});
