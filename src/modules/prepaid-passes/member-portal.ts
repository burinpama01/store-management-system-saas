import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import { createBeamQrPayment, isBeamReadyForStore, refreshBeamPayment, cancelBeamQrPayment } from "@/modules/payments/beam-service";
import type { BeamQrForPos } from "@/modules/payments/types";
import type { PassRedeemScope } from "./rules";

// ตาราง/คอลัมน์ใหม่ยังไม่อยู่ใน database.types (แบบเดียวกับ repository.ts)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LooseClient = any;

/** แพ็กในหน้าสมาชิก — รวมแพ็กที่ใช้หมด/หมดอายุล่าสุดด้วยเพื่อให้ลูกค้าเห็นประวัติ */
export interface MemberPortalPass {
  id: string;
  planName: string;
  creditsTotal: number;
  creditsRemaining: number;
  expiresAt: string | null;
  status: "active" | "voided" | "expired";
  redeemScope: PassRedeemScope;
  purchasedAt: string;
}

export interface MemberPortalPlan {
  id: string;
  name: string;
  credits: number;
  price: number;
  validDays: number | null;
  redeemScope: PassRedeemScope;
  terms: string;
}

export interface MemberPassesView {
  passes: MemberPortalPass[];
  plans: MemberPortalPlan[];
  /** ร้านเปิด Beam = ซื้อออนไลน์ได้ (ไม่มี Beam = ซื้อที่ร้านเท่านั้น) */
  canBuyOnline: boolean;
}

type Result<T> = { data: T; error: null } | { data: null; error: string };

/* eslint-disable @typescript-eslint/no-explicit-any -- แถวดิบจาก PostgREST */
async function identityOf(db: LooseClient, storeId: string, customerId: string): Promise<string | null> {
  const { data } = await db
    .from("customers")
    .select("member_identity_id")
    .eq("id", customerId)
    .eq("store_id", storeId)
    .eq("is_active", true)
    .maybeSingle();
  return data?.member_identity_id ?? null;
}

export async function getMemberPassesView(input: {
  storeId: string;
  customerId: string;
  /** Enterprise ใช้งานอยู่ — ขายแพ็กใหม่ได้เฉพาะตอนนี้ */
  canSell: boolean;
}): Promise<MemberPassesView> {
  const db: LooseClient = await createSupabaseServiceClient();
  const identity = await identityOf(db, input.storeId, input.customerId);
  const empty: MemberPassesView = { passes: [], plans: [], canBuyOnline: false };
  if (!identity) return empty;

  const passColumns = "id, plan_name, credits_total, credits_remaining, expires_at, status, redeem_scope, created_at";
  // แพ็กที่ยังใช้ได้ต้องแสดงครบเสมอ — แยกจากประวัติ ไม่ให้แพ็กเก่าที่ยังเหลือสิทธิ์หลุด limit
  const [activeRes, historyRes, plansRes, beamReady] = await Promise.all([
    db
      .from("prepaid_passes")
      .select(passColumns)
      .eq("member_identity_id", identity)
      .eq("status", "active")
      .gt("credits_remaining", 0)
      .order("created_at", { ascending: true })
      .limit(200),
    db
      .from("prepaid_passes")
      .select(passColumns)
      .eq("member_identity_id", identity)
      .or("status.neq.active,credits_remaining.eq.0")
      .order("created_at", { ascending: false })
      .limit(10),
    input.canSell
      ? db
          .from("prepaid_pass_plans")
          .select("id, name, credits, price, valid_days, redeem_scope, terms")
          .eq("store_id", input.storeId)
          .eq("is_active", true)
          .order("price", { ascending: true })
      : Promise.resolve({ data: [] }),
    input.canSell ? isBeamReadyForStore(input.storeId, db) : Promise.resolve(false),
  ]);

  return {
    passes: [...(activeRes.data ?? []), ...(historyRes.data ?? [])].map((row: any) => ({
      id: row.id,
      planName: row.plan_name,
      creditsTotal: row.credits_total,
      creditsRemaining: row.credits_remaining,
      expiresAt: row.expires_at ?? null,
      status: row.status,
      redeemScope: row.redeem_scope,
      purchasedAt: row.created_at,
    })),
    plans: (plansRes.data ?? []).map((row: any) => ({
      id: row.id,
      name: row.name,
      credits: row.credits,
      price: Number(row.price),
      validDays: row.valid_days ?? null,
      redeemScope: row.redeem_scope,
      terms: row.terms,
    })),
    canBuyOnline: Boolean(beamReady),
  };
}

/**
 * เริ่มซื้อแพ็กออนไลน์: ลูกค้าติ๊กยอมรับเงื่อนไขแล้วเท่านั้น → คำสั่งซื้อ (snapshot) → Beam QR
 * เงินเข้าแล้ว trigger ในฐานข้อมูลออกแพ็กให้เอง (จุดเดียวทั้ง webhook และ lookup)
 */
export async function startPassPurchase(input: {
  organizationId: string;
  storeId: string;
  customerId: string;
  planId: string;
  termsAccepted: boolean;
}): Promise<Result<{ purchaseId: string; qr: BeamQrForPos; planName: string }>> {
  if (!input.termsAccepted) return { data: null, error: "กรุณาอ่านและติ๊กยอมรับเงื่อนไขก่อนซื้อ" };
  const db: LooseClient = await createSupabaseServiceClient();
  const identity = await identityOf(db, input.storeId, input.customerId);
  if (!identity) return { data: null, error: "บัญชีสมาชิกต้องมีเบอร์โทรก่อนซื้อแพ็ก" };

  const { data: plan } = await db
    .from("prepaid_pass_plans")
    .select("id, name, credits, price, valid_days, redeem_scope, terms, is_active")
    .eq("id", input.planId)
    .eq("store_id", input.storeId)
    .maybeSingle();
  if (!plan || !plan.is_active) return { data: null, error: "แพ็กนี้ปิดขายแล้ว" };
  if (!(await isBeamReadyForStore(input.storeId, db))) {
    return { data: null, error: "ร้านยังไม่เปิดชำระออนไลน์ — ซื้อแพ็กที่เคาน์เตอร์ได้" };
  }

  const { data: purchase, error: insertError } = await db
    .from("prepaid_pass_purchases")
    .insert({
      organization_id: input.organizationId,
      store_id: input.storeId,
      plan_id: plan.id,
      member_identity_id: identity,
      customer_id: input.customerId,
      plan_name: plan.name,
      credits: plan.credits,
      amount: Number(plan.price),
      valid_days: plan.valid_days,
      redeem_scope: plan.redeem_scope,
      terms_snapshot: plan.terms,
    })
    .select("id")
    .single();
  if (insertError || !purchase) return { data: null, error: "สร้างคำสั่งซื้อไม่สำเร็จ กรุณาลองใหม่" };

  const created = await createBeamQrPayment({
    organizationId: input.organizationId,
    storeId: input.storeId,
    amountMajor: Number(plan.price),
    clientRequestId: `pass-${purchase.id}`,
    actorUserId: null,
    prepaidPassPurchaseId: purchase.id,
    client: db,
  });
  if (!created.ok) {
    await db.from("prepaid_pass_purchases").update({ status: "cancelled", updated_at: new Date().toISOString() }).eq("id", purchase.id);
    return { data: null, error: created.error };
  }
  return { data: { purchaseId: purchase.id, qr: created.qr, planName: plan.name }, error: null };
}

async function purchaseWithPayment(db: LooseClient, storeId: string, customerId: string, purchaseId: string) {
  const { data: purchase } = await db
    .from("prepaid_pass_purchases")
    .select("id, status, organization_id")
    .eq("id", purchaseId)
    .eq("store_id", storeId)
    .eq("customer_id", customerId)
    .maybeSingle();
  if (!purchase) return null;
  const { data: payment } = await db
    .from("gateway_payments")
    .select("id, status")
    .eq("prepaid_pass_purchase_id", purchaseId)
    .eq("store_id", storeId)
    .maybeSingle();
  return { purchase, payment: payment as { id: string; status: string } | null };
}

/** ถามสถานะการจ่าย — ยิง Beam API ไม่ถี่กว่า 10 วินาที (webhook คือทางหลัก) */
export async function checkPassPurchase(input: {
  storeId: string;
  customerId: string;
  purchaseId: string;
}): Promise<{ status: "pending" | "paid" | "failed" | "review"; error: string | null }> {
  const db: LooseClient = await createSupabaseServiceClient();
  const found = await purchaseWithPayment(db, input.storeId, input.customerId, input.purchaseId);
  if (!found) return { status: "failed", error: "ไม่พบคำสั่งซื้อ" };
  if (found.purchase.status === "paid") return { status: "paid", error: null };
  if (!found.payment) return { status: "failed", error: "ไม่พบรายการชำระ" };

  const refreshed = await refreshBeamPayment({
    storeId: input.storeId,
    gatewayPaymentId: found.payment.id,
    client: db,
    minLookupIntervalMs: 10_000,
  });
  const after = await purchaseWithPayment(db, input.storeId, input.customerId, input.purchaseId);
  if (after?.purchase.status === "paid") return { status: "paid", error: null };
  const status = refreshed.ok ? refreshed.status : after?.payment?.status ?? null;
  if (status === "REVIEW_REQUIRED" || status === "LATE_PAID") {
    return { status: "review", error: "ได้รับเงินแล้ว แต่ร้านต้องตรวจสอบก่อน — แจ้งพนักงาน" };
  }
  if (status === "FAILED" || status === "EXPIRED" || status === "CANCELLED") {
    return { status: "failed", error: "QR หมดอายุหรือถูกยกเลิก — กดซื้อใหม่ได้" };
  }
  return { status: "pending", error: null };
}

export async function cancelPassPurchase(input: {
  storeId: string;
  customerId: string;
  purchaseId: string;
}): Promise<{ error: string | null }> {
  const db: LooseClient = await createSupabaseServiceClient();
  const found = await purchaseWithPayment(db, input.storeId, input.customerId, input.purchaseId);
  if (!found) return { error: "ไม่พบคำสั่งซื้อ" };
  if (found.purchase.status === "paid") return { error: "ชำระแล้ว แพ็กเข้าบัญชีแล้ว" };
  if (found.payment) {
    await cancelBeamQrPayment({
      storeId: input.storeId,
      gatewayPaymentId: found.payment.id,
      actorUserId: null,
      client: db,
      reason: "ลูกค้ายกเลิกการซื้อแพ็ก",
    });
  }
  await db
    .from("prepaid_pass_purchases")
    .update({ status: "cancelled", updated_at: new Date().toISOString() })
    .eq("id", input.purchaseId)
    .eq("status", "pending");
  return { error: null };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
