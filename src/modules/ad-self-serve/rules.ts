/**
 * ลงโฆษณาบนจอร้านผ่าน QR (แผน v1) — กติกาฝั่งร้าน แบบ pure ทดสอบได้
 * เงินค่าโฆษณาเข้าบัญชีร้านโดยตรง · StoreOS เก็บค่าเปิดใช้ฟีเจอร์ (adSelfServe) เท่านั้น
 */
import type { PlanFeatures } from "@/modules/billing/types";

export type StoreAdSlot = "any" | "top" | "bottom";

export interface StoreAdPackage {
  id: string;
  name: string;
  days: number;
  price: number;
}

export interface StoreAdOffer {
  enabled: boolean;
  /** true = จ่ายแล้วขึ้นจอทันที · false = ร้านต้องอนุมัติก่อน */
  autoPublish: boolean;
  slot: StoreAdSlot;
  maxConcurrent: number;
  maxVideoSeconds: number;
  allowVideo: boolean;
  allowImage: boolean;
  terms: string;
  packages: StoreAdPackage[];
  updatedAt?: string;
}

export const STORE_AD_PACKAGE_LIMIT = 6;
export const STORE_AD_TERMS_MAX = 500;

/** แพ็กเริ่มต้นตามแผนที่อนุมัติ — ร้านเปิดสวิตช์แล้วขายได้ทันที (ตรงกับ default ใน migration) */
export const DEFAULT_STORE_AD_PACKAGES: StoreAdPackage[] = [
  { id: "d1", name: "1 วัน", days: 1, price: 59 },
  { id: "d7", name: "7 วัน", days: 7, price: 199 },
  { id: "d30", name: "30 วัน", days: 30, price: 499 },
];

export const DEFAULT_STORE_AD_OFFER: StoreAdOffer = {
  enabled: false,
  autoPublish: true,
  slot: "any",
  maxConcurrent: 3,
  maxVideoSeconds: 60,
  allowVideo: true,
  allowImage: true,
  terms: "ห้ามเนื้อหาผิดกฎหมาย ลามก การพนัน หรือโจมตีผู้อื่น ร้านมีสิทธิ์ถอดโฆษณาที่ผิดเงื่อนไข",
  packages: DEFAULT_STORE_AD_PACKAGES,
};

/** ใช้ฟีเจอร์ได้เมื่อแพ็กมีทั้งรับลงโฆษณาและจอลูกค้า (Enterprise มีครบ · Business ต้องซื้อทั้งคู่) */
export function canUseAdSelfServe(features: Pick<PlanFeatures, "adSelfServe" | "customerDisplay">): boolean {
  return features.adSelfServe && features.customerDisplay;
}

/** ลิงก์ที่ฝังใน QR ของร้าน — หน้าสาธารณะสำหรับผู้ลงโฆษณา (เฟส A2) */
export function buildStoreAdUrl(origin: string, storeSlug: string): string {
  return `${origin.replace(/\/+$/, "")}/ads/${encodeURIComponent(storeSlug)}`;
}

/** ราคาต่ำสุดของร้าน สำหรับข้อความบนโปสเตอร์ ("เริ่ม 59 ฿") */
export function cheapestStoreAdPackage(packages: readonly StoreAdPackage[]): StoreAdPackage | null {
  return packages.reduce<StoreAdPackage | null>((best, pkg) => (!best || pkg.price < best.price ? pkg : best), null);
}

function intIn(value: unknown, min: number, max: number): number | null {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n) || !Number.isInteger(n)) return null;
  return n >= min && n <= max ? n : null;
}

function normalizePackages(value: unknown): { packages: StoreAdPackage[] } | { error: string } {
  if (!Array.isArray(value) || value.length === 0) return { error: "ต้องมีแพ็กอย่างน้อย 1 แพ็ก" };
  if (value.length > STORE_AD_PACKAGE_LIMIT) return { error: `แพ็กได้ไม่เกิน ${STORE_AD_PACKAGE_LIMIT} แพ็ก` };
  const packages: StoreAdPackage[] = [];
  const ids = new Set<string>();
  for (const [index, raw] of value.entries()) {
    const item = (raw ?? {}) as Record<string, unknown>;
    const name = typeof item.name === "string" ? item.name.trim().slice(0, 40) : "";
    if (!name) return { error: `แพ็กที่ ${index + 1}: กรอกชื่อแพ็ก` };
    const days = intIn(item.days, 1, 365);
    if (days === null) return { error: `แพ็ก "${name}": จำนวนวันต้องเป็นเลขเต็ม 1–365` };
    const priceNum = typeof item.price === "string" ? Number(item.price) : item.price;
    if (typeof priceNum !== "number" || !Number.isFinite(priceNum) || priceNum < 1 || priceNum > 100_000) {
      return { error: `แพ็ก "${name}": ราคาต้องอยู่ระหว่าง 1–100,000 บาท` };
    }
    const price = Math.round(priceNum * 100) / 100;
    let id = typeof item.id === "string" ? item.id.trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24) : "";
    if (!id || ids.has(id)) id = `p${index + 1}-${days}d`;
    while (ids.has(id)) id = `${id}x`;
    ids.add(id);
    packages.push({ id, name, days, price });
  }
  return { packages };
}

/** ตรวจ/ทำความสะอาดค่าที่ร้านส่งมาจากหน้าตั้งค่า */
export function normalizeStoreAdOfferInput(input: Record<string, unknown>): { offer: StoreAdOffer } | { error: string } {
  const slot: StoreAdSlot = input.slot === "top" || input.slot === "bottom" ? input.slot : "any";
  const maxConcurrent = intIn(input.maxConcurrent, 1, 12);
  if (maxConcurrent === null) return { error: "จำนวนโฆษณาพร้อมกันต้องเป็น 1–12" };
  const maxVideoSeconds = intIn(input.maxVideoSeconds, 5, 600);
  if (maxVideoSeconds === null) return { error: "ความยาววิดีโอสูงสุดต้องเป็น 5–600 วินาที" };
  const allowVideo = input.allowVideo === true;
  const allowImage = input.allowImage === true;
  if (!allowVideo && !allowImage) return { error: "ต้องรับอย่างน้อยรูปหรือวิดีโอ" };
  const terms = typeof input.terms === "string" ? input.terms.trim().slice(0, STORE_AD_TERMS_MAX) : "";
  if (!terms) return { error: "กรอกเงื่อนไขการลงโฆษณา" };
  const packagesResult = normalizePackages(input.packages);
  if ("error" in packagesResult) return packagesResult;
  return {
    offer: {
      enabled: input.enabled === true,
      autoPublish: input.autoPublish !== false,
      slot,
      maxConcurrent,
      maxVideoSeconds,
      allowVideo,
      allowImage,
      terms,
      packages: packagesResult.packages,
    },
  };
}

/** แปลงแถวจากฐานข้อมูล (ข้อมูลเก่า/เสียต้องไม่ทำหน้าพัง → ถอยไปค่าเริ่มต้นทีละช่อง) */
export function mapStoreAdOfferRow(row: Record<string, unknown> | null | undefined): StoreAdOffer {
  if (!row) return DEFAULT_STORE_AD_OFFER;
  const packages = normalizePackages(row.packages);
  return {
    enabled: row.enabled === true,
    autoPublish: row.auto_publish !== false,
    slot: row.slot === "top" || row.slot === "bottom" ? row.slot : "any",
    maxConcurrent: intIn(row.max_concurrent, 1, 12) ?? DEFAULT_STORE_AD_OFFER.maxConcurrent,
    maxVideoSeconds: intIn(row.max_video_seconds, 5, 600) ?? DEFAULT_STORE_AD_OFFER.maxVideoSeconds,
    allowVideo: row.allow_video !== false,
    allowImage: row.allow_image !== false,
    terms: typeof row.terms === "string" && row.terms.trim() ? row.terms : DEFAULT_STORE_AD_OFFER.terms,
    packages: "packages" in packages ? packages.packages : DEFAULT_STORE_AD_PACKAGES,
    updatedAt: typeof row.updated_at === "string" ? row.updated_at : undefined,
  };
}
