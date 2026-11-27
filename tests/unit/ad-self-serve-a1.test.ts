import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BUSINESS_DEFAULT_PRICES } from "@/modules/billing/business-plan";
import { BUSINESS_SELECTABLE_FEATURES, getPlanFeatures } from "@/modules/billing/types";
import {
  DEFAULT_STORE_AD_OFFER,
  buildStoreAdUrl,
  canUseAdSelfServe,
  cheapestStoreAdPackage,
  mapStoreAdOfferRow,
  normalizeStoreAdOfferInput,
} from "@/modules/ad-self-serve/rules";
import { storeAdErrorMessage } from "@/modules/ad-self-serve/repository";

const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8");

const validInput = {
  enabled: true,
  autoPublish: true,
  slot: "any",
  maxConcurrent: 3,
  maxVideoSeconds: 60,
  allowVideo: true,
  allowImage: true,
  terms: "ห้ามเนื้อหาผิดกฎหมาย",
  packages: [
    { id: "d1", name: "1 วัน", days: 1, price: 59 },
    { id: "d7", name: "7 วัน", days: 7, price: 199 },
  ],
};

describe("adSelfServe entitlement", () => {
  it("is free on Enterprise and a 200 THB/month Business add-on, off elsewhere", () => {
    const base = { status: "active" as const, currentPeriodEnd: "2099-12-31T00:00:00Z", cancelAtPeriodEnd: false, trialEnd: null };
    expect(getPlanFeatures({ ...base, plan: "enterprise" }).adSelfServe).toBe(true);
    for (const plan of ["free", "starter", "standard", "premium"] as const) {
      expect(getPlanFeatures({ ...base, plan }).adSelfServe).toBe(false);
    }
    expect(BUSINESS_SELECTABLE_FEATURES).toContain("adSelfServe");
    expect(BUSINESS_DEFAULT_PRICES.adSelfServe["30d"]).toBe(200);
  });

  it("requires the customer display too", () => {
    expect(canUseAdSelfServe({ adSelfServe: true, customerDisplay: true })).toBe(true);
    expect(canUseAdSelfServe({ adSelfServe: true, customerDisplay: false })).toBe(false);
    expect(canUseAdSelfServe({ adSelfServe: false, customerDisplay: true })).toBe(false);
  });
});

describe("store ad offer rules", () => {
  it("defaults to off, auto-publish, 3 slots, 60s videos and the approved 59/199/499 packages", () => {
    expect(DEFAULT_STORE_AD_OFFER.enabled).toBe(false);
    expect(DEFAULT_STORE_AD_OFFER.autoPublish).toBe(true);
    expect(DEFAULT_STORE_AD_OFFER.maxConcurrent).toBe(3);
    expect(DEFAULT_STORE_AD_OFFER.maxVideoSeconds).toBe(60);
    expect(DEFAULT_STORE_AD_OFFER.packages.map((p) => [p.days, p.price])).toEqual([[1, 59], [7, 199], [30, 499]]);
  });

  it("accepts a valid offer", () => {
    const result = normalizeStoreAdOfferInput(validInput);
    expect("offer" in result && result.offer.packages).toHaveLength(2);
  });

  it("rejects bad packages and limits", () => {
    expect(normalizeStoreAdOfferInput({ ...validInput, packages: [] })).toEqual({ error: "ต้องมีแพ็กอย่างน้อย 1 แพ็ก" });
    expect("error" in normalizeStoreAdOfferInput({ ...validInput, packages: [{ name: "x", days: 0, price: 10 }] })).toBe(true);
    expect("error" in normalizeStoreAdOfferInput({ ...validInput, packages: [{ name: "x", days: 1.5, price: 10 }] })).toBe(true);
    expect("error" in normalizeStoreAdOfferInput({ ...validInput, packages: [{ name: "x", days: 1, price: 0 }] })).toBe(true);
    expect("error" in normalizeStoreAdOfferInput({ ...validInput, packages: [{ name: "", days: 1, price: 10 }] })).toBe(true);
    expect("error" in normalizeStoreAdOfferInput({ ...validInput, maxConcurrent: 13 })).toBe(true);
    expect("error" in normalizeStoreAdOfferInput({ ...validInput, maxVideoSeconds: 4 })).toBe(true);
    expect("error" in normalizeStoreAdOfferInput({ ...validInput, allowVideo: false, allowImage: false })).toBe(true);
    expect("error" in normalizeStoreAdOfferInput({ ...validInput, terms: "  " })).toBe(true);
  });

  it("de-duplicates package ids and rounds prices to satang", () => {
    const result = normalizeStoreAdOfferInput({
      ...validInput,
      packages: [
        { id: "same", name: "A", days: 1, price: 59.999 },
        { id: "same", name: "B", days: 7, price: 199 },
      ],
    });
    if (!("offer" in result)) throw new Error("expected offer");
    expect(new Set(result.offer.packages.map((p) => p.id)).size).toBe(2);
    expect(result.offer.packages[0].price).toBe(60);
  });

  it("falls back to defaults for broken rows instead of crashing the page", () => {
    expect(mapStoreAdOfferRow(null)).toEqual(DEFAULT_STORE_AD_OFFER);
    const mapped = mapStoreAdOfferRow({ enabled: true, packages: "oops", max_concurrent: 99 });
    expect(mapped.enabled).toBe(true);
    expect(mapped.packages).toEqual(DEFAULT_STORE_AD_OFFER.packages);
    expect(mapped.maxConcurrent).toBe(3);
  });

  it("builds the QR link and the poster price line", () => {
    expect(buildStoreAdUrl("https://www.store-os.online/", "proud cafe")).toBe("https://www.store-os.online/ads/proud%20cafe");
    expect(cheapestStoreAdPackage(DEFAULT_STORE_AD_OFFER.packages)?.price).toBe(59);
    expect(cheapestStoreAdPackage([])).toBeNull();
  });
});

describe("A1 wiring", () => {
  const migration = read("supabase/migrations/20261216120000_store_ad_self_serve_a1.sql");
  const action = read("src/app/(dashboard)/settings/ad-self-serve/actions.ts");
  const tabs = read("src/app/(dashboard)/settings/settings-tabs.ts");

  it("creates both tables with RLS, switch off by default, and no public insert policy", () => {
    expect(migration).toContain("create table if not exists public.store_ad_offers");
    expect(migration).toContain("create table if not exists public.store_ad_orders");
    expect(migration).toContain("alter table public.store_ad_offers enable row level security");
    expect(migration).toContain("alter table public.store_ad_orders enable row level security");
    expect(migration).toContain("enabled boolean not null default false");
    expect(migration).not.toMatch(/on public\.store_ad_orders for insert/);
    expect(migration).toContain('"price":59');
    // ไม่ใช้ for all บน offers (ลบแถวทิ้งไม่ได้) และสถานะจ่ายแล้วต้องมี paid_at
    expect(migration).not.toMatch(/on public\.store_ad_offers for all/);
    expect(migration).toContain("check (status in ('pending_payment', 'cancelled') or paid_at is not null)");
    expect(migration).toContain("payment_ref text");
    expect(migration).toContain("status_reason text");
  });

  it("maps DB errors to Thai messages", () => {
    expect(storeAdErrorMessage("new row violates row-level security policy")).toContain("ไม่มีสิทธิ์");
    expect(storeAdErrorMessage('violates check constraint "x"')).toBe("ข้อมูลไม่ถูกต้องตามเงื่อนไข");
    expect(storeAdErrorMessage('relation "public.store_ad_offers" does not exist')).toContain("ยังไม่พร้อม");
  });

  it("guards the save action and logs it", () => {
    expect(action).toContain('resolved.can("settings.manage_store")');
    expect(action).toContain("canUseAdSelfServe(getPlanFeatures(billing))");
    expect(action).toContain("logSystemEvent");
  });

  it("adds a gated settings tab", () => {
    expect(tabs).toContain('{ href: "/settings/ad-self-serve", label: "รับลงโฆษณา", featureKey: "adSelfServe" }');
  });
});
