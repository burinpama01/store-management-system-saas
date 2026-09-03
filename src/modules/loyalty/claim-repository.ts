/**
 * QR รับแต้มท้ายใบเสร็จ — ชั้นเรียก RPC (ตรรกะจริงอยู่ใน migration 20260903000002)
 *
 * ทำไมต้องมี: เดิมแต้มเข้าได้ทางเดียวคือแคชเชียร์ค้นหาลูกค้าแล้วผูกกับบิล "ก่อน" เก็บเงิน
 * ช่วงลูกค้าเยอะจึงช้า และถ้าลืมผูกก็แก้ไม่ได้เลยเพราะบิลจ่ายแล้วแก้ไม่ได้
 *
 * ใช้ service client เพราะ:
 *   - ตอนออกใบเสร็จ ต้องสร้างรหัสให้ได้แม้ผู้ใช้จะไม่มีสิทธิ์เขียนตาราง (RPC ตรวจร้าน/บิลเอง)
 *   - ตอนลูกค้ากดรับ ผู้ใช้เป็นสมาชิกฝั่ง public ที่ยืนยันตัวผ่าน portal + OTP มาแล้ว
 */
import type { AppError } from "@/shared/utils/error";
import { mapError } from "@/shared/utils/error";
import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";

export interface LoyaltyClaimCode {
  readonly code: string;
  readonly points: number;
  readonly expiresAt: string;
  readonly claimed: boolean;
}

function parseClaimCode(value: unknown): LoyaltyClaimCode | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const code = typeof row.code === "string" ? row.code : "";
  const points = typeof row.points === "number" ? row.points : Number(row.points ?? 0);
  const expiresAt = typeof row.expires_at === "string" ? row.expires_at : "";
  if (!code || !expiresAt || !Number.isFinite(points) || points <= 0) return null;
  return { code, points, expiresAt, claimed: row.claimed === true };
}

/**
 * สร้าง (หรือคืนอันเดิม) รหัสรับแต้มของบิล — คืน null เมื่อบิลนั้นไม่ควรมีรหัส
 * เช่น ยังไม่จ่าย / ผูกลูกค้าไว้แล้ว / ร้านปิดสะสมแต้ม / คำนวณแล้วได้ 0 แต้ม
 */
export async function ensureLoyaltyClaimCode(
  storeId: string,
  orderId: string,
): Promise<{ data: LoyaltyClaimCode | null; error: AppError | null }> {
  const supabase = await createSupabaseServiceClient();
  const { data, error } = await supabase.rpc("create_loyalty_claim_code", {
    p_store_id: storeId,
    p_order_id: orderId,
  });
  if (error) return { data: null, error: mapError(error) };
  return { data: parseClaimCode(data), error: null };
}

export type LoyaltyClaimOutcome =
  | { readonly status: "claimed"; readonly points: number; readonly balance: number; readonly orderNumber: string }
  | { readonly status: "already_claimed" | "expired" | "not_found" | "invalid_customer" | "order_unavailable"; readonly message: string };

/** ลูกค้ากดรับแต้มจากรหัสบนใบเสร็จ — RPC รับประกันว่าได้ครั้งเดียวต่อบิล */
export async function claimLoyaltyPointsWithCode(input: {
  storeId: string;
  code: string;
  customerId: string;
}): Promise<{ data: LoyaltyClaimOutcome | null; error: AppError | null }> {
  const supabase = await createSupabaseServiceClient();
  const { data, error } = await supabase.rpc("claim_loyalty_points", {
    p_store_id: input.storeId,
    p_code: input.code.trim().toUpperCase(),
    p_customer_id: input.customerId,
  });
  if (error) return { data: null, error: mapError(error) };

  const row = (data ?? {}) as Record<string, unknown>;
  const status = String(row.status ?? "");
  if (status === "claimed") {
    return {
      data: {
        status: "claimed",
        points: Number(row.points ?? 0),
        balance: Number(row.balance ?? 0),
        orderNumber: String(row.order_number ?? ""),
      },
      error: null,
    };
  }
  if (
    status === "already_claimed" ||
    status === "expired" ||
    status === "not_found" ||
    status === "invalid_customer" ||
    status === "order_unavailable"
  ) {
    return { data: { status, message: String(row.message ?? "รับแต้มไม่สำเร็จ") }, error: null };
  }
  return { data: null, error: { code: "claim_failed", message: "unexpected", userMessage: "รับแต้มไม่สำเร็จ" } };
}

/** URL ที่ฝังใน QR ท้ายใบเสร็จ — พาลูกค้าเข้าหน้าสมาชิกของร้านพร้อมรหัสรับแต้ม */
export function buildLoyaltyClaimUrl(input: {
  baseUrl: string;
  storeSlug: string;
  portalToken: string;
  code: string;
}): string {
  const url = new URL(`/member/${encodeURIComponent(input.storeSlug)}`, input.baseUrl);
  url.searchParams.set("code", input.portalToken);
  url.searchParams.set("claim", input.code);
  return url.toString();
}
