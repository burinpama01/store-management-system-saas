"use server";

import { revalidatePath } from "next/cache";
import { AuthorizationError, requireSystemAccess } from "@/modules/auth/guards";
import { isPaidTier, type BillingDuration, type PaidTier } from "@/modules/billing/pricing";
import {
  updateBillingPrice,
  updateBusinessPrice,
  createPromotion,
  setPromotionActive,
  updatePlanSettings,
  createDiscountCode,
  setDiscountCodeActive,
  type PlanTier,
} from "@/modules/billing/pricing-repository";
import { isBusinessComponent } from "@/modules/billing/business-plan";
import { isDiscountablePlan, normalizeDiscountCode } from "@/modules/billing/discount-code";

const VALID_TIERS: PlanTier[] = ["starter", "standard", "premium", "business", "enterprise"];

export interface PricingState {
  error: string | null;
  ok: boolean;
}

async function guard(): Promise<{ error: string } | null> {
  try {
    await requireSystemAccess();
    return null;
  } catch (e) {
    if (e instanceof AuthorizationError) return { error: "ต้องเป็นผู้ดูแลแพลตฟอร์ม" };
    throw e;
  }
}

export async function updatePriceAction(_prev: PricingState, fd: FormData): Promise<PricingState> {
  const g = await guard();
  if (g) return { ok: false, error: g.error };

  const tier = fd.get("tier") as string;
  const duration = fd.get("duration") as string;
  const amount = Number(fd.get("amount"));
  if (!isPaidTier(tier)) return { ok: false, error: "tier ไม่ถูกต้อง" };
  if (duration !== "30d" && duration !== "1y") return { ok: false, error: "duration ไม่ถูกต้อง" };
  if (!Number.isFinite(amount) || amount < 0) return { ok: false, error: "ราคาไม่ถูกต้อง" };

  const res = await updateBillingPrice(tier as PaidTier, duration as BillingDuration, amount);
  if (!res.ok) return { ok: false, error: res.error?.userMessage ?? "บันทึกไม่สำเร็จ" };
  revalidatePath("/system/pricing");
  return { ok: true, error: null };
}

export async function updateBusinessPriceAction(_prev: PricingState, fd: FormData): Promise<PricingState> {
  const g = await guard();
  if (g) return { ok: false, error: g.error };

  const component = (fd.get("component") as string | null) ?? "";
  const duration = fd.get("duration") as string;
  const amount = Number(fd.get("amount"));
  if (!isBusinessComponent(component)) return { ok: false, error: "component ไม่ถูกต้อง" };
  if (duration !== "30d" && duration !== "1y") return { ok: false, error: "duration ไม่ถูกต้อง" };
  if (!Number.isFinite(amount) || amount < 0) return { ok: false, error: "ราคาไม่ถูกต้อง" };

  const res = await updateBusinessPrice(component, duration as BillingDuration, amount);
  if (!res.ok) return { ok: false, error: res.error?.userMessage ?? "บันทึกไม่สำเร็จ" };
  revalidatePath("/system/pricing");
  revalidatePath("/pricing");
  return { ok: true, error: null };
}

export async function createPromotionAction(_prev: PricingState, fd: FormData): Promise<PricingState> {
  const g = await guard();
  if (g) return { ok: false, error: g.error };

  const description = ((fd.get("description") as string | null) ?? "").trim();
  const percentOff = Number(fd.get("percentOff"));
  const planRaw = (fd.get("plan") as string | null) ?? "";
  const plan = isDiscountablePlan(planRaw) ? planRaw : null; // "" -> all plans
  const startsAt = ((fd.get("startsAt") as string | null) ?? "").trim() || null;
  const endsAt = ((fd.get("endsAt") as string | null) ?? "").trim() || null;
  if (!description) return { ok: false, error: "กรุณากรอกคำอธิบายโปรโมชั่น" };
  if (!Number.isInteger(percentOff) || percentOff < 1 || percentOff > 90) {
    return { ok: false, error: "ส่วนลดต้องเป็น 1–90%" };
  }

  const res = await createPromotion({
    description,
    percentOff,
    plan,
    startsAt: startsAt ? new Date(startsAt).toISOString() : null,
    endsAt: endsAt ? new Date(endsAt).toISOString() : null,
  });
  if (!res.ok) return { ok: false, error: res.error?.userMessage ?? "สร้างโปรโมชั่นไม่สำเร็จ" };
  revalidatePath("/system/pricing");
  return { ok: true, error: null };
}

export async function updatePlanSettingsAction(_prev: PricingState, fd: FormData): Promise<PricingState> {
  const g = await guard();
  if (g) return { ok: false, error: g.error };

  const tier = (fd.get("tier") as string | null) ?? "";
  if (!VALID_TIERS.includes(tier as PlanTier)) return { ok: false, error: "tier ไม่ถูกต้อง" };
  const displayName = ((fd.get("displayName") as string | null) ?? "").trim();
  if (!displayName) return { ok: false, error: "กรุณากรอกชื่อแพ็กเกจ" };
  const visibleOnLanding = fd.get("visibleOnLanding") === "1";
  const highlight = fd.get("highlight") === "1";
  const featureLines = ((fd.get("featureLines") as string | null) ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 12);

  const res = await updatePlanSettings(tier as PlanTier, {
    displayName,
    visibleOnLanding,
    highlight,
    featureLines,
  });
  if (!res.ok) return { ok: false, error: res.error?.userMessage ?? "บันทึกไม่สำเร็จ" };
  revalidatePath("/system/pricing");
  revalidatePath("/pricing");
  revalidatePath("/");
  return { ok: true, error: null };
}

export async function togglePromotionAction(fd: FormData): Promise<void> {
  const g = await guard();
  if (g) return;
  const id = fd.get("id") as string;
  const active = fd.get("active") === "1";
  if (!id) return;
  await setPromotionActive(id, active);
  revalidatePath("/system/pricing");
}

function parseOptionalPositiveInt(value: FormDataEntryValue | null): number | null {
  const raw = ((value as string | null) ?? "").trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function createDiscountCodeAction(_prev: PricingState, fd: FormData): Promise<PricingState> {
  const g = await guard();
  if (g) return { ok: false, error: g.error };

  const code = normalizeDiscountCode((fd.get("code") as string | null) ?? "");
  const description = ((fd.get("description") as string | null) ?? "").trim();
  const discountType = (fd.get("discountType") as string | null) ?? "";
  const discountValue = Number(fd.get("discountValue"));
  const planRaw = (fd.get("plan") as string | null) ?? "";
  const plan = isDiscountablePlan(planRaw) ? planRaw : null; // "" -> all plans
  const durationRaw = (fd.get("duration") as string | null) ?? "";
  const duration = durationRaw === "30d" || durationRaw === "1y" ? durationRaw : null; // "" -> all
  const minAmount = Number(fd.get("minAmount") || 0);
  const maxRedemptions = parseOptionalPositiveInt(fd.get("maxRedemptions"));
  const maxRedemptionsPerOrg = parseOptionalPositiveInt(fd.get("maxRedemptionsPerOrg"));
  const startsAt = ((fd.get("startsAt") as string | null) ?? "").trim() || null;
  const endsAt = ((fd.get("endsAt") as string | null) ?? "").trim() || null;

  if (!code) return { ok: false, error: "กรุณากรอกโค้ดส่วนลด" };
  if (!description) return { ok: false, error: "กรุณากรอกคำอธิบาย" };
  if (discountType !== "percentage" && discountType !== "fixed") {
    return { ok: false, error: "ประเภทส่วนลดไม่ถูกต้อง" };
  }
  if (!Number.isFinite(discountValue) || discountValue <= 0) {
    return { ok: false, error: "มูลค่าส่วนลดต้องมากกว่า 0" };
  }
  if (discountType === "percentage" && discountValue > 100) {
    return { ok: false, error: "ส่วนลดแบบ % ต้องไม่เกิน 100" };
  }
  if (!Number.isFinite(minAmount) || minAmount < 0) {
    return { ok: false, error: "ยอดขั้นต่ำไม่ถูกต้อง" };
  }

  const res = await createDiscountCode({
    code,
    description,
    discountType,
    discountValue,
    plan,
    duration,
    minAmount,
    maxRedemptions,
    maxRedemptionsPerOrg,
    startsAt: startsAt ? new Date(startsAt).toISOString() : null,
    endsAt: endsAt ? new Date(endsAt).toISOString() : null,
  });
  if (!res.ok) return { ok: false, error: res.error?.userMessage ?? "สร้างโค้ดส่วนลดไม่สำเร็จ" };
  revalidatePath("/system/pricing");
  return { ok: true, error: null };
}

export async function toggleDiscountCodeAction(fd: FormData): Promise<void> {
  const g = await guard();
  if (g) return;
  const id = fd.get("id") as string;
  const active = fd.get("active") === "1";
  if (!id) return;
  await setDiscountCodeActive(id, active);
  revalidatePath("/system/pricing");
}
