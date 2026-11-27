import { createSupabaseServerClient, createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import type { TierCycleMonths, TierDefinition, TierMetricMode, TierProgramInput } from "./rules";

type Result<T> = { data: T; error: null } | { data: null; error: string };

// ตาราง/RPC ใหม่ยังไม่อยู่ใน database.types (แบบเดียวกับ operations/repository.ts)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LooseClient = any;

export interface TierProgram {
  isEnabled: boolean;
  metricMode: TierMetricMode;
  cycleMonths: TierCycleMonths;
  downgradeOneStep: boolean;
  initialMode: "zero" | "backfill" | null;
  initializedAt: string | null;
  tiers: TierDefinition[];
}

export interface MemberTierView {
  program: TierProgram;
  rank: number;
  tier: TierDefinition;
  cycleStart: string;
  cycleSpend: number;
  cycleOrders: number;
  locked: boolean;
}

export interface TierInitPreview {
  counts: Record<string, number>;
  members: number;
  cycleStart: string;
  previousCycleStart: string;
}

/* eslint-disable @typescript-eslint/no-explicit-any -- แถวดิบจาก PostgREST */
function mapTier(row: any): TierDefinition {
  return {
    rank: Number(row.rank),
    name: row.name,
    color: row.color,
    minSpend: Number(row.min_spend),
    minOrders: Number(row.min_orders),
  };
}

async function loadProgram(db: LooseClient, organizationId: string): Promise<TierProgram | null> {
  const [programRes, tiersRes] = await Promise.all([
    db.from("member_tier_programs").select("*").eq("organization_id", organizationId).maybeSingle(),
    db.from("member_tiers").select("*").eq("organization_id", organizationId).order("rank"),
  ]);
  if (programRes.error || !programRes.data) return null;
  const row = programRes.data;
  return {
    isEnabled: Boolean(row.is_enabled),
    metricMode: row.metric_mode,
    cycleMonths: Number(row.cycle_months) as TierCycleMonths,
    downgradeOneStep: Boolean(row.downgrade_one_step),
    initialMode: row.initial_mode ?? null,
    initializedAt: row.initialized_at ?? null,
    tiers: (tiersRes.data ?? []).map(mapTier),
  };
}

/** โปรแกรมของร้าน (หน้าตั้งค่า) — ด้วยสิทธิ์ผู้ใช้ */
export async function getTierProgram(organizationId: string): Promise<TierProgram | null> {
  return loadProgram(await createSupabaseServerClient(), organizationId);
}

/** ระดับของสมาชิก (หน้าสมาชิก/POS) — service client; null = ร้านไม่ได้เปิดใช้ */
export async function getMemberTierForIdentity(organizationId: string, memberIdentityId: string): Promise<MemberTierView | null> {
  const db: LooseClient = await createSupabaseServiceClient();
  const program = await loadProgram(db, organizationId);
  if (!program || !program.isEnabled || !program.initializedAt || program.tiers.length === 0) return null;
  const { data: status } = await db
    .from("member_tier_status")
    .select("*")
    .eq("member_identity_id", memberIdentityId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  const rank = status ? Number(status.tier_rank) : 0;
  const tier = program.tiers.find((t) => t.rank === rank) ?? program.tiers[0];
  return {
    program,
    rank: tier.rank,
    tier,
    cycleStart: status?.cycle_start ?? "",
    cycleSpend: status ? Number(status.cycle_spend) : 0,
    cycleOrders: status ? Number(status.cycle_orders) : 0,
    locked: Boolean(status?.locked),
  };
}

export async function getMemberTierForCustomer(storeId: string, customerId: string): Promise<MemberTierView | null> {
  const db: LooseClient = await createSupabaseServiceClient();
  const { data } = await db
    .from("customers")
    .select("organization_id, member_identity_id")
    .eq("id", customerId)
    .eq("store_id", storeId)
    .maybeSingle();
  if (!data?.member_identity_id) return null;
  return getMemberTierForIdentity(data.organization_id, data.member_identity_id);
}

export async function saveTierProgram(storeId: string, input: TierProgramInput): Promise<Result<true>> {
  const db: LooseClient = await createSupabaseServerClient();
  const { error } = await db.rpc("save_member_tier_program", {
    p_store_id: storeId,
    p_metric_mode: input.metricMode,
    p_cycle_months: input.cycleMonths,
    p_downgrade_one_step: input.downgradeOneStep,
    p_tiers: input.tiers.map((tier) => ({
      rank: tier.rank,
      name: tier.name.trim(),
      color: tier.color,
      min_spend: tier.minSpend,
      min_orders: tier.minOrders,
    })),
  });
  if (error) return { data: null, error: error.message || "บันทึกไม่สำเร็จ" };
  return { data: true, error: null };
}

export async function initializeTiers(storeId: string, mode: "zero" | "backfill", dryRun: boolean): Promise<Result<TierInitPreview>> {
  const db: LooseClient = await createSupabaseServerClient();
  const { data, error } = await db.rpc("initialize_member_tiers", { p_store_id: storeId, p_mode: mode, p_dry_run: dryRun });
  if (error) return { data: null, error: error.message || "คำนวณไม่สำเร็จ" };
  return {
    data: {
      counts: (data?.counts ?? {}) as Record<string, number>,
      members: Number(data?.members ?? 0),
      cycleStart: String(data?.cycle_start ?? ""),
      previousCycleStart: String(data?.previous_cycle_start ?? ""),
    },
    error: null,
  };
}

export async function setTierProgramEnabled(storeId: string, enabled: boolean): Promise<Result<true>> {
  const db: LooseClient = await createSupabaseServerClient();
  const { error } = await db.rpc("set_member_tier_program_enabled", { p_store_id: storeId, p_enabled: enabled });
  if (error) return { data: null, error: error.message || "บันทึกไม่สำเร็จ" };
  return { data: true, error: null };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface TierBenefit {
  id: string;
  minRank: number;
  name: string;
  discountType: "amount" | "percentage";
  discountValue: number;
  minSubtotal: number;
  usesPerMonth: number;
  isActive: boolean;
}

/** โค้ดสิทธิ์ของเดือนนี้ที่สมาชิกคนนี้ใช้ได้ที่สาขานี้ */
export interface MemberTierCoupon {
  benefitId: string;
  name: string;
  code: string;
  discountType: "amount" | "percentage";
  discountValue: number;
  minSubtotal: number;
  remaining: number;
  usesPerMonth: number;
  endsAt: string | null;
}

/* eslint-disable @typescript-eslint/no-explicit-any -- แถวดิบจาก PostgREST */
export async function listTierBenefits(organizationId: string): Promise<TierBenefit[]> {
  const db: LooseClient = await createSupabaseServerClient();
  const { data } = await db
    .from("member_tier_benefits")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("is_active", true)
    .order("min_rank")
    .order("created_at");
  return (data ?? []).map((row: any) => ({
    id: row.id,
    minRank: Number(row.min_rank),
    name: row.name,
    discountType: row.discount_type,
    discountValue: Number(row.discount_value),
    minSubtotal: Number(row.min_subtotal),
    usesPerMonth: Number(row.uses_per_month),
    isActive: Boolean(row.is_active),
  }));
}

export async function saveTierBenefits(storeId: string, benefits: TierBenefit[]): Promise<Result<true>> {
  const db: LooseClient = await createSupabaseServerClient();
  const { error } = await db.rpc("save_member_tier_benefits", {
    p_store_id: storeId,
    p_benefits: benefits.map((b) => ({
      id: b.id || null,
      min_rank: b.minRank,
      name: b.name.trim(),
      discount_type: b.discountType,
      discount_value: b.discountValue,
      min_subtotal: b.minSubtotal,
      uses_per_month: b.usesPerMonth,
      is_active: b.isActive,
    })),
  });
  if (error) return { data: null, error: error.message || "บันทึกไม่สำเร็จ" };
  return { data: true, error: null };
}

/** service client — ใช้ในหน้าสมาชิก/POS หลังตรวจตัวตนแล้ว */
export async function listMemberTierCoupons(storeId: string, customerId: string, rank: number): Promise<MemberTierCoupon[]> {
  if (rank < 1) return [];
  const db: LooseClient = await createSupabaseServiceClient();
  const monthStart = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit" }).format(new Date()) + "-01";
  const { data: links } = await db
    .from("member_tier_benefit_coupons")
    .select("coupon_id, member_tier_benefits!inner(id, name, min_rank, uses_per_month, is_active)")
    .eq("store_id", storeId)
    .eq("month_start", monthStart);
  const usable = (links ?? []).filter(
    (row: any) => row.member_tier_benefits?.is_active && Number(row.member_tier_benefits.min_rank) <= rank,
  );
  if (usable.length === 0) return [];
  const couponIds = usable.map((row: any) => row.coupon_id);
  const [couponsRes, usedRes] = await Promise.all([
    db.from("coupons").select("id, code, discount_type, discount_value, min_subtotal, ends_at, is_active").in("id", couponIds),
    db.from("coupon_redemptions").select("coupon_id").in("coupon_id", couponIds).eq("customer_id", customerId).is("voided_at", null),
  ]);
  const used = new Map<string, number>();
  for (const row of usedRes.data ?? []) used.set(row.coupon_id, (used.get(row.coupon_id) ?? 0) + 1);
  const couponsById = new Map((couponsRes.data ?? []).map((row: any) => [row.id, row]));
  return usable
    .map((row: any) => {
      const coupon: any = couponsById.get(row.coupon_id);
      if (!coupon || !coupon.is_active) return null;
      const usesPerMonth = Number(row.member_tier_benefits.uses_per_month);
      return {
        benefitId: row.member_tier_benefits.id,
        name: row.member_tier_benefits.name,
        code: coupon.code,
        discountType: coupon.discount_type,
        discountValue: Number(coupon.discount_value),
        minSubtotal: Number(coupon.min_subtotal),
        remaining: Math.max(0, usesPerMonth - (used.get(row.coupon_id) ?? 0)),
        usesPerMonth,
        endsAt: coupon.ends_at ?? null,
      } satisfies MemberTierCoupon;
    })
    .filter((item: MemberTierCoupon | null): item is MemberTierCoupon => item !== null);
}
/* eslint-enable @typescript-eslint/no-explicit-any */
