import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import { mapError } from "@/shared/utils/error";
import {
  DURATION_PRICES,
  isPaidTier,
  type BillingDuration,
  type PaidTier,
} from "./pricing";

export interface Promotion {
  id: string;
  description: string;
  percentOff: number;
  active: boolean;
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

async function getActivePromotion(): Promise<Promotion | null> {
  const supabase = await createSupabaseServiceClient();
  const { data } = await supabase
    .from("billing_promotions")
    .select("id, description, percent_off, active, starts_at, ends_at")
    .eq("active", true);
  const rows: Promotion[] = (data ?? []).map((p) => ({
    id: p.id,
    description: p.description,
    percentOff: p.percent_off,
    active: p.active,
    startsAt: p.starts_at,
    endsAt: p.ends_at,
  }));
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
  const [map, promo] = await Promise.all([getPriceMap(), getActivePromotion()]);
  const base = map[plan as PaidTier][duration];
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
    .select("id, description, percent_off, active, starts_at, ends_at")
    .order("created_at", { ascending: false });
  return (data ?? []).map((p) => ({
    id: p.id,
    description: p.description,
    percentOff: p.percent_off,
    active: p.active,
    startsAt: p.starts_at,
    endsAt: p.ends_at,
  }));
}

export async function createPromotion(input: {
  description: string;
  percentOff: number;
  startsAt: string | null;
  endsAt: string | null;
}) {
  const supabase = await createSupabaseServiceClient();
  const { error } = await supabase.from("billing_promotions").insert({
    description: input.description,
    percent_off: input.percentOff,
    active: true,
    starts_at: input.startsAt,
    ends_at: input.endsAt,
  });
  if (error) return { ok: false, error: mapError(error) };
  return { ok: true, error: null };
}

export async function setPromotionActive(id: string, active: boolean) {
  const supabase = await createSupabaseServiceClient();
  const { error } = await supabase.from("billing_promotions").update({ active }).eq("id", id);
  if (error) return { ok: false, error: mapError(error) };
  return { ok: true, error: null };
}
