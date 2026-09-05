// Task 9/D (v0.34.0) — Server-side AI quota governance.
// Contract from the plan: resolve user/org from the server session, reserve the
// per-request budget atomically BEFORE calling the provider (deny-before-call),
// settle actual usage idempotently afterwards; a timeout that never reports
// provider usage keeps its reservation for reconciliation instead of refunding.
import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import { getCreditBalance } from "./credits";

/** Monthly token budget per organization (server constant; env override allowed). */
export const AI_MONTHLY_TOKEN_BUDGET = Number(process.env.AI_MONTHLY_TOKEN_BUDGET ?? 100000);

/** Hard cap per request — every reservation is bounded by the adapter anyway. */
export const AI_MAX_OUTPUT_TOKENS = 600;

export type QuotaDecision = { granted: boolean; reason?: string };

/** Pure decision core (unit-tested): used + reserved + request must fit the budget. */
export function evaluateQuota(args: {
  monthlyUsed: number;
  monthlyReserved: number;
  budget: number;
  maxTokens: number;
}): QuotaDecision {
  const { monthlyUsed, monthlyReserved, budget, maxTokens } = args;
  if (!Number.isFinite(maxTokens) || maxTokens <= 0 || !Number.isFinite(budget) || budget <= 0) {
    return { granted: false, reason: "invalid_request" };
  }
  if (monthlyUsed + monthlyReserved + maxTokens > budget) {
    return { granted: false, reason: "budget_exceeded" };
  }
  return { granted: true };
}

export type ReserveResult = { granted: boolean; reason?: string };

/**
 * Atomic reservation via the SECURITY DEFINER RPC (advisory-locked per org).
 * The service client is used because reservations are server-governed state;
 * clients have no direct access to the table at all.
 */
export async function reserveQuota(args: {
  organizationId: string;
  requestId: string;
  feature: string;
  maxTokens?: number;
  budget?: number;
}): Promise<ReserveResult> {
  const supabase = await createSupabaseServiceClient();
  const { data, error } = await supabase.rpc("reserve_ai_quota", {
    p_organization_id: args.organizationId,
    p_request_id: args.requestId,
    p_feature: args.feature,
    p_max_tokens: args.maxTokens ?? AI_MAX_OUTPUT_TOKENS,
    p_monthly_budget: args.budget ?? AI_MONTHLY_TOKEN_BUDGET,
  });
  if (error) return { granted: false, reason: error.message };
  const result = data as { granted?: boolean; reason?: string };
  return { granted: Boolean(result?.granted), reason: result?.reason };
}

export type QuotaStatus = {
  budget: number;
  /** โทเคนโควตาฟรีที่ใช้ไปในเดือนนี้ (รวมทุกฟีเจอร์ AI) */
  used: number;
  /** โควตาฟรีที่เหลือของเดือนนี้ */
  remaining: number;
  /** เครดิตที่เติมเงินซื้อไว้ (ไม่หมดอายุรายเดือน) */
  creditRemaining: number;
  /** โทเคนที่ใช้ได้จริงทั้งหมด = โควตาฟรีที่เหลือ + เครดิต */
  totalRemaining: number;
  /** จำนวนครั้งที่ยังเรียก AI ได้ (ปัดลง) — รวมเครดิตแล้ว */
  remainingRequests: number;
};

/** ฟีเจอร์ AI ทั้งหมดที่กินโควตาก้อนเดียวกัน (key ตรงกับที่แต่ละ route ส่งเข้ามา) */
export const AI_FEATURE_LABELS: Record<string, string> = {
  aiVision: "สแกนเมนูด้วย AI",
  aiAssistant: "ผู้ช่วยแก้ปัญหาอุปกรณ์",
  aiVoiceIntent: "สั่งงานด้วยเสียง",
};

export function labelAiFeature(feature: string): string {
  return AI_FEATURE_LABELS[feature] ?? feature;
}

export type AiFeatureUsage = { feature: string; label: string; tokens: number; requests: number };

export type AiUsageSummary = QuotaStatus & {
  maxTokensPerRequest: number;
  /** โทเคนที่หักจากเครดิตไปในเดือนนี้ (แยกจากโควตาฟรี) */
  creditUsedThisMonth: number;
  tokensPurchased: number;
  /** แยกตามฟีเจอร์ รวมทั้งที่กินโควตาฟรีและเครดิต */
  byFeature: AiFeatureUsage[];
};

type ReservationRow = { tokens_reserved: number; feature: string; source: string | null };

/** ต้นเดือนปัจจุบัน (UTC) — ตรงกับ date_trunc('month', now()) ที่ RPC ใช้ตัดสิน */
function monthStartIso(): string {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

async function readMonthlyReservations(organizationId: string): Promise<ReservationRow[]> {
  const supabase = await createSupabaseServiceClient();
  const { data, error } = await supabase
    .from("ai_quota_reservations")
    .select("tokens_reserved, feature, source")
    .eq("organization_id", organizationId)
    .gte("created_at", monthStartIso());
  if (error || !data) return [];
  return data as ReservationRow[];
}

function sumTokens(rows: ReservationRow[], source: "monthly" | "credit"): number {
  return rows
    .filter((row) => (row.source ?? "monthly") === source)
    .reduce((total, row) => total + (Number(row.tokens_reserved) || 0), 0);
}

/**
 * โควตาที่ใช้ได้ของทั้งองค์กร รวมทุกฟีเจอร์ AI (นับจากยอดจอง เพราะ reserve_ai_quota
 * ตัดสินจากยอดจองเช่นกัน) ใช้แสดงผลเท่านั้น — การอนุมัติจริงยังตัดสินใน RPC แบบ atomic
 */
export async function getQuotaStatus(args: {
  organizationId: string;
  budget?: number;
  maxTokens?: number;
}): Promise<QuotaStatus> {
  const budget = args.budget ?? AI_MONTHLY_TOKEN_BUDGET;
  const maxTokens = args.maxTokens ?? AI_MAX_OUTPUT_TOKENS;
  const [rows, credit] = await Promise.all([
    readMonthlyReservations(args.organizationId),
    getCreditBalance(args.organizationId),
  ]);
  const used = sumTokens(rows, "monthly");
  const remaining = Math.max(0, budget - used);
  const totalRemaining = remaining + credit.tokensRemaining;
  return {
    budget,
    used,
    remaining,
    creditRemaining: credit.tokensRemaining,
    totalRemaining,
    remainingRequests: Math.floor(totalRemaining / maxTokens),
  };
}

/** สรุปการใช้ AI ของเดือนนี้แบบแยกฟีเจอร์ (สำหรับการ์ดในหน้าเรียกเก็บเงิน) */
export async function getAiUsageSummary(args: {
  organizationId: string;
  budget?: number;
  maxTokens?: number;
}): Promise<AiUsageSummary> {
  const budget = args.budget ?? AI_MONTHLY_TOKEN_BUDGET;
  const maxTokens = args.maxTokens ?? AI_MAX_OUTPUT_TOKENS;
  const [rows, credit] = await Promise.all([
    readMonthlyReservations(args.organizationId),
    getCreditBalance(args.organizationId),
  ]);
  const used = sumTokens(rows, "monthly");
  const creditUsedThisMonth = sumTokens(rows, "credit");
  const remaining = Math.max(0, budget - used);
  const totalRemaining = remaining + credit.tokensRemaining;

  const byFeatureMap = new Map<string, AiFeatureUsage>();
  for (const row of rows) {
    const feature = row.feature ?? "unknown";
    const entry = byFeatureMap.get(feature) ?? { feature, label: labelAiFeature(feature), tokens: 0, requests: 0 };
    entry.tokens += Number(row.tokens_reserved) || 0;
    entry.requests += 1;
    byFeatureMap.set(feature, entry);
  }
  // ฟีเจอร์ที่ยังไม่ถูกใช้เดือนนี้ก็ต้องขึ้นในรายการ เพื่อให้เห็นว่าโควตาเป็นก้อนเดียวกัน
  for (const feature of Object.keys(AI_FEATURE_LABELS)) {
    if (!byFeatureMap.has(feature)) {
      byFeatureMap.set(feature, { feature, label: labelAiFeature(feature), tokens: 0, requests: 0 });
    }
  }

  return {
    budget,
    used,
    remaining,
    creditRemaining: credit.tokensRemaining,
    totalRemaining,
    remainingRequests: Math.floor(totalRemaining / maxTokens),
    maxTokensPerRequest: maxTokens,
    creditUsedThisMonth,
    tokensPurchased: credit.tokensPurchased,
    byFeature: [...byFeatureMap.values()].sort((a, b) => b.tokens - a.tokens || a.label.localeCompare(b.label, "th")),
  };
}

export type SettleInput = {
  organizationId: string;
  requestId: string;
  feature: string;
  model: string;
  storeId?: string | null;
  userId?: string | null;
  tokens: number;
  status: "ok" | "error" | "timeout" | "denied";
  requestHash: string;
};

/** Idempotent settle: flip the reservation to settled, then append the ledger row. */
export async function settleUsage(input: SettleInput): Promise<{ ok: boolean; error: string | null }> {
  const supabase = await createSupabaseServiceClient();
  const claimed = await supabase
    .from("ai_quota_reservations")
    .update({ status: "settled" })
    .eq("organization_id", input.organizationId)
    .eq("request_id", input.requestId)
    .eq("status", "reserved")
    .select("id");
  if (claimed.error) return { ok: false, error: claimed.error.message };
  // Nothing to claim (already settled) → do not append a duplicate ledger row.
  if (!claimed.data || claimed.data.length === 0) return { ok: true, error: null };
  const inserted = await supabase.from("ai_usage_logs").insert({
    organization_id: input.organizationId,
    store_id: input.storeId ?? null,
    user_id: input.userId ?? null,
    feature: input.feature,
    model: input.model,
    tokens: input.tokens,
    status: input.status,
    request_hash: input.requestHash,
  });
  if (inserted.error) return { ok: false, error: inserted.error.message };
  return { ok: true, error: null };
}