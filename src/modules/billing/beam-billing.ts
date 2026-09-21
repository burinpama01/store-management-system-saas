import { randomUUID } from "node:crypto";
import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import { checkBeamAvailability, createBeamQrCharge, getBeamCharge } from "@/modules/payments/beam-client";
import { decodeBeamCredentials } from "@/modules/payments/credentials";
import { verifyBeamSignature } from "@/modules/payments/beam-signature";
import { getPlatformBeamSettings } from "./beam-settings";
import { getPlatformSettings } from "./platform-settings";
import { getBusinessUpgradeQuote, getUpgradeQuote } from "./pricing-repository";
import { describeDiscountRejection } from "./discount-code";
import { resolveSubscriptionQr } from "./promptpay-provider";
import { evaluateBeamBillingCharge, evaluateBillingSlip } from "./beam-billing-policy";
import { isSlip2goConfigured, verifyBillingSlipByImage } from "./slip2go";
import { billingOrderView, type PlatformBillingOrder } from "./beam-billing-types";
import type { SubmitPaymentInput } from "./subscription-service";

async function readOrder(id: string, organizationId?: string) {
  const db = await createSupabaseServiceClient();
  let q = db.from("platform_billing_orders").select("*").eq("id", id);
  if (organizationId) q = q.eq("organization_id", organizationId);
  const { data, error } = await q.single();
  if (error || !data) throw new Error("ไม่พบรายการชำระเงิน");
  return data;
}

export async function getPendingPlatformBillingOrder(organizationId: string) {
  const db = await createSupabaseServiceClient();
  const { data, error } = await db.from("platform_billing_orders").select("*")
    .eq("organization_id", organizationId).in("status", ["creating", "pending"]).maybeSingle();
  if (error) throw new Error("อ่านรายการชำระเงินไม่สำเร็จ");
  return data ? billingOrderView(data) : null;
}

export async function createPlatformBillingOrder(input: SubmitPaymentInput) {
  const pending = await getPendingPlatformBillingOrder(input.organizationId);
  if (pending) return pending; // Existing payment takes precedence over a new readiness check.
  const config = await getPlatformBeamSettings();
  if (config.billing_provider !== "beam") throw new Error("ยังไม่ได้เปิด Beam สำหรับแพ็กเกจ");
  const quote = input.plan === "business"
    ? await getBusinessUpgradeQuote(input.organizationId, input.businessConfig!, input.duration, input.discountCode)
    : await getUpgradeQuote(input.organizationId, input.plan, input.duration, input.discountCode);
  if (!quote || quote.discountRejection) throw new Error(quote?.discountRejection ? describeDiscountRejection(quote.discountRejection) : "ไม่พบราคาแพ็กเกจ");
  if (!Number.isFinite(quote.finalAmount) || quote.finalAmount <= 0) throw new Error("ยอดชำระต้องมากกว่า 0 บาท กรุณาติดต่อผู้ดูแล");
  const readiness = config.creds?.webhookHmacKey
    ? await checkBeamAvailability({ environment: config.beam_environment, creds: config.creds })
    : { ok: false as const };
  const method = readiness.ok ? "beam" : "slip";
  if (method === "slip" && (!config.beam_fallback_enabled || !isSlip2goConfigured())) throw new Error("Beam ไม่พร้อม และยังไม่มีช่องทางสำรองที่พร้อมใช้งาน กรุณาติดต่อผู้ดูแล");
  if (method === "slip" && config.beam_environment !== "live") throw new Error("Beam ทดสอบไม่พร้อม ช่องทางโอนเงินจริงสำรองใช้ได้เฉพาะ Production");
  const now = new Date();
  const order: PlatformBillingOrder = {
    id: randomUUID(), organization_id: input.organizationId, submitted_by: input.submittedByUserId,
    plan: input.plan, duration: input.duration, amount: quote.finalAmount, discount_code_id: quote.discountCode?.id ?? null,
    discount_amount: quote.discount, business_seats: input.businessConfig?.seats ?? null,
    business_stores: input.businessConfig?.stores ?? null, business_features: input.businessConfig?.features ?? [],
    method, environment: config.beam_environment,
    credentials_encrypted: config.beam_credentials_encrypted, receiver_account: config.beam_fallback_account,
    qr_payload: null, qr_image: null, charge_id: null, creation_attempted: false, status: method === "beam" ? "creating" : "pending",
    created_at: now.toISOString(), expires_at: new Date(now.getTime() + 15 * 60_000).toISOString(), paid_at: null, new_expiry: null,
  };
  if (method === "slip") {
    const qr = resolveSubscriptionQr(await getPlatformSettings(), order.amount);
    if (qr.type !== "payload" || !order.receiver_account) throw new Error("บัญชีรับเงินสำรองยังไม่พร้อม");
    order.qr_payload = qr.payload;
  }
  const db = await createSupabaseServiceClient();
  const { error } = await db.from("platform_billing_orders").insert(order);
  if (error?.code === "23505") {
    const active = await getPendingPlatformBillingOrder(input.organizationId);
    if (active) return active;
  }
  if (error) throw new Error("บันทึกรายการชำระเงินไม่สำเร็จ");
  return method === "beam" ? resumePlatformBeamOrder(order) : billingOrderView(order);
}

async function resumePlatformBeamOrder(order: PlatformBillingOrder) {
  const creds = decodeBeamCredentials(order.credentials_encrypted);
  if (!creds) throw new Error("อ่านบัญชีรับเงินของรายการไม่ได้ กรุณาติดต่อผู้ดูแล");
  const db = await createSupabaseServiceClient();
  const { data: firstAttempt, error: attemptError } = await db.from("platform_billing_orders")
    .update({ creation_attempted: true }).eq("id", order.id).eq("creation_attempted", false).select("id").maybeSingle();
  if (attemptError) throw new Error("บันทึกการเริ่มจ่ายไม่สำเร็จ");
  const result = await createBeamQrCharge({ environment: order.environment, creds, amountSatang: Math.round(Number(order.amount) * 100),
    referenceId: order.id, idempotencyKey: order.id, expiresAt: order.expires_at });
  if (!result.ok) {
    // Never assume a timeout/5xx means no charge. Retry using the SAME idempotency key.
    if (firstAttempt && [400, 401, 403, 422].includes(result.status)) {
      const { error } = await db.from("platform_billing_orders").update({ status: "failed" }).eq("id", order.id).eq("status", "creating");
      if (error) throw new Error("บันทึกผล Beam ไม่สำเร็จ");
      return billingOrderView(await readOrder(order.id));
    }
    throw new Error("Beam ยังไม่ยืนยันผล กรุณาตรวจรายการเดิมอีกครั้ง ห้ามโอนซ้ำ");
  }
  const { error } = await db.from("platform_billing_orders").update({ charge_id: result.data.chargeId,
    qr_payload: result.data.qrPayload, qr_image: result.data.qrImageBase64, status: "pending" })
    .eq("id", order.id).eq("status", "creating");
  if (error) throw new Error("บันทึก QR ไม่สำเร็จ กรุณาตรวจรายการเดิม");
  return billingOrderView(await readOrder(order.id));
}

async function settle(order: PlatformBillingOrder, ref: string) {
  const db = await createSupabaseServiceClient();
  const { error } = await db.rpc("settle_platform_billing_order", { p_order_id: order.id, p_method: order.method, p_ref: ref, p_amount: Number(order.amount) });
  if (error) throw new Error(error.code === "23505" ? "หลักฐานการชำระนี้ถูกใช้ไปแล้ว" : "ยืนยันแพ็กเกจไม่สำเร็จ กรุณาตรวจรายการเดิมอีกครั้ง");
  return billingOrderView(await readOrder(order.id));
}

export async function refreshPlatformBillingOrder(id: string, organizationId?: string) {
  const order = await readOrder(id, organizationId);
  if (order.status === "paid" || order.status === "test_paid") return billingOrderView(order);
  if (order.method === "slip") {
    if (order.status === "pending" && Date.parse(order.expires_at) < Date.now()) {
      const db = await createSupabaseServiceClient();
      const { error } = await db.from("platform_billing_orders").update({ status: "failed" }).eq("id", order.id).eq("status", "pending");
      if (error) throw new Error("ปิดรายการหมดอายุไม่สำเร็จ");
    }
    return billingOrderView(await readOrder(order.id));
  }
  if (!order.charge_id) return order.status === "creating" ? resumePlatformBeamOrder(order) : billingOrderView(order);
  const creds = decodeBeamCredentials(order.credentials_encrypted);
  if (!creds) throw new Error("อ่านบัญชีรับเงินของรายการไม่ได้");
  const result = await getBeamCharge({ environment: order.environment, creds, chargeId: order.charge_id });
  if (!result.ok) throw new Error("ตรวจสถานะ Beam ไม่สำเร็จ กรุณาตรวจรายการเดิม ห้ามโอนซ้ำ");
  if (evaluateBeamBillingCharge(order, result.data)) return settle(order, result.data.chargeId);
  if (result.data.chargeId !== order.charge_id || result.data.referenceId !== order.id || result.data.amountSatang !== Math.round(Number(order.amount) * 100)) throw new Error("ข้อมูลการชำระจาก Beam ไม่ตรงกับรายการ");
  if (result.data.status === "FAILED") {
    const db = await createSupabaseServiceClient();
    const { error } = await db.from("platform_billing_orders").update({ status: "failed" }).eq("id", order.id).eq("status", "pending");
    if (error) throw new Error("บันทึกสถานะ Beam ไม่สำเร็จ");
  }
  return billingOrderView(await readOrder(order.id));
}

export async function verifyPlatformBillingSlip(id: string, organizationId: string, image: string, contentType: string) {
  const order = await readOrder(id, organizationId);
  if (order.method !== "slip") throw new Error("รายการนี้ต้องยืนยันจาก Beam");
  if (order.status === "paid" || order.status === "test_paid") return billingOrderView(order);
  if (order.status !== "pending") throw new Error("รายการนี้ปิดแล้ว หากโอนแล้วกรุณาติดต่อผู้ดูแลพร้อมหลักฐาน");
  const evidence = await verifyBillingSlipByImage(image, contentType, order.receiver_account ?? "", Number(order.amount));
  const rejection = evaluateBillingSlip(order, evidence);
  if (rejection) throw new Error(rejection);
  return settle(order, evidence.transRef!);
}

export async function processPlatformBeamWebhook(raw: string, signature: string | null) {
  const body = JSON.parse(raw) as { referenceId?: unknown; merchantId?: unknown; chargeId?: unknown };
  if (typeof body.referenceId !== "string" || !/^[0-9a-f-]{36}$/i.test(body.referenceId)) throw new Error("invalid_reference");
  const order = await readOrder(body.referenceId);
  const creds = decodeBeamCredentials(order.credentials_encrypted);
  if (order.method !== "beam" || !creds?.webhookHmacKey || !verifyBeamSignature(raw, signature, creds.webhookHmacKey) || body.merchantId !== creds.merchantId) throw new Error("invalid_signature");
  if (!order.charge_id && order.status === "creating" && typeof body.chargeId === "string" && body.chargeId) {
    const db = await createSupabaseServiceClient();
    const { error } = await db.from("platform_billing_orders").update({ charge_id: body.chargeId, status: "pending" })
      .eq("id", order.id).eq("status", "creating");
    if (error) throw new Error("bind_charge_failed");
  }
  // The signed notification triggers authoritative lookup; its status/amount cannot grant entitlement.
  return refreshPlatformBillingOrder(order.id);
}
