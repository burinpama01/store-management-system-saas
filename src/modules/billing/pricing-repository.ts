import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import { mapError } from "@/shared/utils/error";
import {
  DURATION_PRICES,
  isPaidTier,
  isSubscriptionCurrent,
  type BillingDuration,
  type PaidTier,
} from "./pricing";
import { buildFreeTrialOffer, type FreeTrialOffer } from "./free-trial";
import { getFreeTrialCampaign } from "./platform-settings";
import {
  evaluateBillingDiscount,
  isDiscountablePlan,
  normalizeDiscountCode,
  type BillingDiscountCode,
  type DiscountablePlan,
  type DiscountRejectionReason,
} from "./discount-code";
import {
  BUSINESS_DEFAULT_PRICES,
  computeBusinessPrice,
  computeBusinessStartingPrice,
  isBusinessComponent,
  type BusinessComponent,
  type BusinessPriceMap,
} from "./business-plan";
import type { BusinessPlanConfig } from "./types";

export interface Promotion {
  id: string;
  description: string;
  percentOff: number;
  active: boolean;
  /** null = applies to all paid plans; otherwise only this tier. */
  plan: DiscountablePlan | null;
  startsAt: string | null;
  endsAt: string | null;
}

/** Applies a percentage discount, rounded to the nearest baht. Pure. */
export function applyPromotion(base: number, percentOff: number): number {
  if (!(percentOff > 0)) return base;
  return Math.round((base * (100 - percentOff)) / 100);
}

/** Picks the strongest currently-valid promotion (or null). Pure. */
export function pickActivePromotion(rows: Promotion[], now: Date = new Date()): Promotion | null {
  const t = now.getTime();
  const valid = rows.filter(
    (p) =>
      p.active &&
      (!p.startsAt || new Date(p.startsAt).getTime() <= t) &&
      (!p.endsAt || new Date(p.endsAt).getTime() >= t),
  );
  if (valid.length === 0) return null;
  return valid.reduce((a, b) => (b.percentOff > a.percentOff ? b : a));
}

type PriceMap = Record<PaidTier, Record<BillingDuration, number>>;

/** Reads editable prices, falling back to code defaults for any missing row. */
async function getPriceMap(): Promise<PriceMap> {
  const supabase = await createSupabaseServiceClient();
  const map: PriceMap = {
    starter: { ...DURATION_PRICES.starter },
    standard: { ...DURATION_PRICES.standard },
    premium: { ...DURATION_PRICES.premium },
  };
  const { data } = await supabase.from("billing_prices").select("tier, duration, amount");
  for (const row of data ?? []) {
    if (isPaidTier(row.tier)) {
      map[row.tier as PaidTier][row.duration as BillingDuration] = Number(row.amount);
    }
  }
  return map;
}

/** Reads editable Business component prices, falling back to code defaults. */
export async function getBusinessPriceMap(): Promise<BusinessPriceMap> {
  const supabase = await createSupabaseServiceClient();
  const map = Object.fromEntries(
    (Object.entries(BUSINESS_DEFAULT_PRICES) as [BusinessComponent, Record<BillingDuration, number>][]).map(
      ([component, prices]) => [component, { ...prices }],
    ),
  ) as BusinessPriceMap;
  const { data } = await supabase.from("business_plan_prices").select("component, duration, amount");
  for (const row of data ?? []) {
    if (isBusinessComponent(row.component)) {
      map[row.component][row.duration as BillingDuration] = Number(row.amount);
    }
  }
  return map;
}

export async function updateBusinessPrice(
  component: BusinessComponent,
  duration: BillingDuration,
  amount: number,
) {
  const supabase = await createSupabaseServiceClient();
  const { error } = await supabase
    .from("business_plan_prices")
    .upsert(
      { component, duration, amount, updated_at: new Date().toISOString() },
      { onConflict: "component,duration" },
    );
  if (error) return { ok: false, error: mapError(error) };
  return { ok: true, error: null };
}

async function getActivePromotion(plan: DiscountablePlan): Promise<Promotion | null> {
  const supabase = await createSupabaseServiceClient();
  const { data } = await supabase
    .from("billing_promotions")
    .select("id, description, percent_off, active, plan, starts_at, ends_at")
    .eq("active", true);
  const rows: Promotion[] = (data ?? [])
    .map((p) => ({
      id: p.id,
      description: p.description,
      percentOff: p.percent_off,
      active: p.active,
      plan: (p.plan as DiscountablePlan | null) ?? null,
      startsAt: p.starts_at,
      endsAt: p.ends_at,
    }))
    .filter((p) => p.plan === null || p.plan === plan); // platform-wide or this tier
  return pickActivePromotion(rows);
}

export interface EffectivePrice {
  base: number;
  amount: number;
  promotion: Promotion | null;
}

/** Effective price for a paid tier/duration: edited base price minus active promo. */
export async function getEffectivePrice(
  plan: string,
  duration: BillingDuration,
): Promise<EffectivePrice | null> {
  if (!isPaidTier(plan)) return null;
  const [map, promo] = await Promise.all([getPriceMap(), getActivePromotion(plan)]);
  const base = map[plan][duration];
  const amount = promo ? applyPromotion(base, promo.percentOff) : base;
  return { base, amount, promotion: promo };
}

// ── Super-admin management ────────────────────────────────────────────

export async function listBillingPrices(): Promise<PriceMap> {
  return getPriceMap();
}

export async function updateBillingPrice(tier: PaidTier, duration: BillingDuration, amount: number) {
  const supabase = await createSupabaseServiceClient();
  const { error } = await supabase
    .from("billing_prices")
    .upsert({ tier, duration, amount, updated_at: new Date().toISOString() }, { onConflict: "tier,duration" });
  if (error) return { ok: false, error: mapError(error) };
  return { ok: true, error: null };
}

export async function listPromotions(): Promise<Promotion[]> {
  const supabase = await createSupabaseServiceClient();
  const { data } = await supabase
    .from("billing_promotions")
    .select("id, description, percent_off, active, plan, starts_at, ends_at")
    .order("created_at", { ascending: false });
  return (data ?? []).map((p) => ({
    id: p.id,
    description: p.description,
    percentOff: p.percent_off,
    active: p.active,
    plan: (p.plan as PaidTier | null) ?? null,
    startsAt: p.starts_at,
    endsAt: p.ends_at,
  }));
}

export async function createPromotion(input: {
  description: string;
  percentOff: number;
  plan: DiscountablePlan | null;
  startsAt: string | null;
  endsAt: string | null;
}) {
  const supabase = await createSupabaseServiceClient();
  const { error } = await supabase.from("billing_promotions").insert({
    description: input.description,
    percent_off: input.percentOff,
    plan: input.plan,
    active: true,
    starts_at: input.startsAt,
    ends_at: input.endsAt,
  });
  if (error) return { ok: false, error: mapError(error) };
  return { ok: true, error: null };
}

/**
 * Pro-rated upgrade credit (pure): the unused value of the current subscription,
 * based on what was ACTUALLY paid × remaining days / total days. Returns 0 when
 * there is no current paid window.
 */
export function computeUpgradeCredit(input: {
  periodStart: string | null;
  periodEnd: string | null;
  lastPaidAmount: number;
  now?: Date;
}): number {
  const now = (input.now ?? new Date()).getTime();
  if (!input.periodStart || !input.periodEnd || input.lastPaidAmount <= 0) return 0;
  const start = new Date(input.periodStart).getTime();
  const end = new Date(input.periodEnd).getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start || now >= end) return 0;
  const total = end - start;
  const remaining = Math.min(end - now, total);
  return Math.round(input.lastPaidAmount * (remaining / total));
}

// ── Discount codes (#package-discount) ────────────────────────────────

function mapDiscountCode(row: {
  id: string;
  code: string;
  normalized_code: string;
  description: string;
  discount_type: "percentage" | "fixed";
  discount_value: number;
  plan: string | null;
  duration: string | null;
  min_amount: number;
  max_redemptions: number | null;
  max_redemptions_per_org: number | null;
  active: boolean;
  starts_at: string | null;
  ends_at: string | null;
}): BillingDiscountCode {
  return {
    id: row.id,
    code: row.code,
    normalizedCode: row.normalized_code,
    description: row.description,
    discountType: row.discount_type,
    discountValue: Number(row.discount_value),
    plan: isDiscountablePlan(row.plan ?? "") ? (row.plan as DiscountablePlan) : null,
    duration: row.duration === "30d" || row.duration === "1y" ? row.duration : null,
    minAmount: Number(row.min_amount ?? 0),
    maxRedemptions: row.max_redemptions,
    maxRedemptionsPerOrg: row.max_redemptions_per_org,
    active: row.active,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
  };
}

const DISCOUNT_CODE_COLUMNS =
  "id, code, normalized_code, description, discount_type, discount_value, plan, duration, min_amount, max_redemptions, max_redemptions_per_org, active, starts_at, ends_at";

async function findDiscountCode(code: string): Promise<BillingDiscountCode | null> {
  const normalized = normalizeDiscountCode(code);
  if (!normalized) return null;
  const supabase = await createSupabaseServiceClient();
  const { data } = await supabase
    .from("billing_discount_codes")
    .select(DISCOUNT_CODE_COLUMNS)
    .eq("normalized_code", normalized)
    .maybeSingle();
  return data ? mapDiscountCode(data) : null;
}

/** Verified redemptions of a code globally and (optionally) for one org. */
async function getDiscountRedemptionCounts(
  discountCodeId: string,
  organizationId: string,
): Promise<{ globalRedeemed: number; orgRedeemed: number }> {
  const supabase = await createSupabaseServiceClient();
  const [globalRes, orgRes] = await Promise.all([
    supabase
      .from("payment_submissions")
      .select("id", { count: "exact", head: true })
      .eq("discount_code_id", discountCodeId)
      .eq("status", "verified"),
    supabase
      .from("payment_submissions")
      .select("id", { count: "exact", head: true })
      .eq("discount_code_id", discountCodeId)
      .eq("organization_id", organizationId)
      .eq("status", "verified"),
  ]);
  return {
    globalRedeemed: globalRes.count ?? 0,
    orgRedeemed: orgRes.count ?? 0,
  };
}

export interface AppliedDiscount {
  id: string;
  description: string;
  normalizedCode: string;
}

export interface UpgradeQuote {
  base: number;
  price: number;
  credit: number;
  finalAmount: number;
  promotion: Promotion | null;
  /** Baht taken off by the applied discount code (0 when none/invalid). */
  discount: number;
  /** The discount code that was successfully applied (null otherwise). */
  discountCode: AppliedDiscount | null;
  /** Why a supplied discount code did not apply (null when none supplied or valid). */
  discountRejection: DiscountRejectionReason | null;
}

/**
 * Final amount a tenant must pay for a plan/duration, after active promotion,
 * an optional discount code (applied to the post-promotion price), and the
 * pro-rated credit from their current subscription's remaining value.
 */
export async function getUpgradeQuote(
  organizationId: string,
  plan: string,
  duration: BillingDuration,
  discountCodeInput?: string | null,
): Promise<UpgradeQuote | null> {
  const eff = await getEffectivePrice(plan, duration);
  if (!eff || !isPaidTier(plan)) return null;

  const supabase = await createSupabaseServiceClient();
  const [{ data: sub }, { data: lastPaid }] = await Promise.all([
    supabase
      .from("subscriptions")
      .select("current_period_start, current_period_end")
      .eq("organization_id", organizationId)
      .maybeSingle(),
    supabase
      .from("payment_submissions")
      .select("verified_amount")
      .eq("organization_id", organizationId)
      .eq("status", "verified")
      .order("verified_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const credit = computeUpgradeCredit({
    periodStart: sub?.current_period_start ?? null,
    periodEnd: sub?.current_period_end ?? null,
    lastPaidAmount: Number(lastPaid?.verified_amount ?? 0),
  });

  let discount = 0;
  let discountCode: AppliedDiscount | null = null;
  let discountRejection: DiscountRejectionReason | null = null;

  const trimmedCode = (discountCodeInput ?? "").trim();
  if (trimmedCode) {
    const found = await findDiscountCode(trimmedCode);
    if (!found) {
      discountRejection = "code_not_found";
    } else {
      const counts = await getDiscountRedemptionCounts(found.id, organizationId);
      const evaluation = evaluateBillingDiscount({
        code: trimmedCode,
        plan,
        duration,
        baseAmount: eff.amount,
        discount: found,
        globalRedeemed: counts.globalRedeemed,
        orgRedeemed: counts.orgRedeemed,
      });
      if (evaluation.ok) {
        discount = evaluation.discount;
        discountCode = {
          id: evaluation.codeId!,
          description: evaluation.description ?? found.description,
          normalizedCode: evaluation.normalizedCode,
        };
      } else {
        discountRejection = evaluation.reason ?? "invalid_discount";
      }
    }
  }

  return {
    base: eff.base,
    price: eff.amount,
    credit,
    finalAmount: Math.max(0, eff.amount - discount - credit),
    promotion: eff.promotion,
    discount,
    discountCode,
    discountRejection,
  };
}

/**
 * Final amount a tenant must pay for a Business (build-your-own) config, after
 * an active promotion (platform-wide or Business-scoped), an optional discount
 * code, and the pro-rated credit from the current subscription.
 */
export async function getBusinessUpgradeQuote(
  organizationId: string,
  config: BusinessPlanConfig,
  duration: BillingDuration,
  discountCodeInput?: string | null,
): Promise<UpgradeQuote> {
  const [priceMap, promo] = await Promise.all([
    getBusinessPriceMap(),
    getActivePromotion("business"),
  ]);
  const base = computeBusinessPrice(config, priceMap, duration);
  const amount = promo ? applyPromotion(base, promo.percentOff) : base;

  const supabase = await createSupabaseServiceClient();
  const [{ data: sub }, { data: lastPaid }] = await Promise.all([
    supabase
      .from("subscriptions")
      .select("current_period_start, current_period_end")
      .eq("organization_id", organizationId)
      .maybeSingle(),
    supabase
      .from("payment_submissions")
      .select("verified_amount")
      .eq("organization_id", organizationId)
      .eq("status", "verified")
      .order("verified_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const credit = computeUpgradeCredit({
    periodStart: sub?.current_period_start ?? null,
    periodEnd: sub?.current_period_end ?? null,
    lastPaidAmount: Number(lastPaid?.verified_amount ?? 0),
  });

  let discount = 0;
  let discountCode: AppliedDiscount | null = null;
  let discountRejection: DiscountRejectionReason | null = null;

  const trimmedCode = (discountCodeInput ?? "").trim();
  if (trimmedCode) {
    const found = await findDiscountCode(trimmedCode);
    if (!found) {
      discountRejection = "code_not_found";
    } else {
      const counts = await getDiscountRedemptionCounts(found.id, organizationId);
      const evaluation = evaluateBillingDiscount({
        code: trimmedCode,
        plan: "business",
        duration,
        baseAmount: amount,
        discount: found,
        globalRedeemed: counts.globalRedeemed,
        orgRedeemed: counts.orgRedeemed,
      });
      if (evaluation.ok) {
        discount = evaluation.discount;
        discountCode = {
          id: evaluation.codeId!,
          description: evaluation.description ?? found.description,
          normalizedCode: evaluation.normalizedCode,
        };
      } else {
        discountRejection = evaluation.reason ?? "invalid_discount";
      }
    }
  }

  return {
    base,
    price: amount,
    credit,
    finalAmount: Math.max(0, amount - discount - credit),
    promotion: promo,
    discount,
    discountCode,
    discountRejection,
  };
}

// ── Super-admin discount-code management ──────────────────────────────

export async function listDiscountCodes(): Promise<BillingDiscountCode[]> {
  const supabase = await createSupabaseServiceClient();
  const { data } = await supabase
    .from("billing_discount_codes")
    .select(DISCOUNT_CODE_COLUMNS)
    .order("created_at", { ascending: false });
  return (data ?? []).map(mapDiscountCode);
}

export async function createDiscountCode(input: {
  code: string;
  description: string;
  discountType: "percentage" | "fixed";
  discountValue: number;
  plan: DiscountablePlan | null;
  duration: BillingDuration | null;
  minAmount: number;
  maxRedemptions: number | null;
  maxRedemptionsPerOrg: number | null;
  startsAt: string | null;
  endsAt: string | null;
}) {
  const supabase = await createSupabaseServiceClient();
  const normalized = normalizeDiscountCode(input.code);
  if (!normalized) return { ok: false as const, error: { userMessage: "กรุณากรอกโค้ดส่วนลด" } };
  const { error } = await supabase.from("billing_discount_codes").insert({
    code: normalized,
    normalized_code: normalized,
    description: input.description,
    discount_type: input.discountType,
    discount_value: input.discountValue,
    plan: input.plan,
    duration: input.duration,
    min_amount: input.minAmount,
    max_redemptions: input.maxRedemptions,
    max_redemptions_per_org: input.maxRedemptionsPerOrg,
    starts_at: input.startsAt,
    ends_at: input.endsAt,
  });
  if (error) return { ok: false as const, error: mapError(error) };
  return { ok: true as const, error: null };
}

export async function setDiscountCodeActive(id: string, active: boolean) {
  const supabase = await createSupabaseServiceClient();
  const { error } = await supabase
    .from("billing_discount_codes")
    .update({ active, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) return { ok: false as const, error: mapError(error) };
  return { ok: true as const, error: null };
}

/**
 * สิทธิ์ทดลอง Enterprise ฟรี 30 วันของกิจการ/ผู้ใช้นี้ — ใช้ได้เมื่อแคมเปญเปิด,
 * ยังไม่เคยกดรับ (นับรวมโปร Premium ฟรีชุดเดิม) และยังไม่มีแพ็กเกจที่ใช้งานอยู่
 */
export async function getFreeTrialEligibility(
  organizationId: string,
  userId: string,
): Promise<FreeTrialOffer> {
  const campaign = await getFreeTrialCampaign();
  const supabase = await createSupabaseServiceClient();
  const [{ data, error }, { data: sub, error: subError }] = await Promise.all([
    // ไม่กรอง promotion_code: เคยกดโปรฟรีตัวไหนไปแล้วก็ถือว่าใช้สิทธิ์ไปแล้ว
    supabase
      .from("billing_premium_trial_redemptions")
      .select("id")
      .or(`user_id.eq.${userId},organization_id.eq.${organizationId}`)
      .limit(1),
    supabase
      .from("subscriptions")
      .select("current_period_end")
      .eq("organization_id", organizationId)
      .maybeSingle(),
  ]);

  return buildFreeTrialOffer({
    campaign,
    alreadyRedeemed: Boolean(error) || Boolean(data?.length),
    activeSubscription: Boolean(subError) || isSubscriptionCurrent(sub?.current_period_end ?? null),
  });
}

// ── Plan display config (#1) ──────────────────────────────────────────

export type PlanTier = PaidTier | "business" | "enterprise";

export interface PlanSetting {
  tier: PlanTier;
  displayName: string;
  visibleOnLanding: boolean;
  highlight: boolean;
  featureLines: string[];
  sortOrder: number;
}

function toLines(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export async function listPlanSettings(): Promise<PlanSetting[]> {
  const supabase = await createSupabaseServiceClient();
  const { data } = await supabase
    .from("plan_settings")
    .select("tier, display_name, visible_on_landing, highlight, feature_lines, sort_order")
    .order("sort_order");
  return (data ?? []).map((p) => ({
    tier: p.tier as PlanTier,
    displayName: p.display_name,
    visibleOnLanding: p.visible_on_landing,
    highlight: p.highlight,
    featureLines: toLines(p.feature_lines),
    sortOrder: p.sort_order,
  }));
}

export async function updatePlanSettings(
  tier: PlanTier,
  input: { displayName: string; visibleOnLanding: boolean; highlight: boolean; featureLines: string[] },
) {
  const supabase = await createSupabaseServiceClient();
  const { error } = await supabase
    .from("plan_settings")
    .update({
      display_name: input.displayName,
      visible_on_landing: input.visibleOnLanding,
      highlight: input.highlight,
      feature_lines: input.featureLines,
      updated_at: new Date().toISOString(),
    })
    .eq("tier", tier);
  if (error) return { ok: false, error: mapError(error) };
  return { ok: true, error: null };
}

export interface PublicPlan {
  tier: PlanTier;
  displayName: string;
  highlight: boolean;
  featureLines: string[];
  price30d: number | null;
  price1y: number | null;
  /** True when prices are "starting from" (Business build-your-own). */
  configurable: boolean;
}

/** Visible plans + prices for the public landing/pricing pages. Service-client read. */
export async function getPublicPricing(): Promise<PublicPlan[]> {
  const [settings, map, businessMap] = await Promise.all([
    listPlanSettings(),
    getPriceMap(),
    getBusinessPriceMap(),
  ]);
  return settings
    .filter((s) => s.visibleOnLanding)
    .map((s) => ({
      tier: s.tier,
      displayName: s.displayName,
      highlight: s.highlight,
      featureLines: s.featureLines,
      price30d: isPaidTier(s.tier)
        ? map[s.tier]["30d"]
        : s.tier === "business"
          ? computeBusinessStartingPrice(businessMap, "30d")
          : null,
      price1y: isPaidTier(s.tier)
        ? map[s.tier]["1y"]
        : s.tier === "business"
          ? computeBusinessStartingPrice(businessMap, "1y")
          : null,
      configurable: s.tier === "business",
    }));
}

export async function setPromotionActive(id: string, active: boolean) {
  const supabase = await createSupabaseServiceClient();
  const { error } = await supabase.from("billing_promotions").update({ active }).eq("id", id);
  if (error) return { ok: false, error: mapError(error) };
  return { ok: true, error: null };
}
