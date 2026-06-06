"use server";

import { revalidatePath } from "next/cache";
import { AuthorizationError, requireSystemAccess } from "@/modules/auth/guards";
import { isPaidTier, type BillingDuration, type PaidTier } from "@/modules/billing/pricing";
import {
  updateBillingPrice,
  createPromotion,
  setPromotionActive,
} from "@/modules/billing/pricing-repository";

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

export async function createPromotionAction(_prev: PricingState, fd: FormData): Promise<PricingState> {
  const g = await guard();
  if (g) return { ok: false, error: g.error };

  const description = ((fd.get("description") as string | null) ?? "").trim();
  const percentOff = Number(fd.get("percentOff"));
  const startsAt = ((fd.get("startsAt") as string | null) ?? "").trim() || null;
  const endsAt = ((fd.get("endsAt") as string | null) ?? "").trim() || null;
  if (!description) return { ok: false, error: "กรุณากรอกคำอธิบายโปรโมชั่น" };
  if (!Number.isInteger(percentOff) || percentOff < 1 || percentOff > 90) {
    return { ok: false, error: "ส่วนลดต้องเป็น 1–90%" };
  }

  const res = await createPromotion({
    description,
    percentOff,
    startsAt: startsAt ? new Date(startsAt).toISOString() : null,
    endsAt: endsAt ? new Date(endsAt).toISOString() : null,
  });
  if (!res.ok) return { ok: false, error: res.error?.userMessage ?? "สร้างโปรโมชั่นไม่สำเร็จ" };
  revalidatePath("/system/pricing");
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
