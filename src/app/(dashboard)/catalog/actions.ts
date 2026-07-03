"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/modules/auth/guards";
import { getCurrentUser, getUserStores, resolveCurrentStore } from "@/modules/auth/session";
import { DEFAULT_BILLING_STATE, getPlanFeatures } from "@/modules/billing/types";
import { getOrganizationBillingState } from "@/modules/billing/billing-service";
import {
  createCategory,
  updateCategory,
  deleteCategory,
  createProduct,
  updateProduct,
  deleteProduct,
  createVariantTemplate,
  deleteVariantTemplate,
  getVariantTemplate,
  createModifierGroupTemplate,
  deleteModifierGroupTemplate,
  getModifierGroupTemplate,
  createModifierOptionTemplate,
  deleteModifierOptionTemplate,
  setModifierOptionTemplateDefault,
  createVariant,
  deleteVariant,
  createModifierGroup,
  deleteModifierGroup,
  createModifierOption,
  deleteModifierOption,
  setModifierOptionDefault,
  getProduct,
  getModifierGroupStoreId,
  copyProductsAcrossBranches,
  replaceProductUnits,
  type CatalogCopyDuplicateMode,
  type CatalogCopyPriceMode,
  type ProductUnitInput,
} from "@/modules/catalog/repository";
import type { ModifierGroupTemplate } from "@/modules/catalog/types";
import { getActiveLinkByStore } from "@/modules/connect/repository";
import { syncMenuForLink } from "@/modules/connect/menu-sync";

/** ดันเมนูขึ้น JDC อัตโนมัติหลังแก้สินค้า (best-effort ไม่บล็อกการบันทึก) */
async function autoSyncDeliveryMenu(storeId: string) {
  try {
    const link = await getActiveLinkByStore(storeId);
    if (link) await syncMenuForLink(link, false);
  } catch {
    /* ไม่ให้กระทบการบันทึกสินค้า */
  }
}

/** อ่านราคาเดลิเวอรีจากฟอร์ม: ว่าง = null (ใช้ราคาหน้าร้าน) */
function readDeliveryPrice(formData: FormData): { value: number | null; error: string | null } {
  const raw = (formData.get("deliveryPrice") as string | null)?.trim();
  if (!raw) return { value: null, error: null };
  const n = parseFloat(raw);
  if (isNaN(n) || n < 0) return { value: null, error: "ราคาเดลิเวอรีไม่ถูกต้อง" };
  return { value: n, error: null };
}

/** อ่านราคาต่อระดับลูกค้า: ว่าง = null (ใช้ราคาปลีก) */
function readTierPrice(formData: FormData, key: string): { value: number | null; error: string | null } {
  const raw = (formData.get(key) as string | null)?.trim();
  if (!raw) return { value: null, error: null };
  const n = parseFloat(raw);
  if (isNaN(n) || n < 0) return { value: null, error: "ราคาตามระดับลูกค้าไม่ถูกต้อง" };
  return { value: n, error: null };
}

/** อ่านหน่วยแพ็ค (โหล/ลัง) จาก hidden JSON field ของฟอร์มสินค้า */
function readWholesaleUnits(formData: FormData): { units: ProductUnitInput[] | null; error: string | null } {
  const raw = (formData.get("unitsJson") as string | null)?.trim();
  if (!raw) return { units: null, error: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { units: null, error: "ข้อมูลหน่วยขายไม่ถูกต้อง" };
  }
  if (!Array.isArray(parsed)) return { units: null, error: "ข้อมูลหน่วยขายไม่ถูกต้อง" };

  const units: ProductUnitInput[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) return { units: null, error: "ข้อมูลหน่วยขายไม่ถูกต้อง" };
    const unit = item as Record<string, unknown>;
    const name = typeof unit.name === "string" ? unit.name.trim() : "";
    if (!name) continue;
    const quantity = Number(unit.quantity);
    const price = Number(unit.price);
    if (!Number.isInteger(quantity) || quantity < 2) {
      return { units: null, error: `หน่วย "${name}" ต้องระบุจำนวนชิ้นต่อหน่วยตั้งแต่ 2 ขึ้นไป` };
    }
    if (!Number.isFinite(price) || price < 0) {
      return { units: null, error: `หน่วย "${name}" ราคาไม่ถูกต้อง` };
    }
    const tier = (key: string): number | null => {
      const value = unit[key];
      if (value === null || value === undefined || value === "") return null;
      const n = Number(value);
      return Number.isFinite(n) && n >= 0 ? n : null;
    };
    units.push({
      id: typeof unit.id === "string" && unit.id ? unit.id : null,
      name,
      quantity,
      price,
      priceWholesale: tier("priceWholesale"),
      priceAgent: tier("priceAgent"),
      priceRegular: tier("priceRegular"),
      barcode: typeof unit.barcode === "string" ? unit.barcode : null,
      sortOrder: units.length,
    });
  }
  return { units, error: null };
}

async function getStoreContext() {
  const user = await getCurrentUser();
  if (!user) throw new Error("ไม่มีสิทธิ์เข้าถึง");
  const { organizations, stores, memberships } = await getUserStores();
  const ctx = await resolveCurrentStore(stores, organizations, memberships);
  if (!ctx) throw new Error("ไม่พบข้อมูลร้านค้า");
  return ctx;
}

function revalidate() {
  revalidatePath("/catalog");
}

function readFormList(formData: FormData, key: string) {
  return formData
    .getAll(key)
    .map((value) => String(value).trim())
    .filter(Boolean);
}

function isDuplicateVariantError(error: { code?: string; message?: string } | null) {
  if (!error) return false;
  return (
    error.code === "23505" ||
    (error.message ?? "").includes("product_variants_product_name_price_unique_idx")
  );
}

function isDuplicateVariantTemplateError(error: { code?: string; message?: string } | null) {
  if (!error) return false;
  return (
    error.code === "23505" ||
    (error.message ?? "").includes("catalog_variant_templates_store_name_price_idx")
  );
}

function isDuplicateModifierGroupError(error: { code?: string; message?: string } | null) {
  if (!error) return false;
  return (
    error.code === "23505" ||
    (error.message ?? "").includes("modifier_groups_product_name_unique_idx")
  );
}

function isDuplicateModifierGroupTemplateError(error: { code?: string; message?: string } | null) {
  if (!error) return false;
  return (
    error.code === "23505" ||
    (error.message ?? "").includes("catalog_modifier_group_templates_store_name_idx")
  );
}

function isDuplicateModifierOptionTemplateError(error: { code?: string; message?: string } | null) {
  if (!error) return false;
  return (
    error.code === "23505" ||
    (error.message ?? "").includes("catalog_modifier_option_templates_group_name_price_idx")
  );
}

function readOptionalUrl(formData: FormData, key: string) {
  const value = (formData.get(key) as string | null)?.trim();
  if (!value) return { value: undefined, error: null };
  if (value.length > 600) return { value: undefined, error: "URL รูปภาพยาวเกินไป" };
  if (!/^https?:\/\//i.test(value)) {
    return { value: undefined, error: "URL รูปภาพต้องขึ้นต้นด้วย http:// หรือ https://" };
  }
  return { value, error: null };
}

// ─── Categories ─────────────────────────────────────────────

export async function createCategoryAction(
  _prev: { error: string | null },
  formData: FormData,
): Promise<{ error: string | null }> {
  try {
    await requirePermission("catalog.manage");
    const ctx = await getStoreContext();
    const name = (formData.get("name") as string | null)?.trim() ?? "";
    if (!name) return { error: "กรุณาระบุชื่อหมวดหมู่" };

    const result = await createCategory({
      organization_id: ctx.organizationId,
      store_id: ctx.storeId,
      name,
      description: (formData.get("description") as string | null)?.trim() || null,
    });
    if (result.error) return { error: result.error.userMessage };
    revalidate();
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

export async function updateCategoryAction(
  id: string,
  _prev: { error: string | null },
  formData: FormData,
): Promise<{ error: string | null }> {
  try {
    await requirePermission("catalog.manage");
    const ctx = await getStoreContext();
    const name = (formData.get("name") as string | null)?.trim() ?? "";
    if (!name) return { error: "กรุณาระบุชื่อหมวดหมู่" };

    const result = await updateCategory(id, ctx.storeId, {
      name,
      description: (formData.get("description") as string | null)?.trim() || undefined,
    });
    if (result.error) return { error: result.error.userMessage };
    revalidate();
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

export async function deleteCategoryAction(id: string): Promise<{ error: string | null }> {
  try {
    await requirePermission("catalog.manage");
    const ctx = await getStoreContext();
    const result = await deleteCategory(id, ctx.storeId);
    if (result.error) return { error: result.error.userMessage };
    revalidate();
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

// ─── Products ───────────────────────────────────────────────

export async function createProductAction(
  _prev: { error: string | null },
  formData: FormData,
): Promise<{ error: string | null }> {
  try {
    await requirePermission("catalog.manage");
    const ctx = await getStoreContext();

    const name = (formData.get("name") as string | null)?.trim() ?? "";
    const categoryId = (formData.get("categoryId") as string | null) ?? "";
    const basePriceRaw = formData.get("basePrice") as string | null;
    const basePrice = basePriceRaw ? parseFloat(basePriceRaw) : 0;

    if (!name) return { error: "กรุณาระบุชื่อสินค้า" };
    if (!categoryId) return { error: "กรุณาเลือกหมวดหมู่" };
    if (isNaN(basePrice) || basePrice < 0) return { error: "ราคาไม่ถูกต้อง" };
    const imageUrl = readOptionalUrl(formData, "imageUrl");
    if (imageUrl.error) return { error: imageUrl.error };

    const availableForQr = formData.get("availableForQr") === "on";
    const kitchenStationId = (formData.get("kitchenStationId") as string | null) || null;
    if (availableForQr && !kitchenStationId) {
      return { error: "กรุณาเลือกครัว/บาร์สำหรับสินค้าที่ขายผ่าน QR (เพิ่มได้ที่ ตั้งค่า → Kitchen)" };
    }
    const deliveryPrice = readDeliveryPrice(formData);
    if (deliveryPrice.error) return { error: deliveryPrice.error };
    const priceWholesale = readTierPrice(formData, "priceWholesale");
    if (priceWholesale.error) return { error: priceWholesale.error };
    const priceAgent = readTierPrice(formData, "priceAgent");
    if (priceAgent.error) return { error: priceAgent.error };
    const priceRegular = readTierPrice(formData, "priceRegular");
    if (priceRegular.error) return { error: priceRegular.error };
    const wholesaleUnits = readWholesaleUnits(formData);
    if (wholesaleUnits.error) return { error: wholesaleUnits.error };

    const result = await createProduct({
      storeId: ctx.storeId,
      organizationId: ctx.organizationId,
      categoryId,
      name,
      description: (formData.get("description") as string | null)?.trim() || undefined,
      barcode: (formData.get("barcode") as string | null)?.trim() || undefined,
      imageUrl: imageUrl.value,
      basePrice,
      unitLabel: (formData.get("unitLabel") as string | null)?.trim() || null,
      priceWholesale: priceWholesale.value,
      priceAgent: priceAgent.value,
      priceRegular: priceRegular.value,
      availableForPos: formData.get("availableForPos") === "on",
      availableForQr,
      availableForDelivery: formData.get("availableForDelivery") === "on",
      deliveryPrice: deliveryPrice.value,
      deliveryOutOfStock: formData.get("deliveryOutOfStock") === "on",
      kitchenStationId: availableForQr ? kitchenStationId : null,
    });
    if (result.error) return { error: result.error.userMessage };
    if (wholesaleUnits.units && result.data) {
      const unitsRes = await replaceProductUnits(result.data.id, ctx.storeId, wholesaleUnits.units);
      if (unitsRes.error) return { error: unitsRes.error.userMessage };
    }
    revalidate();
    await autoSyncDeliveryMenu(ctx.storeId);
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

export async function updateProductAction(
  id: string,
  _prev: { error: string | null },
  formData: FormData,
): Promise<{ error: string | null }> {
  try {
    await requirePermission("catalog.manage");
    const ctx = await getStoreContext();

    const name = (formData.get("name") as string | null)?.trim() ?? "";
    const categoryId = (formData.get("categoryId") as string | null) ?? "";
    const basePriceRaw = formData.get("basePrice") as string | null;
    const basePrice = basePriceRaw ? parseFloat(basePriceRaw) : undefined;

    if (!name) return { error: "กรุณาระบุชื่อสินค้า" };
    if (!categoryId) return { error: "กรุณาเลือกหมวดหมู่" };
    if (basePrice !== undefined && (isNaN(basePrice) || basePrice < 0))
      return { error: "ราคาไม่ถูกต้อง" };
    const imageUrl = readOptionalUrl(formData, "imageUrl");
    if (imageUrl.error) return { error: imageUrl.error };

    const availableForQr = formData.get("availableForQr") === "on";
    const kitchenStationId = (formData.get("kitchenStationId") as string | null) || null;
    if (availableForQr && !kitchenStationId) {
      return { error: "กรุณาเลือกครัว/บาร์สำหรับสินค้าที่ขายผ่าน QR (เพิ่มได้ที่ ตั้งค่า → Kitchen)" };
    }

    const deliveryPrice = readDeliveryPrice(formData);
    if (deliveryPrice.error) return { error: deliveryPrice.error };
    const priceWholesale = readTierPrice(formData, "priceWholesale");
    if (priceWholesale.error) return { error: priceWholesale.error };
    const priceAgent = readTierPrice(formData, "priceAgent");
    if (priceAgent.error) return { error: priceAgent.error };
    const priceRegular = readTierPrice(formData, "priceRegular");
    if (priceRegular.error) return { error: priceRegular.error };
    const wholesaleUnits = readWholesaleUnits(formData);
    if (wholesaleUnits.error) return { error: wholesaleUnits.error };

    const result = await updateProduct(id, ctx.storeId, {
      name,
      categoryId,
      description: (formData.get("description") as string | null)?.trim() || undefined,
      barcode: (formData.get("barcode") as string | null)?.trim() || null,
      imageUrl: imageUrl.value,
      basePrice,
      unitLabel: (formData.get("unitLabel") as string | null)?.trim() || null,
      priceWholesale: priceWholesale.value,
      priceAgent: priceAgent.value,
      priceRegular: priceRegular.value,
      availableForPos: formData.get("availableForPos") === "on",
      availableForQr,
      availableForDelivery: formData.get("availableForDelivery") === "on",
      deliveryPrice: deliveryPrice.value,
      deliveryOutOfStock: formData.get("deliveryOutOfStock") === "on",
      kitchenStationId: availableForQr ? kitchenStationId : null,
      isActive: formData.get("isActive") !== "off",
    });
    if (result.error) return { error: result.error.userMessage };
    if (wholesaleUnits.units) {
      const unitsRes = await replaceProductUnits(id, ctx.storeId, wholesaleUnits.units);
      if (unitsRes.error) return { error: unitsRes.error.userMessage };
    }
    revalidate();
    await autoSyncDeliveryMenu(ctx.storeId);
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

export async function deleteProductAction(id: string): Promise<{ error: string | null }> {
  try {
    await requirePermission("catalog.manage");
    const ctx = await getStoreContext();
    const result = await deleteProduct(id, ctx.storeId);
    if (result.error) return { error: result.error.userMessage };
    revalidate();
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

export async function copyProductsAcrossBranchesAction(
  _prev: { error: string | null; message: string | null },
  formData: FormData,
): Promise<{ error: string | null; message: string | null }> {
  try {
    await requirePermission("catalog.manage");
    const ctx = await getStoreContext();
    const billingState = (await getOrganizationBillingState(ctx.organizationId)) ?? DEFAULT_BILLING_STATE;
    const features = getPlanFeatures(billingState);
    if (!features.multiBranchReporting) {
      return { error: "แพ็กเกจปัจจุบันยังไม่รองรับหลายสาขา", message: null };
    }

    const productIds = readFormList(formData, "productIds");
    const targetStoreIds = readFormList(formData, "targetStoreIds");
    const priceMode = (formData.get("priceMode") as CatalogCopyPriceMode | null) ?? "copy";
    const duplicateMode = (formData.get("duplicateMode") as CatalogCopyDuplicateMode | null) ?? "skip";

    if (productIds.length === 0) return { error: "กรุณาเลือกสินค้า", message: null };
    if (targetStoreIds.length === 0) return { error: "กรุณาเลือกสาขาปลายทาง", message: null };
    if (priceMode !== "copy" && priceMode !== "preserve") {
      return { error: "นโยบายราคาไม่ถูกต้อง", message: null };
    }
    if (duplicateMode !== "skip" && duplicateMode !== "update") {
      return { error: "นโยบายสินค้าซ้ำไม่ถูกต้อง", message: null };
    }

    const result = await copyProductsAcrossBranches({
      organizationId: ctx.organizationId,
      sourceStoreId: ctx.storeId,
      targetStoreIds,
      productIds,
      priceMode,
      duplicateMode,
    });
    if (result.error || !result.data) {
      return { error: result.error?.userMessage ?? "คัดลอกสินค้าไม่สำเร็จ", message: null };
    }

    revalidate();
    return {
      error: null,
      message: `คัดลอกสินค้าแล้ว ${result.data.created} รายการ อัปเดต ${result.data.updated} รายการ ข้าม ${result.data.skipped} รายการ`,
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด", message: null };
  }
}

// ─── Variants ───────────────────────────────────────────────

export async function createVariantTemplateAction(
  _prev: { error: string | null },
  formData: FormData,
): Promise<{ error: string | null }> {
  try {
    await requirePermission("catalog.manage");
    const ctx = await getStoreContext();
    const name = (formData.get("variantName") as string | null)?.trim() ?? "";
    const priceAdjRaw = formData.get("priceAdjustment") as string | null;
    const priceAdj = priceAdjRaw ? parseFloat(priceAdjRaw) : 0;

    if (!name) return { error: "กรุณาระบุชื่อตัวเลือก" };
    if (isNaN(priceAdj)) return { error: "ราคาปรับไม่ถูกต้อง" };

    const result = await createVariantTemplate({
      storeId: ctx.storeId,
      name,
      priceAdjustment: priceAdj,
    });
    if (result.error) {
      return {
        error: isDuplicateVariantTemplateError(result.error)
          ? "ตัวเลือกนี้มีอยู่ในคลังแล้ว"
          : result.error.userMessage,
      };
    }
    revalidate();
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

export async function deleteVariantTemplateAction(id: string): Promise<{ error: string | null }> {
  try {
    await requirePermission("catalog.manage");
    const ctx = await getStoreContext();
    const result = await deleteVariantTemplate(id, ctx.storeId);
    if (result.error) return { error: result.error.userMessage };
    revalidate();
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

export async function applyVariantTemplateAction(
  productId: string,
  _prev: { error: string | null },
  formData: FormData,
): Promise<{ error: string | null }> {
  try {
    await requirePermission("catalog.manage");
    const ctx = await getStoreContext();
    const variantTemplateId = (formData.get("variantTemplateId") as string | null)?.trim() ?? "";

    if (!variantTemplateId) return { error: "กรุณาเลือกตัวเลือกจากคลัง" };

    const productRes = await getProduct(productId);
    if (!productRes.data || productRes.data.storeId !== ctx.storeId)
      return { error: "ไม่มีสิทธิ์" };

    const template = await getVariantTemplate(variantTemplateId);
    if (!template.data || template.data.storeId !== ctx.storeId)
      return { error: "ไม่มีสิทธิ์" };

    const exists = productRes.data.variants.some(
      (variant) =>
        variant.name.trim().toLowerCase() === template.data.name.trim().toLowerCase() &&
        variant.priceAdjustment === template.data.priceAdjustment,
    );
    if (exists) return { error: "ตัวเลือกนี้อยู่ในเมนูแล้ว" };

    const result = await createVariant({
      productId,
      name: template.data.name,
      priceAdjustment: template.data.priceAdjustment,
    });
    if (result.error) {
      return { error: isDuplicateVariantError(result.error) ? "ตัวเลือกนี้อยู่ในเมนูแล้ว" : result.error.userMessage };
    }
    revalidate();
    await autoSyncDeliveryMenu(ctx.storeId);
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

export async function createModifierGroupTemplateAction(
  _prev: { error: string | null; message?: string | null },
  formData: FormData,
): Promise<{ error: string | null; message?: string | null }> {
  try {
    await requirePermission("catalog.manage");
    const ctx = await getStoreContext();
    const name = (formData.get("groupName") as string | null)?.trim() ?? "";
    const selectionType = formData.get("selectionType") as "single" | "multiple";
    const isRequired = formData.get("isRequired") === "on";

    if (!name) return { error: "กรุณาระบุชื่อกลุ่มตัวเลือก", message: null };
    if (selectionType !== "single" && selectionType !== "multiple")
      return { error: "รูปแบบการเลือกไม่ถูกต้อง", message: null };

    const result = await createModifierGroupTemplate({
      storeId: ctx.storeId,
      name,
      selectionType,
      isRequired,
      minSelections: isRequired ? 1 : 0,
      maxSelections: selectionType === "single" ? 1 : 10,
    });
    if (result.error) {
      return {
        error: isDuplicateModifierGroupTemplateError(result.error)
          ? "กลุ่มตัวเลือกนี้มีอยู่ในคลังแล้ว"
          : result.error.userMessage,
        message: null,
      };
    }
    revalidate();
    return { error: null, message: `เพิ่มกลุ่มตัวเลือก ${name} แล้ว` };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด", message: null };
  }
}

export async function deleteModifierGroupTemplateAction(id: string): Promise<{ error: string | null }> {
  try {
    await requirePermission("catalog.manage");
    const ctx = await getStoreContext();
    const result = await deleteModifierGroupTemplate(id, ctx.storeId);
    if (result.error) return { error: result.error.userMessage };
    revalidate();
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

export async function addModifierOptionTemplateAction(
  groupTemplateId: string,
  _prev: { error: string | null; message?: string | null },
  formData: FormData,
): Promise<{ error: string | null; message?: string | null }> {
  try {
    await requirePermission("catalog.manage");
    const ctx = await getStoreContext();
    const name = (formData.get("optionName") as string | null)?.trim() ?? "";
    const priceAdjRaw = formData.get("priceAdjustment") as string | null;
    const priceAdj = priceAdjRaw ? parseFloat(priceAdjRaw) : 0;
    const isDefault = formData.get("isDefault") === "on";

    if (!name) return { error: "กรุณาระบุชื่อตัวเลือก", message: null };
    if (isNaN(priceAdj)) return { error: "ราคาปรับไม่ถูกต้อง", message: null };

    const groupTemplate = await getModifierGroupTemplate(groupTemplateId);
    if (!groupTemplate.data || groupTemplate.data.storeId !== ctx.storeId)
      return { error: "ไม่มีสิทธิ์", message: null };

    const result = await createModifierOptionTemplate({
      groupTemplateId,
      name,
      priceAdjustment: priceAdj,
      sortOrder: groupTemplate.data.options.length,
      isDefault,
    });
    if (result.error) {
      return {
        error: isDuplicateModifierOptionTemplateError(result.error)
          ? "ตัวเลือกนี้มีอยู่ในกลุ่มแล้ว"
          : result.error.userMessage,
        message: null,
      };
    }
    revalidate();
    return { error: null, message: `เพิ่มตัวเลือก ${name} แล้ว` };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด", message: null };
  }
}

export async function deleteModifierOptionTemplateAction(id: string): Promise<{ error: string | null }> {
  try {
    await requirePermission("catalog.manage");
    const ctx = await getStoreContext();
    const result = await deleteModifierOptionTemplate(id, ctx.storeId);
    if (result.error) return { error: result.error.userMessage };
    revalidate();
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

export async function setModifierOptionTemplateDefaultAction(
  id: string,
  isDefault: boolean,
): Promise<{ error: string | null }> {
  try {
    await requirePermission("catalog.manage");
    const ctx = await getStoreContext();
    const result = await setModifierOptionTemplateDefault(id, ctx.storeId, isDefault);
    if (result.error) return { error: result.error.userMessage };
    revalidate();
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

export async function applyModifierGroupTemplateAction(
  productId: string,
  _prev: { error: string | null; message?: string | null },
  formData: FormData,
): Promise<{ error: string | null; message?: string | null }> {
  try {
    await requirePermission("catalog.manage");
    const ctx = await getStoreContext();
    const modifierGroupTemplateIds = Array.from(
      new Set(
        formData
          .getAll("modifierGroupTemplateId")
          .map((value) => (typeof value === "string" ? value.trim() : ""))
          .filter(Boolean),
      ),
    );

    if (modifierGroupTemplateIds.length === 0)
      return { error: "กรุณาเลือกกลุ่มตัวเลือกจากคลัง", message: null };

    const productRes = await getProduct(productId);
    if (!productRes.data || productRes.data.storeId !== ctx.storeId)
      return { error: "ไม่มีสิทธิ์", message: null };

    const existingGroupNames = new Set(
      productRes.data.modifierGroups.map((group) => group.name.trim().toLowerCase()),
    );
    const templates: ModifierGroupTemplate[] = [];

    for (const modifierGroupTemplateId of modifierGroupTemplateIds) {
      const template = await getModifierGroupTemplate(modifierGroupTemplateId);
      if (!template.data || template.data.storeId !== ctx.storeId)
        return { error: "ไม่มีสิทธิ์", message: null };
      if (template.data.options.length === 0)
        return { error: "เพิ่มตัวเลือกในกลุ่มนี้ก่อนนำไปใช้ในเมนู", message: null };

      const normalizedName = template.data.name.trim().toLowerCase();
      if (existingGroupNames.has(normalizedName))
        return { error: "กลุ่มตัวเลือกนี้อยู่ในเมนูแล้ว", message: null };

      existingGroupNames.add(normalizedName);
      templates.push(template.data);
    }

    const createdGroupIds: string[] = [];
    async function rollbackCreatedGroups() {
      for (const groupId of createdGroupIds.toReversed()) {
        const rollbackResult = await deleteModifierGroup(groupId, ctx.storeId);
        if (rollbackResult.error) return rollbackResult.error.userMessage;
      }
      return null;
    }

    for (const template of templates) {
      const groupResult = await createModifierGroup({
        productId,
        name: template.name,
        selectionType: template.selectionType,
        isRequired: template.isRequired,
        minSelections: template.minSelections,
        maxSelections: template.maxSelections,
      });
      if (groupResult.error) {
        const rollbackError = await rollbackCreatedGroups();
        if (rollbackError) {
          return {
            error: `คัดลอกกลุ่มตัวเลือกไม่ครบ และลบกลุ่มที่สร้างไว้ไม่สำเร็จ: ${rollbackError}`,
            message: null,
          };
        }
        return {
          error: isDuplicateModifierGroupError(groupResult.error)
            ? "กลุ่มตัวเลือกนี้อยู่ในเมนูแล้ว"
            : groupResult.error.userMessage,
          message: null,
        };
      }
      if (!groupResult.data) {
        const rollbackError = await rollbackCreatedGroups();
        if (rollbackError) {
          return {
            error: `คัดลอกกลุ่มตัวเลือกไม่ครบ และลบกลุ่มที่สร้างไว้ไม่สำเร็จ: ${rollbackError}`,
            message: null,
          };
        }
        return { error: "สร้างกลุ่มตัวเลือกไม่สำเร็จ", message: null };
      }
      createdGroupIds.push(groupResult.data.id);

      for (const option of template.options) {
        const optionResult = await createModifierOption({
          modifierGroupId: groupResult.data.id,
          name: option.name,
          priceAdjustment: option.priceAdjustment,
          isDefault: option.isDefault,
          sortOrder: option.sortOrder,
        });
        if (optionResult.error) {
          const rollbackError = await rollbackCreatedGroups();
          if (rollbackError) {
            return {
              error: `คัดลอกกลุ่มตัวเลือกไม่ครบ และลบกลุ่มที่สร้างไว้ไม่สำเร็จ: ${rollbackError}`,
              message: null,
            };
          }
          return { error: optionResult.error.userMessage, message: null };
        }
      }
    }

    revalidate();
    await autoSyncDeliveryMenu(ctx.storeId);
    return {
      error: null,
      message:
        templates.length === 1
          ? `เพิ่มกลุ่มตัวเลือก ${templates[0].name} ในเมนูแล้ว`
          : `เพิ่มกลุ่มตัวเลือก ${templates.length} กลุ่มในเมนูแล้ว`,
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด", message: null };
  }
}

export async function addVariantAction(
  productId: string,
  _prev: { error: string | null },
  formData: FormData,
): Promise<{ error: string | null }> {
  try {
    await requirePermission("catalog.manage");
    const ctx = await getStoreContext();
    const name = (formData.get("variantName") as string | null)?.trim() ?? "";
    const priceAdjRaw = formData.get("priceAdjustment") as string | null;
    const priceAdj = priceAdjRaw ? parseFloat(priceAdjRaw) : 0;

    if (!name) return { error: "กรุณาระบุชื่อตัวเลือก" };
    if (isNaN(priceAdj)) return { error: "ราคาปรับไม่ถูกต้อง" };

    const productRes = await getProduct(productId);
    if (!productRes.data || productRes.data.storeId !== ctx.storeId)
      return { error: "ไม่มีสิทธิ์" };

    const result = await createVariant({ productId, name, priceAdjustment: priceAdj });
    if (result.error) return { error: result.error.userMessage };
    revalidate();
    await autoSyncDeliveryMenu(ctx.storeId);
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

export async function deleteVariantAction(id: string): Promise<{ error: string | null }> {
  try {
    await requirePermission("catalog.manage");
    const ctx = await getStoreContext();
    const result = await deleteVariant(id, ctx.storeId);
    if (result.error) return { error: result.error.userMessage };
    revalidate();
    await autoSyncDeliveryMenu(ctx.storeId);
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

// ─── Modifier Groups ─────────────────────────────────────────

export async function addModifierGroupAction(
  productId: string,
  _prev: { error: string | null },
  formData: FormData,
): Promise<{ error: string | null }> {
  try {
    await requirePermission("catalog.manage");
    const ctx = await getStoreContext();
    const name = (formData.get("groupName") as string | null)?.trim() ?? "";
    const selectionType = formData.get("selectionType") as "single" | "multiple";
    const isRequired = formData.get("isRequired") === "on";

    if (!name) return { error: "กรุณาระบุชื่อกลุ่ม" };
    if (selectionType !== "single" && selectionType !== "multiple")
      return { error: "รูปแบบการเลือกไม่ถูกต้อง" };

    const productRes = await getProduct(productId);
    if (!productRes.data || productRes.data.storeId !== ctx.storeId)
      return { error: "ไม่มีสิทธิ์" };

    const result = await createModifierGroup({
      productId,
      name,
      selectionType,
      isRequired,
      maxSelections: selectionType === "single" ? 1 : 10,
    });
    if (result.error) return { error: result.error.userMessage };
    revalidate();
    await autoSyncDeliveryMenu(ctx.storeId);
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

export async function deleteModifierGroupAction(id: string): Promise<{ error: string | null }> {
  try {
    await requirePermission("catalog.manage");
    const ctx = await getStoreContext();
    const result = await deleteModifierGroup(id, ctx.storeId);
    if (result.error) return { error: result.error.userMessage };
    revalidate();
    await autoSyncDeliveryMenu(ctx.storeId);
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

export async function addModifierOptionAction(
  groupId: string,
  _prev: { error: string | null },
  formData: FormData,
): Promise<{ error: string | null }> {
  try {
    await requirePermission("catalog.manage");
    const ctx = await getStoreContext();
    const name = (formData.get("optionName") as string | null)?.trim() ?? "";
    const priceAdjRaw = formData.get("priceAdjustment") as string | null;
    const priceAdj = priceAdjRaw ? parseFloat(priceAdjRaw) : 0;
    const isDefault = formData.get("isDefault") === "on";

    if (!name) return { error: "กรุณาระบุชื่อตัวเลือก" };
    if (isNaN(priceAdj)) return { error: "ราคาปรับไม่ถูกต้อง" };

    const groupStoreId = await getModifierGroupStoreId(groupId);
    if (groupStoreId !== ctx.storeId) return { error: "ไม่มีสิทธิ์" };

    const result = await createModifierOption({
      modifierGroupId: groupId,
      name,
      priceAdjustment: priceAdj,
      isDefault,
    });
    if (result.error) return { error: result.error.userMessage };
    revalidate();
    await autoSyncDeliveryMenu(ctx.storeId);
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

export async function deleteModifierOptionAction(id: string): Promise<{ error: string | null }> {
  try {
    await requirePermission("catalog.manage");
    const ctx = await getStoreContext();
    const result = await deleteModifierOption(id, ctx.storeId);
    if (result.error) return { error: result.error.userMessage };
    revalidate();
    await autoSyncDeliveryMenu(ctx.storeId);
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

export async function setModifierOptionDefaultAction(
  id: string,
  isDefault: boolean,
): Promise<{ error: string | null }> {
  try {
    await requirePermission("catalog.manage");
    const ctx = await getStoreContext();
    const result = await setModifierOptionDefault(id, ctx.storeId, isDefault);
    if (result.error) return { error: result.error.userMessage };
    revalidate();
    await autoSyncDeliveryMenu(ctx.storeId);
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}
