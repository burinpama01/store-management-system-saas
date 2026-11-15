import { z } from "zod";

/**
 * เอกสารเว็บไซต์ร้าน = ธีม + รายการบล็อก
 * ร้านใส่ได้แค่ข้อความ/รูป/ลิงก์ผ่านฟอร์ม — ไม่มี HTML/สคริปต์ (เรนเดอร์เป็นข้อความธรรมดาเสมอ)
 * ทุกครั้งที่บันทึก/เผยแพร่ ต้องผ่าน parseWebsiteDocument() ฝั่ง server
 */

export const WEBSITE_DOCUMENT_VERSION = 1;
export const MAX_BLOCKS = 30;

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, "สีต้องเป็นรหัส #RRGGBB");
const shortText = (max: number) => z.string().trim().max(max);
const blockId = z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/);

/** อนุญาตเฉพาะ https (และ http สำหรับรูปจาก storage dev) — ไม่ให้ javascript:/data: */
export function isSafeUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}
const safeUrl = z.string().trim().max(500).refine(isSafeUrl, "ลิงก์ต้องขึ้นต้นด้วย https:// (หรือ http://)");
const optionalUrl = z.union([z.literal(""), safeUrl]).optional();

export const SOCIAL_PLATFORMS = ["facebook", "instagram", "line", "tiktok", "youtube", "website"] as const;
export const DELIVERY_APPS = ["grab", "lineman", "foodpanda", "robinhood", "shopeefood", "jdc"] as const;
export type DeliveryApp = (typeof DELIVERY_APPS)[number];

/** ลิงก์แอปเดลิเวอรีต้องเป็นโดเมนของแอปนั้นจริง (กันลิงก์ปลอมพาไปเว็บหลอก) */
export const DELIVERY_APP_HOSTS: Record<DeliveryApp, string[]> = {
  grab: ["grab.com", "r.grab.com", "food.grab.com"],
  lineman: ["lineman.line.me", "lin.ee", "line.me", "wongnai.com"],
  foodpanda: ["foodpanda.co.th", "foodpanda.com"],
  robinhood: ["robinhood.in.th"],
  shopeefood: ["shopee.co.th", "shopeefood.co.th", "shp.ee"],
  jdc: ["jdc.co.th", "jdcdelivery.com"],
};

export function isAllowedDeliveryUrl(app: DeliveryApp, value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase();
    return DELIVERY_APP_HOSTS[app].some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
  } catch {
    return false;
  }
}

export const linkTargetSchema = z.object({
  kind: z.enum(["none", "menu", "passes", "member", "url"]),
  url: optionalUrl,
});

const base = { id: blockId, hidden: z.boolean().optional() };

export const heroBlockSchema = z.object({
  ...base,
  type: z.literal("hero"),
  title: shortText(80),
  subtitle: shortText(160),
  imageUrl: optionalUrl,
  showOpenStatus: z.boolean(),
});

export const bannerBlockSchema = z.object({
  ...base,
  type: z.literal("banner"),
  title: shortText(80),
  subtitle: shortText(160),
  imageUrl: optionalUrl,
  link: linkTargetSchema,
  /** YYYY-MM-DD ตามเวลาไทย — ว่าง = แสดงตลอด */
  startsOn: z.union([z.literal(""), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)]).optional(),
  endsOn: z.union([z.literal(""), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)]).optional(),
});

export const passesBlockSchema = z.object({ ...base, type: z.literal("passes"), title: shortText(80) });

export const menuBlockSchema = z.object({
  ...base,
  type: z.literal("menu"),
  title: shortText(80),
  mode: z.enum(["featured", "all"]),
  productIds: z.array(z.string().uuid()).max(24),
  showPrices: z.boolean(),
});

export const memberBlockSchema = z.object({
  ...base,
  type: z.literal("member"),
  title: shortText(80),
  description: shortText(200),
});

export const infoBlockSchema = z.object({
  ...base,
  type: z.literal("info"),
  showAddress: z.boolean(),
  showPhone: z.boolean(),
  hoursText: shortText(200),
  mapUrl: optionalUrl,
});

export const socialBlockSchema = z.object({
  ...base,
  type: z.literal("social"),
  links: z.array(z.object({ platform: z.enum(SOCIAL_PLATFORMS), url: safeUrl })).max(8),
});

export const deliveryAppsBlockSchema = z.object({
  ...base,
  type: z.literal("delivery_apps"),
  title: shortText(80),
  apps: z
    .array(z.object({ app: z.enum(DELIVERY_APPS), url: safeUrl }))
    .max(DELIVERY_APPS.length)
    .refine((apps) => apps.every((entry) => isAllowedDeliveryUrl(entry.app, entry.url)), "ลิงก์แอปเดลิเวอรีต้องเป็นลิงก์ของแอปนั้นจริง"),
});

export const textBlockSchema = z.object({
  ...base,
  type: z.literal("text"),
  title: shortText(80),
  body: shortText(1500),
});

export const blockSchema = z.discriminatedUnion("type", [
  heroBlockSchema,
  bannerBlockSchema,
  passesBlockSchema,
  menuBlockSchema,
  memberBlockSchema,
  infoBlockSchema,
  socialBlockSchema,
  deliveryAppsBlockSchema,
  textBlockSchema,
]);

export const themeSchema = z.object({
  style: z.enum(["minimal", "cute", "luxury"]),
  primary: hex,
  accent: hex,
  background: hex,
  surface: hex,
  text: hex,
  font: z.enum(["sans", "rounded", "serif"]),
  radius: z.enum(["sm", "md", "lg"]),
});

export const websiteDocumentSchema = z.object({
  version: z.literal(WEBSITE_DOCUMENT_VERSION),
  theme: themeSchema,
  blocks: z
    .array(blockSchema)
    .max(MAX_BLOCKS)
    .refine((blocks) => new Set(blocks.map((b) => b.id)).size === blocks.length, "รหัสบล็อกซ้ำ"),
});

export type WebsiteDocument = z.infer<typeof websiteDocumentSchema>;
export type WebsiteBlock = z.infer<typeof blockSchema>;
export type WebsiteTheme = z.infer<typeof themeSchema>;
export type BlockType = WebsiteBlock["type"];

export function parseWebsiteDocument(value: unknown): { data: WebsiteDocument; error: null } | { data: null; error: string } {
  const parsed = websiteDocumentSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { data: null, error: issue ? `ข้อมูลเว็บไม่ถูกต้อง: ${issue.message}` : "ข้อมูลเว็บไม่ถูกต้อง" };
  }
  return { data: parsed.data, error: null };
}

/** slug: a-z 0-9 ขีด, 3–40 ตัว, ห้ามคำสงวนของระบบ */
export const RESERVED_SLUGS = new Set([
  "admin", "api", "app", "login", "logout", "register", "pricing", "pos", "qr", "member", "music", "system",
  "settings", "dashboard", "s", "store", "stores", "storeos", "www", "help", "support", "terms", "privacy",
  "download", "static", "assets", "new", "edit", "preview",
]);

export function normalizeSlug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

export function validateSlug(value: string): string | null {
  if (!/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/.test(value)) return "ลิงก์ร้านใช้ a-z 0-9 และขีด (-) ยาว 3–40 ตัว";
  if (RESERVED_SLUGS.has(value)) return "ชื่อนี้สงวนไว้สำหรับระบบ เลือกชื่ออื่น";
  return null;
}

/** แบนเนอร์แสดงวันนี้ไหม (เวลาไทย) */
export function isBannerActive(block: { startsOn?: string; endsOn?: string }, today: string): boolean {
  if (block.startsOn && today < block.startsOn) return false;
  if (block.endsOn && today > block.endsOn) return false;
  return true;
}
