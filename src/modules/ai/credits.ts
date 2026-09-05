// เครดิต AI: เติมเงินซื้อโทเคนเพิ่มเมื่อโควตาฟรีรายเดือนหมด (2026-09-05)
// ใช้เส้นทางชำระเงินเดิมของระบบ (PromptPay + ตรวจสลิปด้วย slip2go) และหักเครดิต
// จริงใน RPC reserve_ai_quota เท่านั้น เพื่อให้ยอดคงเหลือกับการอนุมัติเป็นตัวเดียวกัน
import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import { getPlatformSettings } from "@/modules/billing/platform-settings";
import { resolveSubscriptionQr, type SubscriptionQr } from "@/modules/billing/promptpay-provider";
import { verifySlipByImageBase64, verifySlipByPayload, type Slip2goVerification } from "@/modules/billing/slip2go";
import { evaluatePaymentVerification } from "@/modules/billing/subscription-service";
import { logSystemEvent } from "@/modules/system/event-log";

export type CreditPack = {
  id: string;
  name: string;
  tokens: number;
  priceThb: number;
};

export type CreditBalance = {
  tokensRemaining: number;
  tokensPurchased: number;
};

export type TopupHistoryRow = {
  id: string;
  packId: string;
  tokens: number;
  amount: number;
  status: "verified" | "rejected" | "duplicate";
  reason: string | null;
  createdAt: string;
};

/** แพ็กโทเคนที่เปิดขายอยู่ (super-admin ปรับราคา/ปิดขายได้ที่ตาราง ai_credit_packs) */
export async function listCreditPacks(): Promise<CreditPack[]> {
  const supabase = await createSupabaseServiceClient();
  const { data, error } = await supabase
    .from("ai_credit_packs")
    .select("id, name, tokens, price_thb")
    .eq("is_active", true)
    .order("sort_order", { ascending: true });
  if (error || !data) return [];
  return data.map((row) => ({
    id: row.id as string,
    name: row.name as string,
    tokens: Number(row.tokens),
    priceThb: Number(row.price_thb),
  }));
}

export async function getCreditPack(packId: string): Promise<CreditPack | null> {
  const supabase = await createSupabaseServiceClient();
  const { data } = await supabase
    .from("ai_credit_packs")
    .select("id, name, tokens, price_thb")
    .eq("id", packId)
    .eq("is_active", true)
    .maybeSingle();
  if (!data) return null;
  return {
    id: data.id as string,
    name: data.name as string,
    tokens: Number(data.tokens),
    priceThb: Number(data.price_thb),
  };
}

/** ยอดเครดิตคงเหลือขององค์กร (0 เมื่อยังไม่เคยเติม) */
export async function getCreditBalance(organizationId: string): Promise<CreditBalance> {
  const supabase = await createSupabaseServiceClient();
  const { data } = await supabase
    .from("ai_credit_balances")
    .select("tokens_remaining, tokens_purchased")
    .eq("organization_id", organizationId)
    .maybeSingle();
  return {
    tokensRemaining: Number(data?.tokens_remaining ?? 0),
    tokensPurchased: Number(data?.tokens_purchased ?? 0),
  };
}

export async function listTopupHistory(organizationId: string, limit = 10): Promise<TopupHistoryRow[]> {
  const supabase = await createSupabaseServiceClient();
  const { data } = await supabase
    .from("ai_credit_topups")
    .select("id, pack_id, tokens, amount_expected, status, reason, created_at")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false })
    .limit(limit);
  return (data ?? []).map((row) => ({
    id: row.id as string,
    packId: row.pack_id as string,
    tokens: Number(row.tokens),
    amount: Number(row.amount_expected),
    status: row.status as TopupHistoryRow["status"],
    reason: (row.reason as string | null) ?? null,
    createdAt: row.created_at as string,
  }));
}

/** QR PromptPay สำหรับเติมเครดิต (ใช้บัญชีรับเงินเดียวกับค่าแพ็กเกจ) */
export async function getTopupQr(pack: CreditPack): Promise<SubscriptionQr> {
  const settings = await getPlatformSettings();
  return resolveSubscriptionQr(settings, pack.priceThb);
}

export type SubmitTopupInput = {
  organizationId: string;
  packId: string;
  submittedByUserId: string;
  slipImageBase64?: string;
  slipImageContentType?: string;
  slipPayload?: string;
};

export type SubmitTopupResult = {
  status: "verified" | "rejected" | "duplicate";
  reason: string | null;
  tokensAdded: number;
  balance: number | null;
};

/**
 * เติมเครดิต: ตรวจสลิป → จองเลขอ้างอิงด้วยแถว verified (unique index กันสลิปซ้ำ)
 * → เพิ่มยอดเครดิตผ่าน RPC add_ai_credit
 */
export async function submitCreditTopup(input: SubmitTopupInput): Promise<SubmitTopupResult> {
  const pack = await getCreditPack(input.packId);
  if (!pack) return { status: "rejected", reason: "ไม่พบแพ็กเติมเงินนี้", tokensAdded: 0, balance: null };

  const supabase = await createSupabaseServiceClient();
  const settings = await getPlatformSettings();

  const verification: Slip2goVerification = input.slipImageBase64
    ? await verifySlipByImageBase64(input.slipImageBase64, input.slipImageContentType)
    : input.slipPayload
      ? await verifySlipByPayload(input.slipPayload)
      : {
          ok: false,
          amount: null,
          receiverName: null,
          receiverAccount: null,
          transRef: null,
          raw: null,
          error: "ไม่พบข้อมูลสลิป",
        };

  const evaluation = evaluatePaymentVerification(verification, pack.priceThb, settings.promptpayId);

  if (!evaluation.ok) {
    await supabase.from("ai_credit_topups").insert({
      organization_id: input.organizationId,
      pack_id: pack.id,
      tokens: pack.tokens,
      amount_expected: pack.priceThb,
      verified_amount: verification.amount,
      slip_ref: verification.transRef,
      slip2go_raw: (verification.raw ?? null) as never,
      status: "rejected",
      reason: evaluation.reason,
      submitted_by: input.submittedByUserId,
    });
    void logSystemEvent({
      level: "warn",
      source: "ai.credit",
      action: "topupRejected",
      message: `เติมเครดิต AI ไม่ผ่าน: ${evaluation.reason}`,
      organizationId: input.organizationId,
      actorUserId: input.submittedByUserId,
      context: { packId: pack.id, expected: pack.priceThb, verifiedAmount: verification.amount },
    });
    return { status: "rejected", reason: evaluation.reason, tokensAdded: 0, balance: null };
  }

  const { error: claimErr } = await supabase.from("ai_credit_topups").insert({
    organization_id: input.organizationId,
    pack_id: pack.id,
    tokens: pack.tokens,
    amount_expected: pack.priceThb,
    verified_amount: verification.amount,
    slip_ref: verification.transRef,
    slip2go_raw: (verification.raw ?? null) as never,
    status: "verified",
    reason: null,
    submitted_by: input.submittedByUserId,
  });
  if (claimErr) {
    await supabase.from("ai_credit_topups").insert({
      organization_id: input.organizationId,
      pack_id: pack.id,
      tokens: pack.tokens,
      amount_expected: pack.priceThb,
      verified_amount: verification.amount,
      slip_ref: verification.transRef,
      slip2go_raw: (verification.raw ?? null) as never,
      status: "duplicate",
      reason: "สลิปนี้ถูกใช้ไปแล้ว",
      submitted_by: input.submittedByUserId,
    });
    void logSystemEvent({
      level: "warn",
      source: "ai.credit",
      action: "topupDuplicate",
      message: "เติมเครดิต AI ด้วยสลิปซ้ำ",
      organizationId: input.organizationId,
      actorUserId: input.submittedByUserId,
      context: { packId: pack.id, slipRef: verification.transRef },
    });
    return { status: "duplicate", reason: "สลิปนี้ถูกใช้ไปแล้ว", tokensAdded: 0, balance: null };
  }

  const { data: balance, error: creditErr } = await supabase.rpc("add_ai_credit", {
    p_organization_id: input.organizationId,
    p_tokens: pack.tokens,
  });
  if (creditErr) {
    // สลิปถูกจองไปแล้วแต่เครดิตยังไม่เข้า — ต้องเห็นใน log เพื่อตามคืนให้ร้าน
    void logSystemEvent({
      level: "error",
      source: "ai.credit",
      action: "topupCreditFailed",
      message: `สลิปผ่านแต่เพิ่มเครดิตไม่สำเร็จ: ${creditErr.message}`,
      organizationId: input.organizationId,
      actorUserId: input.submittedByUserId,
      context: { packId: pack.id, tokens: pack.tokens, slipRef: verification.transRef },
    });
    return {
      status: "rejected",
      reason: "ชำระเงินสำเร็จแต่เพิ่มเครดิตไม่สำเร็จ — ทีมงานได้รับแจ้งแล้ว",
      tokensAdded: 0,
      balance: null,
    };
  }

  void logSystemEvent({
    level: "info",
    source: "ai.credit",
    action: "topupVerified",
    message: `เติมเครดิต AI ${pack.tokens.toLocaleString("th-TH")} โทเคน`,
    organizationId: input.organizationId,
    actorUserId: input.submittedByUserId,
    context: { packId: pack.id, tokens: pack.tokens, amount: pack.priceThb, slipRef: verification.transRef },
  });

  return { status: "verified", reason: null, tokensAdded: pack.tokens, balance: Number(balance ?? 0) };
}

/* ───────── ฝั่ง super-admin: จัดการแพ็กเติมเงิน (/system/pricing) ───────── */

export type AdminCreditPack = CreditPack & { sortOrder: number; isActive: boolean };

/** รวมแพ็กที่ปิดขายอยู่ด้วย — ใช้เฉพาะหน้าแอดมิน */
export async function listAllCreditPacks(): Promise<AdminCreditPack[]> {
  const supabase = await createSupabaseServiceClient();
  const { data } = await supabase
    .from("ai_credit_packs")
    .select("id, name, tokens, price_thb, sort_order, is_active")
    .order("sort_order", { ascending: true });
  return (data ?? []).map((row) => ({
    id: row.id as string,
    name: row.name as string,
    tokens: Number(row.tokens),
    priceThb: Number(row.price_thb),
    sortOrder: Number(row.sort_order),
    isActive: Boolean(row.is_active),
  }));
}

export type SaveCreditPackInput = {
  id: string;
  name: string;
  tokens: number;
  priceThb: number;
  sortOrder: number;
  isActive: boolean;
};

/** สร้าง/แก้แพ็ก (id เดิม = แก้ทับ) */
export async function saveCreditPack(input: SaveCreditPackInput): Promise<{ ok: boolean; error: string | null }> {
  const supabase = await createSupabaseServiceClient();
  const { error } = await supabase.from("ai_credit_packs").upsert(
    {
      id: input.id,
      name: input.name,
      tokens: input.tokens,
      price_thb: input.priceThb,
      sort_order: input.sortOrder,
      is_active: input.isActive,
    },
    { onConflict: "id" },
  );
  return { ok: !error, error: error?.message ?? null };
}

export async function setCreditPackActive(id: string, isActive: boolean): Promise<{ ok: boolean; error: string | null }> {
  const supabase = await createSupabaseServiceClient();
  const { error } = await supabase.from("ai_credit_packs").update({ is_active: isActive }).eq("id", id);
  return { ok: !error, error: error?.message ?? null };
}
