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
  createVariant,
  deleteVariant,
  createModifierGroup,
  deleteModifierGroup,
  createModifierOption,
  deleteModifierOption,
  getProduct,
  getModifierGroupStoreId,
} from "@/modules/catalog/repository";

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
