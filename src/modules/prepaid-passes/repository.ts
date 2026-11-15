import { createSupabaseServerClient } from "@/server/integrations/supabase/server";
import type { PassPlanInput, PassRedeemScope } from "./rules";
import type { MemberPass, PassPlan, PassSaleProduct } from "./types";

type Result<T> = { data: T; error: null } | { data: null; error: string };

// ตาราง/RPC ใหม่ยังไม่อยู่ใน database.types (แบบเดียวกับ operations/repository.ts)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LooseClient = any;

async function db(): Promise<LooseClient> {
  return createSupabaseServerClient();
}

/** ข้อความจาก raise exception ของ RPC เป็นภาษาไทยที่ตั้งใจให้ผู้ใช้เห็นอยู่แล้ว */
function rpcMessage(error: { message?: string } | null | undefined, fallback: string): string {
  const message = error?.message?.trim();
  return message ? message : fallback;
}

/* eslint-disable @typescript-eslint/no-explicit-any -- แถวดิบจาก PostgREST */
export async function listPassPlans(storeId: string): Promise<Result<PassPlan[]>> {
  const client = await db();
  const { data, error } = await client
    .from("prepaid_pass_plans")
    .select("*, prepaid_pass_plan_products(product_id)")
    .eq("store_id", storeId)
    .order("created_at", { ascending: false });
  if (error) return { data: null, error: error.message };

  const planIds = (data ?? []).map((row: any) => row.id);
  const sold = new Map<string, number>();
  if (planIds.length > 0) {
    const soldRes = await client.from("prepaid_passes").select("plan_id").in("plan_id", planIds).neq("status", "voided");
    if (!soldRes.error) {
      for (const row of soldRes.data ?? []) sold.set(row.plan_id, (sold.get(row.plan_id) ?? 0) + 1);
    }
  }

  return {
    data: (data ?? []).map((row: any) => ({
      id: row.id,
      storeId: row.store_id,
      saleProductId: row.sale_product_id,
      name: row.name,
      credits: row.credits,
      price: Number(row.price),
      validDays: row.valid_days ?? null,
      redeemScope: row.redeem_scope as PassRedeemScope,
      terms: row.terms,
      isActive: Boolean(row.is_active),
      productIds: (row.prepaid_pass_plan_products ?? []).map((link: any) => link.product_id),
      soldCount: sold.get(row.id) ?? 0,
    })),
    error: null,
  };
}

export async function listPassSaleProducts(storeId: string): Promise<PassSaleProduct[]> {
  const client = await db();
  const { data, error } = await client
    .from("prepaid_pass_plans")
    .select("sale_product_id, name, credits, valid_days, terms")
    .eq("store_id", storeId)
    .eq("is_active", true);
  if (error || !data) return [];
  return data.map((row: any) => ({
    productId: row.sale_product_id,
    planName: row.name,
    credits: row.credits,
    validDays: row.valid_days ?? null,
    terms: row.terms,
  }));
}

export async function savePassPlan(storeId: string, planId: string | null, input: PassPlanInput): Promise<Result<string>> {
  const client = await db();
  const { data, error } = await client.rpc("save_prepaid_pass_plan", {
    p_store_id: storeId,
    p_plan_id: planId,
    p_name: input.name.trim(),
    p_credits: input.credits,
    p_price: input.price,
    p_valid_days: input.validDays,
    p_redeem_scope: input.redeemScope,
    p_terms: input.terms.trim(),
    p_product_ids: input.productIds,
    p_is_active: input.isActive,
  });
  if (error) return { data: null, error: rpcMessage(error, "บันทึกแพ็กไม่สำเร็จ") };
  return { data: String(data), error: null };
}

export async function listMemberPasses(storeId: string, verificationId: string): Promise<Result<MemberPass[]>> {
  const client = await db();
  const { data, error } = await client.rpc("list_prepaid_passes_for_verification", {
    p_store_id: storeId,
    p_verification_id: verificationId,
  });
  if (error) return { data: null, error: rpcMessage(error, "โหลดแพ็กของสมาชิกไม่สำเร็จ") };
  return {
    data: ((data as any[]) ?? []).map((row) => ({
      id: row.id,
      planName: row.plan_name,
      creditsTotal: row.credits_total,
      creditsRemaining: row.credits_remaining,
      expiresAt: row.expires_at ?? null,
      usableHere: Boolean(row.usable_here),
      productIds: Array.isArray(row.product_ids) ? row.product_ids : [],
    })),
    error: null,
  };
}

export async function reservePassRedemption(input: {
  storeId: string;
  verificationId: string;
  passId: string;
  productId: string;
  quantity: number;
  checkoutKey: string;
}): Promise<Result<{ redemptionId: string; customerId: string; creditsRemaining: number; planName: string }>> {
  const client = await db();
  const { data, error } = await client.rpc("reserve_prepaid_pass_redemption", {
    p_store_id: input.storeId,
    p_verification_id: input.verificationId,
    p_pass_id: input.passId,
    p_product_id: input.productId,
    p_quantity: input.quantity,
    p_checkout_key: input.checkoutKey,
  });
  if (error) return { data: null, error: rpcMessage(error, "จองสิทธิ์แพ็กไม่สำเร็จ") };
  return {
    data: {
      redemptionId: String(data.redemption_id),
      customerId: String(data.customer_id),
      creditsRemaining: Number(data.credits_remaining),
      planName: String(data.plan_name),
    },
    error: null,
  };
}

export async function releasePassRedemption(storeId: string, redemptionId: string): Promise<string | null> {
  const client = await db();
  const { error } = await client.rpc("release_prepaid_pass_redemption", {
    p_store_id: storeId,
    p_redemption_id: redemptionId,
  });
  return error ? rpcMessage(error, "คืนสิทธิ์แพ็กไม่สำเร็จ") : null;
}

export async function attachPassRedemptions(storeId: string, orderId: string, redemptionIds: string[]): Promise<string | null> {
  if (redemptionIds.length === 0) return null;
  const client = await db();
  const { error } = await client.rpc("attach_prepaid_pass_redemptions", {
    p_store_id: storeId,
    p_order_id: orderId,
    p_redemption_ids: redemptionIds,
  });
  return error ? rpcMessage(error, "แนบสิทธิ์แพ็กกับออเดอร์ไม่สำเร็จ") : null;
}

/** ปิดบิลยอด ฿0 ที่ใช้แพ็กทั้งบิล (ไม่มีแถว payments) */
export async function closeOrderZeroTotal(orderId: string, storeId: string, userId: string): Promise<string | null> {
  const client = await db();
  const { error } = await client.rpc("close_pos_order_zero_total", {
    p_order_id: orderId,
    p_store_id: storeId,
    p_processed_by_user_id: userId,
  });
  return error ? rpcMessage(error, "ปิดบิลใช้แพ็กไม่สำเร็จ") : null;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** ออเดอร์ที่สร้างไปแล้วด้วย idempotency key นี้ (ส่งบิลซ้ำ) — null = ยังไม่มี */
export async function findOrderIdByIdempotencyKey(storeId: string, idempotencyKey: string): Promise<string | null> {
  const client = await db();
  const { data, error } = await client.rpc("find_pos_order_by_idempotency_key", {
    p_store_id: storeId,
    p_idempotency_key: idempotencyKey,
  });
  if (error || !data) return null;
  return String(data);
}
