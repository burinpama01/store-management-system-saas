import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  revalidatePath: vi.fn(),
  requirePermission: vi.fn(),
  getCurrentUser: vi.fn(),
  getUserStores: vi.fn(),
  resolveCurrentStore: vi.fn(),
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
  setModifierOptionTemplateDefault: vi.fn(),
  createModifierOption: vi.fn(),
  deleteModifierOption: vi.fn(),
  setModifierOptionDefault: vi.fn(),
  getProduct: vi.fn(),
  getModifierGroupStoreId: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: mocks.revalidatePath,
}));

vi.mock("@/modules/auth/guards", () => ({
  requirePermission: mocks.requirePermission,
}));

vi.mock("@/modules/auth/session", () => ({
  getCurrentUser: mocks.getCurrentUser,
  getUserStores: mocks.getUserStores,
  resolveCurrentStore: mocks.resolveCurrentStore,
}));

vi.mock("@/modules/catalog/repository", () => ({
  createCategory: mocks.createCategory,
  updateCategory: mocks.updateCategory,
  deleteCategory: mocks.deleteCategory,
  createProduct: mocks.createProduct,
  updateProduct: mocks.updateProduct,
  deleteProduct: mocks.deleteProduct,
  createVariantTemplate: mocks.createVariantTemplate,
  deleteVariantTemplate: mocks.deleteVariantTemplate,
  getVariantTemplate: mocks.getVariantTemplate,
  createVariant: mocks.createVariant,
  deleteVariant: mocks.deleteVariant,
  listModifierGroupTemplates: mocks.listModifierGroupTemplates,
  createModifierGroupTemplate: mocks.createModifierGroupTemplate,
  deleteModifierGroupTemplate: mocks.deleteModifierGroupTemplate,
  getModifierGroupTemplate: mocks.getModifierGroupTemplate,
  createModifierGroup: mocks.createModifierGroup,
  deleteModifierGroup: mocks.deleteModifierGroup,
  createModifierOptionTemplate: mocks.createModifierOptionTemplate,
  deleteModifierOptionTemplate: mocks.deleteModifierOptionTemplate,
  setModifierOptionTemplateDefault: mocks.setModifierOptionTemplateDefault,
  createModifierOption: mocks.createModifierOption,
  deleteModifierOption: mocks.deleteModifierOption,
  setModifierOptionDefault: mocks.setModifierOptionDefault,
  getProduct: mocks.getProduct,
  getModifierGroupStoreId: mocks.getModifierGroupStoreId,
}));

function read(path: string) {
  return readFileSync(join(process.cwd(), path), "utf8");
}

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

describe("catalog variant templates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requirePermission.mockResolvedValue(undefined);
    mocks.getCurrentUser.mockResolvedValue({ id: "manager-1", email: "manager@example.com" });
    mocks.getUserStores.mockResolvedValue({ organizations: [], stores: [], memberships: [] });
    mocks.resolveCurrentStore.mockResolvedValue({
      organizationId: "org-1",
      storeId: "store-1",
      storeTimezone: "Asia/Bangkok",
    });
    mocks.getProduct.mockResolvedValue({
      data: {
        id: "product-1",
        storeId: "store-1",
        variants: [],
        modifierGroups: [],
      },
      error: null,
    });
    mocks.getVariantTemplate.mockResolvedValue({
      data: {
        id: "template-1",
        storeId: "store-1",
        name: "L",
        priceAdjustment: 10,
      },
      error: null,
    });
    mocks.createVariant.mockResolvedValue({ data: { id: "variant-1" }, error: null });
    mocks.getModifierGroupTemplate.mockResolvedValue({
      data: {
        id: "group-template-1",
        storeId: "store-1",
        name: "ระดับความหวาน",
        selectionType: "single",
        isRequired: false,
        minSelections: 0,
        maxSelections: 1,
        options: [
          { id: "opt-template-1", name: "0%", priceAdjustment: 0, isDefault: false, sortOrder: 0 },
          { id: "opt-template-2", name: "50%", priceAdjustment: 0, isDefault: false, sortOrder: 1 },
        ],
      },
      error: null,
    });
    mocks.createModifierGroup.mockResolvedValue({
      data: { id: "group-1", name: "ระดับความหวาน" },
      error: null,
    });
    mocks.createModifierOptionTemplate.mockResolvedValue({ data: { id: "option-template-1" }, error: null });
    mocks.createModifierOption.mockResolvedValue({ data: { id: "option-1" }, error: null });
    mocks.getModifierGroupStoreId.mockResolvedValue("store-1");
    mocks.setModifierOptionTemplateDefault.mockResolvedValue({ ok: true, error: null });
    mocks.setModifierOptionDefault.mockResolvedValue({ ok: true, error: null });
  });

  it("adds a store-scoped variant template table with RLS", () => {
    const migration = read("supabase/migrations/20260617000002_catalog_variant_templates.sql");
    const types = read("src/server/integrations/supabase/database.types.ts");

    expect(migration).toContain("create table if not exists catalog_variant_templates");
    expect(migration).toContain("store_id uuid not null references stores(id) on delete cascade");
    expect(migration).toContain("alter table catalog_variant_templates enable row level security");
    expect(migration).toContain('"catalog_variant_templates: store member can read"');
    expect(migration).toContain('"catalog_variant_templates: manager+ can write"');
    expect(migration).toContain("product_variants_product_name_price_unique_idx");
    expect(migration).toContain("lower(btrim(name))");
    expect(migration).toContain("catalog_variant_templates(store_id, lower(btrim(name)), price_adjustment)");
    expect(migration).toContain("duplicate active product variants block variant template unique index");
    expect(migration).toContain("group by product_id, lower(btrim(name)), price_adjustment");
    expect(migration).toContain("having count(*) > 1");
    expect(migration).toContain("create table if not exists catalog_modifier_group_templates");
    expect(migration).toContain("create table if not exists catalog_modifier_option_templates");
    expect(migration).toContain('"catalog_modifier_group_templates: store member can read"');
    expect(migration).toContain('"catalog_modifier_option_templates: manager+ can write"');
    expect(migration).toContain("modifier_groups_product_name_unique_idx");
    expect(types).toContain("catalog_variant_templates");
    expect(types).toContain("catalog_modifier_group_templates");
    expect(types).toContain("catalog_modifier_option_templates");
  });

  it("enforces one default option in single-choice modifier groups at the database layer", () => {
    const migrations = readdirSync(join(process.cwd(), "supabase/migrations"))
      .filter((file) => file.endsWith(".sql"))
      .map((file) => read(`supabase/migrations/${file}`))
      .join("\n");

    expect(migrations).toContain("modifier_options_single_default_guard");
    expect(migrations).toContain("catalog_modifier_option_templates_single_default_guard");
    expect(migrations).toContain("ensure_single_modifier_option_default");
    expect(migrations).toContain("ensure_single_modifier_option_template_default");
    expect(migrations).toContain("for update");
    expect(migrations).toContain("is_default = false");
  });

  it("exposes repository and actions to manage templates and apply them to products", () => {
    const repository = read("src/modules/catalog/repository.ts");
    const actions = read("src/app/(dashboard)/catalog/actions.ts");

    expect(repository).toContain("export async function listVariantTemplates");
    expect(repository).toContain("export async function createVariantTemplate");
    expect(repository).toContain("export async function deleteVariantTemplate");
    expect(repository).toContain("export async function getVariantTemplate");
    expect(repository).toContain("export async function listModifierGroupTemplates");
    expect(repository).toContain("export async function createModifierGroupTemplate");
    expect(repository).toContain("export async function createModifierOptionTemplate");
    expect(repository).toContain("export async function getModifierGroupTemplate");

    expect(actions).toContain("createVariantTemplateAction");
    expect(actions).toContain("deleteVariantTemplateAction");
    expect(actions).toContain("applyVariantTemplateAction");
    expect(actions).toContain("variantTemplateId");
    expect(actions).toContain("template.data.storeId !== ctx.storeId");
    expect(actions).toContain("createVariant({");
    expect(actions).toContain("name: template.data.name");
    expect(actions).toContain("priceAdjustment: template.data.priceAdjustment");
    expect(actions).toContain("createModifierGroupTemplateAction");
    expect(actions).toContain("addModifierOptionTemplateAction");
    expect(actions).toContain("applyModifierGroupTemplateAction");
    expect(actions).toContain("modifierGroupTemplateId");
    expect(actions).toContain('getAll("modifierGroupTemplateId")');
    expect(actions).toContain("getModifierGroupTemplate(modifierGroupTemplateId)");
  });

  it("loads templates at catalog page level and reuses them inside the product dialog", () => {
    const page = read("src/app/(dashboard)/catalog/page.tsx");
    const source = read("src/app/(dashboard)/catalog/CatalogManager.tsx");

    expect(page).toContain("listVariantTemplates(ctx.storeId)");
    expect(page).toContain("listModifierGroupTemplates(ctx.storeId)");
    expect(page).toContain("variantTemplates={variantTemplates}");
    expect(page).toContain("modifierGroupTemplates={modifierGroupTemplates}");

    expect(source).toContain("variantTemplates: VariantTemplate[]");
    expect(source).toContain("modifierGroupTemplates: ModifierGroupTemplate[]");
    expect(source).toContain("function VariantTemplatesPanel");
    expect(source).toContain("function ModifierGroupTemplatesPanel");
    expect(source).toContain("<VariantTemplatesPanel");
    expect(source).toContain("<ModifierGroupTemplatesPanel");
    expect(source).toContain("variantTemplates={variantTemplates}");
    expect(source).toContain("modifierGroupTemplates={modifierGroupTemplates}");
    expect(source).toContain("applyVariantTemplateAction(product.id");
    expect(source).toContain("applyModifierGroupTemplateAction(product.id");
    expect(source).toContain('name="variantTemplateId"');
    expect(source).toContain('name="modifierGroupTemplateId"');
    expect(source).toContain("เลือกจากคลังตัวเลือก");
    expect(source).toContain("เลือกกลุ่มตัวเลือกจากคลังได้หลายกลุ่ม");
    expect(source).toContain('type="checkbox"');
    expect(source).toContain("selectedTemplateIds");
    expect(source).not.toContain('<select\n          name="modifierGroupTemplateId"');
    expect(source).toContain("variantTemplateMessage");
    expect(source).toContain("await deleteVariantTemplateAction(template.id)");
    expect(source).toContain("setVariantTemplateMessage");
  });

  it("surfaces modifier default controls in catalog template and product option UI", () => {
    const source = read("src/app/(dashboard)/catalog/CatalogManager.tsx");

    expect(source).toContain("setModifierOptionTemplateDefaultAction");
    expect(source).toContain("setModifierOptionDefaultAction");
    expect(source).toContain('name="isDefault"');
    expect(source).toContain("ค่าเริ่มต้น");
  });

  it("rejects applying a template from another store before creating a variant", async () => {
    mocks.getVariantTemplate.mockResolvedValue({
      data: { id: "template-2", storeId: "store-2", name: "XL", priceAdjustment: 20 },
      error: null,
    });
    const { applyVariantTemplateAction } = await import("@/app/(dashboard)/catalog/actions");

    const result = await applyVariantTemplateAction(
      "product-1",
      { error: null },
      fd({ variantTemplateId: "template-2" }),
    );

    expect(result.error).toBe("ไม่มีสิทธิ์");
    expect(mocks.createVariant).not.toHaveBeenCalled();
  });

  it("rejects duplicate variants before inserting", async () => {
    mocks.getProduct.mockResolvedValue({
      data: {
        id: "product-1",
        storeId: "store-1",
        variants: [{ name: " l ", priceAdjustment: 10 }],
      },
      error: null,
    });
    const { applyVariantTemplateAction } = await import("@/app/(dashboard)/catalog/actions");

    const result = await applyVariantTemplateAction(
      "product-1",
      { error: null },
      fd({ variantTemplateId: "template-1" }),
    );

    expect(result.error).toBe("ตัวเลือกนี้อยู่ในเมนูแล้ว");
    expect(mocks.createVariant).not.toHaveBeenCalled();
  });

  it("maps duplicate insert races to a clear Thai error", async () => {
    mocks.createVariant.mockResolvedValue({
      data: null,
      error: {
        code: "23505",
        message: "duplicate key value violates unique constraint",
        userMessage: "A record with this value already exists.",
      },
    });
    const { applyVariantTemplateAction } = await import("@/app/(dashboard)/catalog/actions");

    const result = await applyVariantTemplateAction(
      "product-1",
      { error: null },
      fd({ variantTemplateId: "template-1" }),
    );

    expect(result.error).toBe("ตัวเลือกนี้อยู่ในเมนูแล้ว");
    expect(mocks.createVariant).toHaveBeenCalledWith({
      productId: "product-1",
      name: "L",
      priceAdjustment: 10,
    });
  });

  it("maps duplicate variant template creation to a clear Thai error", async () => {
    mocks.createVariantTemplate.mockResolvedValue({
      data: null,
      error: {
        code: "23505",
        message: "duplicate key value violates unique constraint",
        userMessage: "A record with this value already exists.",
      },
    });
    const { createVariantTemplateAction } = await import("@/app/(dashboard)/catalog/actions");

    const result = await createVariantTemplateAction(
      { error: null },
      fd({ variantName: "L", priceAdjustment: "10" }),
    );

    expect(result.error).toBe("ตัวเลือกนี้มีอยู่ในคลังแล้ว");
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("rejects applying a modifier group template from another store before creating product options", async () => {
    mocks.getModifierGroupTemplate.mockResolvedValue({
      data: {
        id: "group-template-2",
        storeId: "store-2",
        name: "ขนาด",
        selectionType: "single",
        isRequired: false,
        minSelections: 0,
        maxSelections: 1,
        options: [],
      },
      error: null,
    });
    const { applyModifierGroupTemplateAction } = await import("@/app/(dashboard)/catalog/actions");

    const result = await applyModifierGroupTemplateAction(
      "product-1",
      { error: null },
      fd({ modifierGroupTemplateId: "group-template-2" }),
    );

    expect(result.error).toBe("ไม่มีสิทธิ์");
    expect(mocks.createModifierGroup).not.toHaveBeenCalled();
    expect(mocks.createModifierOption).not.toHaveBeenCalled();
  });

  it("copies a modifier group template and its options into a product", async () => {
    const { applyModifierGroupTemplateAction } = await import("@/app/(dashboard)/catalog/actions");

    const result = await applyModifierGroupTemplateAction(
      "product-1",
      { error: null },
      fd({ modifierGroupTemplateId: "group-template-1" }),
    );

    expect(result.error).toBeNull();
    expect(mocks.createModifierGroup).toHaveBeenCalledWith({
      productId: "product-1",
      name: "ระดับความหวาน",
      selectionType: "single",
      isRequired: false,
      minSelections: 0,
      maxSelections: 1,
    });
    expect(mocks.createModifierOption).toHaveBeenCalledTimes(2);
    expect(mocks.createModifierOption).toHaveBeenCalledWith({
      modifierGroupId: "group-1",
      name: "0%",
      priceAdjustment: 0,
      isDefault: false,
      sortOrder: 0,
    });
  });

  it("allows modifier defaults to be configured from existing template and product options", async () => {
    const {
      addModifierOptionTemplateAction,
      setModifierOptionTemplateDefaultAction,
      addModifierOptionAction,
      setModifierOptionDefaultAction,
    } = await import("@/app/(dashboard)/catalog/actions");

    const templateCreateResult = await addModifierOptionTemplateAction(
      "group-template-1",
      { error: null, message: null },
      fd({ optionName: "100%", priceAdjustment: "0", isDefault: "on" }),
    );
    const templateDefaultResult = await setModifierOptionTemplateDefaultAction("opt-template-2", true);
    const productCreateResult = await addModifierOptionAction(
      "group-1",
      { error: null },
      fd({ optionName: "นมสด", priceAdjustment: "0", isDefault: "on" }),
    );
    const productDefaultResult = await setModifierOptionDefaultAction("option-2", true);

    expect(templateCreateResult.error).toBeNull();
    expect(templateDefaultResult.error).toBeNull();
    expect(productCreateResult.error).toBeNull();
    expect(productDefaultResult.error).toBeNull();
    expect(mocks.createModifierOptionTemplate).toHaveBeenCalledWith({
      groupTemplateId: "group-template-1",
      name: "100%",
      priceAdjustment: 0,
      sortOrder: 2,
      isDefault: true,
    });
    expect(mocks.setModifierOptionTemplateDefault).toHaveBeenCalledTimes(1);
    expect(mocks.setModifierOptionTemplateDefault).toHaveBeenCalledWith("opt-template-2", "store-1", true);
    expect(mocks.createModifierOption).toHaveBeenCalledWith({
      modifierGroupId: "group-1",
      name: "นมสด",
      priceAdjustment: 0,
      isDefault: true,
    });
    expect(mocks.setModifierOptionDefault).toHaveBeenCalledTimes(1);
    expect(mocks.setModifierOptionDefault).toHaveBeenCalledWith("option-2", "store-1", true);
  });

  it("copies multiple modifier group templates from one form submission", async () => {
    mocks.getModifierGroupTemplate
      .mockResolvedValueOnce({
        data: {
          id: "group-template-sweet",
          storeId: "store-1",
          name: "ระดับความหวาน",
          selectionType: "single",
          isRequired: false,
          minSelections: 0,
          maxSelections: 1,
          options: [
            { id: "sweet-0", name: "0%", priceAdjustment: 0, isDefault: false, sortOrder: 0 },
          ],
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: "group-template-temp",
          storeId: "store-1",
          name: "ประเภท",
          selectionType: "single",
          isRequired: true,
          minSelections: 1,
          maxSelections: 1,
          options: [
            { id: "temp-hot", name: "ร้อน", priceAdjustment: 0, isDefault: false, sortOrder: 0 },
          ],
        },
        error: null,
      });
    mocks.createModifierGroup
      .mockResolvedValueOnce({ data: { id: "group-sweet", name: "ระดับความหวาน" }, error: null })
      .mockResolvedValueOnce({ data: { id: "group-temp", name: "ประเภท" }, error: null });
    const { applyModifierGroupTemplateAction } = await import("@/app/(dashboard)/catalog/actions");

    const result = await applyModifierGroupTemplateAction(
      "product-1",
      { error: null, message: null },
      fd({ modifierGroupTemplateId: ["group-template-sweet", "group-template-temp"] }),
    );

    expect(result).toEqual({ error: null, message: "เพิ่มกลุ่มตัวเลือก 2 กลุ่มในเมนูแล้ว" });
    expect(mocks.createModifierGroup).toHaveBeenCalledTimes(2);
    expect(mocks.createModifierOption).toHaveBeenCalledTimes(2);
    expect(mocks.createModifierOption).toHaveBeenNthCalledWith(1, {
      modifierGroupId: "group-sweet",
      name: "0%",
      priceAdjustment: 0,
      isDefault: false,
      sortOrder: 0,
    });
    expect(mocks.createModifierOption).toHaveBeenNthCalledWith(2, {
      modifierGroupId: "group-temp",
      name: "ร้อน",
      priceAdjustment: 0,
      isDefault: false,
      sortOrder: 0,
    });
  });

  it("rolls back earlier copied groups when a later selected group fails", async () => {
    mocks.getModifierGroupTemplate
      .mockResolvedValueOnce({
        data: {
          id: "group-template-sweet",
          storeId: "store-1",
          name: "ระดับความหวาน",
          selectionType: "single",
          isRequired: false,
          minSelections: 0,
          maxSelections: 1,
          options: [
            { id: "sweet-0", name: "0%", priceAdjustment: 0, isDefault: false, sortOrder: 0 },
          ],
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: "group-template-temp",
          storeId: "store-1",
          name: "ประเภท",
          selectionType: "single",
          isRequired: true,
          minSelections: 1,
          maxSelections: 1,
          options: [
            { id: "temp-hot", name: "ร้อน", priceAdjustment: 0, isDefault: false, sortOrder: 0 },
          ],
        },
        error: null,
      });
    mocks.createModifierGroup
      .mockResolvedValueOnce({ data: { id: "group-sweet", name: "ระดับความหวาน" }, error: null })
      .mockResolvedValueOnce({ data: null, error: { userMessage: "สร้างกลุ่มไม่สำเร็จ" } });
    mocks.deleteModifierGroup.mockResolvedValue({ error: null });
    const { applyModifierGroupTemplateAction } = await import("@/app/(dashboard)/catalog/actions");

    const result = await applyModifierGroupTemplateAction(
      "product-1",
      { error: null, message: null },
      fd({ modifierGroupTemplateId: ["group-template-sweet", "group-template-temp"] }),
    );

    expect(result.error).toBe("สร้างกลุ่มไม่สำเร็จ");
    expect(mocks.deleteModifierGroup).toHaveBeenCalledWith("group-sweet", "store-1");
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("rejects required modifier group templates without options before creating a product group", async () => {
    mocks.getModifierGroupTemplate.mockResolvedValue({
      data: {
        id: "group-template-empty",
        storeId: "store-1",
        name: "ระดับความหวาน",
        selectionType: "single",
        isRequired: true,
        minSelections: 1,
        maxSelections: 1,
        options: [],
      },
      error: null,
    });
    const { applyModifierGroupTemplateAction } = await import("@/app/(dashboard)/catalog/actions");

    const result = await applyModifierGroupTemplateAction(
      "product-1",
      { error: null },
      fd({ modifierGroupTemplateId: "group-template-empty" }),
    );

    expect(result.error).toBe("เพิ่มตัวเลือกในกลุ่มนี้ก่อนนำไปใช้ในเมนู");
    expect(mocks.createModifierGroup).not.toHaveBeenCalled();
    expect(mocks.createModifierOption).not.toHaveBeenCalled();
  });

  it("reports a partial-copy risk when modifier option copy fails and rollback fails", async () => {
    mocks.createModifierOption
      .mockResolvedValueOnce({ data: { id: "option-1" }, error: null })
      .mockResolvedValueOnce({
        data: null,
        error: { userMessage: "สร้างตัวเลือกไม่สำเร็จ" },
      });
    mocks.deleteModifierGroup.mockResolvedValue({
      ok: false,
      error: { userMessage: "ลบกลุ่มที่สร้างไว้ไม่สำเร็จ" },
    });
    const { applyModifierGroupTemplateAction } = await import("@/app/(dashboard)/catalog/actions");

    const result = await applyModifierGroupTemplateAction(
      "product-1",
      { error: null },
      fd({ modifierGroupTemplateId: "group-template-1" }),
    );

    expect(result.error).toBe(
      "คัดลอกกลุ่มตัวเลือกไม่ครบ และลบกลุ่มที่สร้างไว้ไม่สำเร็จ: ลบกลุ่มที่สร้างไว้ไม่สำเร็จ",
    );
    expect(mocks.createModifierOption).toHaveBeenCalledTimes(2);
    expect(mocks.deleteModifierGroup).toHaveBeenCalledWith("group-1", "store-1");
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});
