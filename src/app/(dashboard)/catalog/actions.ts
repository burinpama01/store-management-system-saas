"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/modules/auth/guards";
import { getCurrentUser, getUserStores, resolveCurrentStore } from "@/modules/auth/session";
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
  createVariant,
  deleteVariant,
  createModifierGroup,
  deleteModifierGroup,
  createModifierOption,
  deleteModifierOption,
  getProduct,
  getModifierGroupStoreId,
} from "@/modules/catalog/repository";
import type { ModifierGroupTemplate } from "@/modules/catalog/types";

async function getStoreContext() {
  const user = await getCurrentUser();
  if (!user) throw new Error("ไม่มีสิทธิ์เข้าถึง");
  const { organizations, stores, memberships } = await getUserStores();
  const ctx = await resolveCurrentStore(stores, organizations, memberships);
  if (!ctx) throw new Error("ไม่พบข้อมูลร้านค้า");
  return ctx;
}

function revalidate() {
  revalidatePath("/catalog", "page");
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

    const result = await createProduct({
      storeId: ctx.storeId,
      organizationId: ctx.organizationId,
      categoryId,
      name,
      description: (formData.get("description") as string | null)?.trim() || undefined,
      imageUrl: imageUrl.value,
      basePrice,
      availableForPos: formData.get("availableForPos") === "on",
      availableForQr: formData.get("availableForQr") === "on",
    });
    if (result.error) return { error: result.error.userMessage };
    revalidate();
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

    const result = await updateProduct(id, ctx.storeId, {
      name,
      categoryId,
      description: (formData.get("description") as string | null)?.trim() || undefined,
      imageUrl: imageUrl.value,
      basePrice,
      availableForPos: formData.get("availableForPos") === "on",
      availableForQr: formData.get("availableForQr") === "on",
      isActive: formData.get("isActive") !== "off",
    });
    if (result.error) return { error: result.error.userMessage };
    revalidate();
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

    if (!name) return { error: "กรุณาระบุชื่อตัวเลือก" };
    if (isNaN(priceAdj)) return { error: "ราคาปรับไม่ถูกต้อง" };

    const groupStoreId = await getModifierGroupStoreId(groupId);
    if (groupStoreId !== ctx.storeId) return { error: "ไม่มีสิทธิ์" };

    const result = await createModifierOption({
      modifierGroupId: groupId,
      name,
      priceAdjustment: priceAdj,
    });
    if (result.error) return { error: result.error.userMessage };
    revalidate();
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
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}
