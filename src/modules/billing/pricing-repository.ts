import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import { mapError } from "@/shared/utils/error";
import {
  DURATION_PRICES,
  isPaidTier,
  isSubscriptionCurrent,
  type BillingDuration,
  type PaidTier,
} from "./pricing";
import {
  buildPremiumFreeTrialOffer,
  isPremiumFreeTrialSelection,
  PREMIUM_FREE_TRIAL_PROMO_CODE,
  type PremiumFreeTrialOffer,
} from "./premium-trial";

export interface Promotion {
  id: string;
  description: string;
  percentOff: number;
  active: boolean;
  /** null = applies to all paid plans; otherwise only this tier. */
  plan: PaidTier | null;
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

async function getActivePromotion(plan: PaidTier): Promise<Promotion | null> {
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
      plan: (p.plan as PaidTier | null) ?? null,
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
  plan: PaidTier | null;
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

export interface UpgradeQuote {
  base: number;
  price: number;
  credit: number;
  finalAmount: number;
  promotion: Promotion | null;
}

/**
 * Final amount a tenant must pay for a plan/duration, after active promotion and
 * pro-rated credit from their current subscription's remaining value.
 */
export async function getUpgradeQuote(
  organizationId: string,
  plan: string,
  duration: BillingDuration,
): Promise<UpgradeQuote | null> {
  const eff = await getEffectivePrice(plan, duration);
  if (!eff) return null;

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

  return {
    base: eff.base,
    price: eff.amount,
    credit,
    finalAmount: Math.max(0, eff.amount - credit),
    promotion: eff.promotion,
  };
}

export async function getPremiumFreeTrialEligibility(
  organizationId: string,
  userId: string,
  plan: string,
  duration: BillingDuration,
): Promise<PremiumFreeTrialOffer> {
  const eff = await getEffectivePrice(plan, duration);
  const basePrice = eff?.amount ?? 0;
  if (!isPremiumFreeTrialSelection(plan, duration)) {
    return buildPremiumFreeTrialOffer({ plan, duration, basePrice, alreadyRedeemed: false });
  }

  const supabase = await createSupabaseServiceClient();
  const [{ data, error }, { data: sub, error: subError }] = await Promise.all([
    supabase
      .from("billing_premium_trial_redemptions")
      .select("id")
      .eq("promotion_code", PREMIUM_FREE_TRIAL_PROMO_CODE)
      .or(`user_id.eq.${userId},organization_id.eq.${organizationId}`)
      .limit(1),
    supabase
      .from("subscriptions")
      .select("current_period_end")
      .eq("organization_id", organizationId)
      .maybeSingle(),
  ]);

  return buildPremiumFreeTrialOffer({
    plan,
    duration,
    basePrice,
    alreadyRedeemed: Boolean(error) || Boolean(data?.length),
    activeSubscription: Boolean(subError) || isSubscriptionCurrent(sub?.current_period_end ?? null),
  });
}

// ── Plan display config (#1) ──────────────────────────────────────────

export type PlanTier = PaidTier | "enterprise";

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
}

/** Visible plans + prices for the public landing/pricing pages. Service-client read. */
export async function getPublicPricing(): Promise<PublicPlan[]> {
  const [settings, map] = await Promise.all([listPlanSettings(), getPriceMap()]);
  return settings
    .filter((s) => s.visibleOnLanding)
    .map((s) => ({
      tier: s.tier,
      displayName: s.displayName,
      highlight: s.highlight,
      featureLines: s.featureLines,
      price30d: isPaidTier(s.tier) ? map[s.tier]["30d"] : null,
      price1y: isPaidTier(s.tier) ? map[s.tier]["1y"] : null,
    }));
}

export async function setPromotionActive(id: string, active: boolean) {
  const supabase = await createSupabaseServiceClient();
  const { error } = await supabase.from("billing_promotions").update({ active }).eq("id", id);
  if (error) return { ok: false, error: mapError(error) };
  return { ok: true, error: null };
}
