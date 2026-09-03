"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import QRCode from "qrcode";
import { requireFeature, requirePermission } from "@/modules/auth/guards";
import { getCurrentUser, getUserStores, resolveCurrentStore } from "@/modules/auth/session";
import { generateMemberPortalLink } from "@/modules/customers/member-repository";
import { deleteCustomer, saveCustomer } from "@/modules/customers/repository";
import { normalizePriceTier } from "@/modules/pos/pricing";
import { listProducts } from "@/modules/catalog/repository";
import { deleteCoupon, saveCoupon } from "@/modules/promotions/repository";
import {
  adjustCustomerPoints,
  deleteLoyaltyReward,
  saveLoyaltyReward,
  saveLoyaltySettings,
} from "@/modules/loyalty/repository";
import type { CouponDiscountType } from "@/modules/promotions/types";
import { createSupabaseServerClient } from "@/server/integrations/supabase/server";
import { storeDateTimeToUtc } from "@/shared/utils/datetime";
import { parsePointsDeltaInput } from "@/modules/loyalty/points-input";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ActionResult = { error: string | null };
type MemberPortalQrActionResult = ActionResult & {
  memberPortalUrl: string | null;
  memberPortalQrDataUrl: string | null;
};

async function getStoreContext() {
  const user = await getCurrentUser();
  if (!user) throw new Error("ไม่มีสิทธิ์เข้าถึง");
  const { organizations, stores, memberships } = await getUserStores();
  const ctx = await resolveCurrentStore(stores, organizations, memberships);
  if (!ctx) throw new Error("ไม่พบร้านค้าที่ใช้งาน");
  return ctx;
}

function revalidateCustomers() {
  revalidatePath("/customers", "page");
  revalidatePath("/pos", "page");
}

function text(formData: FormData, key: string) {
  return String(formData.get(key) ?? "").trim();
}

function optionalNumber(formData: FormData, key: string) {
  if (!formData.has(key)) return undefined;
  const value = text(formData, key);
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

// datetime-local inputs carry no timezone; interpret them as store-local wall time, not UTC.
function optionalDateTime(formData: FormData, key: string, timeZone: string) {
  if (!formData.has(key)) return undefined;
  const value = text(formData, key);
  if (!value) return null;
  return storeDateTimeToUtc(value, timeZone);
}

export async function saveCustomerAction(formData: FormData): Promise<ActionResult> {
  try {
    await requirePermission("pos.use");
    await requireFeature("loyaltyPoints");
    const ctx = await getStoreContext();
    const id = text(formData, "id");
    const name = text(formData, "name");
    const phone = text(formData, "phone");
    const email = text(formData, "email");

    if (id && !UUID_RE.test(id)) return { error: "ข้อมูลลูกค้าไม่ถูกต้อง" };
    if (!name) return { error: "กรุณาระบุชื่อลูกค้า" };
    if (name.length > 120) return { error: "ชื่อลูกค้ายาวเกินไป" };
    if (email && !email.includes("@")) return { error: "อีเมลไม่ถูกต้อง" };

    const result = await saveCustomer({
      id: id || null,
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      name,
      phone,
      email,
      priceTier: normalizePriceTier(text(formData, "priceTier")),
      isActive: formData.get("isActive") === "on",
    });
    if (result.error) return { error: result.error.userMessage };
    revalidateCustomers();
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

export async function deleteCustomerAction(id: string): Promise<ActionResult> {
  try {
    await requirePermission("pos.use");
    await requireFeature("loyaltyPoints");
    const ctx = await getStoreContext();
    if (!UUID_RE.test(id)) return { error: "ข้อมูลลูกค้าไม่ถูกต้อง" };
    const result = await deleteCustomer(id, ctx.storeId);
    if (result.error) return { error: result.error.userMessage };
    revalidateCustomers();
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

export async function saveCouponAction(formData: FormData): Promise<ActionResult> {
  try {
    await requirePermission("catalog.manage");
    await requireFeature("couponManagement");
    const ctx = await getStoreContext();
    const id = text(formData, "id");
    const code = text(formData, "code").toUpperCase();
    const name = text(formData, "name");
    const discountType = text(formData, "discountType") as CouponDiscountType;
    const discountValue = Number(text(formData, "discountValue"));
    const minSubtotal = optionalNumber(formData, "minSubtotal");
    const maxRedemptions = optionalNumber(formData, "maxRedemptions");
    const maxRedemptionsPerCustomer = optionalNumber(formData, "maxRedemptionsPerCustomer");

    if (id && !UUID_RE.test(id)) return { error: "ข้อมูลคูปองไม่ถูกต้อง" };
    if (!code) return { error: "กรุณาระบุรหัสคูปอง" };
    if (!name) return { error: "กรุณาระบุชื่อคูปอง" };
    if (discountType !== "amount" && discountType !== "percentage") return { error: "ชนิดส่วนลดไม่ถูกต้อง" };
    if (!Number.isFinite(discountValue) || discountValue <= 0) return { error: "มูลค่าส่วนลดไม่ถูกต้อง" };
    if (discountType === "percentage" && discountValue > 100) return { error: "เปอร์เซ็นต์ส่วนลดต้องไม่เกิน 100" };
    for (const value of [minSubtotal, maxRedemptions, maxRedemptionsPerCustomer]) {
      if (Number.isNaN(value)) return { error: "ตัวเลขคูปองไม่ถูกต้อง" };
    }
    if (minSubtotal !== undefined && minSubtotal !== null && minSubtotal < 0) {
      return { error: "ยอดขั้นต่ำคูปองไม่ถูกต้อง" };
    }
    for (const value of [maxRedemptions, maxRedemptionsPerCustomer]) {
      if (value !== undefined && value !== null && (!Number.isInteger(value) || value <= 0)) {
        return { error: "จำนวนครั้งที่ใช้คูปองไม่ถูกต้อง" };
      }
    }

    const result = await saveCoupon({
      id: id || null,
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      code,
      name,
      discountType,
      discountValue,
      minSubtotal: minSubtotal === null ? 0 : minSubtotal,
      startsAt: optionalDateTime(formData, "startsAt", ctx.storeTimezone),
      endsAt: optionalDateTime(formData, "endsAt", ctx.storeTimezone),
      maxRedemptions,
      maxRedemptionsPerCustomer,
      stackableWithManualDiscount: formData.get("stackableWithManualDiscount") === "on",
      isActive: formData.get("isActive") === "on",
    });
    if (result.error) return { error: result.error.userMessage };
    revalidateCustomers();
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

export async function deleteCouponAction(id: string): Promise<ActionResult> {
  try {
    await requirePermission("catalog.manage");
    await requireFeature("couponManagement");
    const ctx = await getStoreContext();
    if (!UUID_RE.test(id)) return { error: "ข้อมูลคูปองไม่ถูกต้อง" };
    const result = await deleteCoupon(id, ctx.storeId);
    if (result.error) return { error: result.error.userMessage };
    revalidateCustomers();
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

export async function saveLoyaltySettingsAction(formData: FormData): Promise<ActionResult> {
  try {
    await requirePermission("settings.manage_store");
    await requireFeature("loyaltyPoints");
    const ctx = await getStoreContext();
    const pointsPerCurrency = Number(text(formData, "pointsPerCurrency"));
    if (!Number.isFinite(pointsPerCurrency) || pointsPerCurrency <= 0 || pointsPerCurrency > 10) {
      return { error: "อัตราแต้มไม่ถูกต้อง" };
    }

    const result = await saveLoyaltySettings({
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      pointsPerCurrency,
      earnEnabled: formData.get("earnEnabled") === "on",
      redeemEnabled: formData.get("redeemEnabled") === "on",
    });
    if (result.error) return { error: result.error.userMessage };
    revalidateCustomers();
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

export async function adjustCustomerPointsAction(formData: FormData): Promise<ActionResult> {
  try {
    await requirePermission("settings.manage_store");
    await requireFeature("loyaltyPoints");
    const ctx = await getStoreContext();
    const customerId = text(formData, "customerId");
    // แต้มเป็น numeric(12,2) และฟอร์มใส่ step 0.01 จึงต้องรับทศนิยม (ดู points-input.ts)
    const pointsDelta = parsePointsDeltaInput(text(formData, "pointsDelta"));
    const reason = text(formData, "reason");

    if (!UUID_RE.test(customerId)) return { error: "ข้อมูลลูกค้าไม่ถูกต้อง" };
    if (pointsDelta === null) {
      return { error: "จำนวนแต้มที่ปรับไม่ถูกต้อง" };
    }

    const result = await adjustCustomerPoints({
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      customerId,
      pointsDelta,
      reason,
    });
    if (result.error) return { error: result.error.userMessage };
    revalidateCustomers();
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

export async function saveRewardAction(formData: FormData): Promise<ActionResult> {
  try {
    await requirePermission("settings.manage_store");
    await requireFeature("loyaltyPoints");
    const ctx = await getStoreContext();
    const id = text(formData, "id");
    const name = text(formData, "name");
    const description = text(formData, "description");
    const pointsCost = Number(text(formData, "pointsCost"));
    const stockValue = text(formData, "stockQuantity");
    const stockQuantity = stockValue ? Number(stockValue) : null;
    const rewardType = text(formData, "rewardType") === "discount" ? "discount" : "product";
    const discountKind = text(formData, "discountKind") === "percentage" ? "percentage" : "amount";
    const discountValue = Number(text(formData, "discountValue"));
    const rewardProductId = text(formData, "rewardProductId");
    const imageUrl = text(formData, "imageUrl");
    const codeMode = text(formData, "codeMode") === "manual" ? "manual" : "auto";
    const manualCode = text(formData, "manualCode");

    if (id && !UUID_RE.test(id)) return { error: "ข้อมูลของรางวัลไม่ถูกต้อง" };
    if (!name) return { error: "กรุณาระบุชื่อของรางวัล" };
    if (name.length > 120) return { error: "ชื่อของรางวัลยาวเกินไป" };
    if (!Number.isInteger(pointsCost) || pointsCost <= 0 || pointsCost > 1000000) {
      return { error: "แต้มที่ใช้แลกไม่ถูกต้อง" };
    }
    if (stockQuantity !== null && (!Number.isInteger(stockQuantity) || stockQuantity < 0)) {
      return { error: "จำนวนสต็อกของรางวัลไม่ถูกต้อง" };
    }
    if (imageUrl && imageUrl.length > 500) return { error: "ลิงก์รูปยาวเกินไป" };

    if (rewardType === "discount") {
      if (!Number.isFinite(discountValue) || discountValue <= 0) {
        return { error: "กรุณาระบุมูลค่าส่วนลดของรางวัล" };
      }
      if (discountKind === "percentage" && discountValue > 100) {
        return { error: "เปอร์เซ็นต์ส่วนลดต้องไม่เกิน 100" };
      }
    } else {
      if (!UUID_RE.test(rewardProductId)) {
        return { error: "กรุณาเลือกสินค้าในระบบสำหรับของรางวัลแบบสินค้า" };
      }
      const productsRes = await listProducts(ctx.storeId, { includeInactive: false });
      if (productsRes.error || !productsRes.data) {
        return { error: productsRes.error?.userMessage ?? "ไม่สามารถตรวจสอบสินค้าได้" };
      }
      const product = productsRes.data.find((candidate) => candidate.id === rewardProductId);
      if (!product) return { error: "ไม่พบสินค้าที่เลือกในระบบ" };
      if (product.variants.length > 0) {
        return { error: "สินค้าของรางวัลต้องไม่มีตัวเลือก (variant) เพื่อให้ตัดสต็อกถูกต้อง" };
      }
    }

    if (codeMode === "manual") {
      const cleaned = manualCode.replace(/\s+/g, "");
      if (cleaned.length < 3 || cleaned.length > 24) {
        return { error: "รหัสที่กำหนดเองต้องยาว 3–24 ตัวอักษร" };
      }
      if (!/^[A-Za-z0-9_-]+$/.test(cleaned)) {
        return { error: "รหัสที่กำหนดเองใช้ได้เฉพาะ A-Z 0-9 - _" };
      }
    }

    const result = await saveLoyaltyReward({
      id: id || null,
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      name,
      description,
      pointsCost,
      stockQuantity,
      rewardType,
      discountKind: rewardType === "discount" ? discountKind : null,
      discountValue: rewardType === "discount" ? discountValue : null,
      rewardProductId: rewardType === "product" ? rewardProductId : null,
      imageUrl,
      codeMode,
      manualCode: codeMode === "manual" ? manualCode : null,
      isActive: formData.get("isActive") === "on",
    });
    if (result.error) return { error: result.error.userMessage };
    revalidateCustomers();
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

export async function deleteRewardAction(id: string): Promise<ActionResult> {
  try {
    await requirePermission("settings.manage_store");
    await requireFeature("loyaltyPoints");
    const ctx = await getStoreContext();
    if (!UUID_RE.test(id)) return { error: "ข้อมูลของรางวัลไม่ถูกต้อง" };
    const result = await deleteLoyaltyReward(id, ctx.storeId);
    if (result.error) return { error: result.error.userMessage };
    revalidateCustomers();
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

export async function generateMemberPortalQrAction(): Promise<MemberPortalQrActionResult> {
  try {
    await requirePermission("settings.manage_store");
    await requireFeature("loyaltyPoints");
    const ctx = await getStoreContext();
    const origin = (await headers()).get("origin") ?? "";
    const supabase = await createSupabaseServerClient();
    const storeRes = await supabase.from("stores").select("slug").eq("id", ctx.storeId).maybeSingle();
    if (storeRes.error) return { error: storeRes.error.message, memberPortalUrl: null, memberPortalQrDataUrl: null };
    const storeSlug = storeRes.data?.slug ?? null;
    if (!origin || !storeSlug) {
      return { error: "ไม่พบข้อมูลร้านสำหรับสร้าง QR", memberPortalUrl: null, memberPortalQrDataUrl: null };
    }

    const result = await generateMemberPortalLink({
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      label: "QR สมัครสมาชิก",
    });
    if (result.error) return { error: result.error.userMessage, memberPortalUrl: null, memberPortalQrDataUrl: null };
    const memberPortalUrl = `${origin}/member/${storeSlug}?code=${encodeURIComponent(result.data.token)}`;
    const memberPortalQrDataUrl = await QRCode.toDataURL(memberPortalUrl, {
      width: 220,
      margin: 1,
      errorCorrectionLevel: "M",
    }).catch(() => null);
    revalidateCustomers();
    return { error: null, memberPortalUrl, memberPortalQrDataUrl };
  } catch (e) {
    return {
      error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด",
      memberPortalUrl: null,
      memberPortalQrDataUrl: null,
    };
  }
}
