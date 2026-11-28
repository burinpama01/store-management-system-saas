export type CustomerDisplayAdLayout = "single" | "split";
export type CustomerDisplayAdSlot = "top" | "bottom";
export type CustomerDisplayMediaType = "image" | "video";
export type CustomerDisplayMediaFit = "cover" | "contain";

export interface CustomerDisplayAdSlide {
  id: string;
  slot: CustomerDisplayAdSlot;
  mediaType: CustomerDisplayMediaType;
  url: string;
  title?: string;
  description?: string;
  fit: CustomerDisplayMediaFit;
}

export interface CustomerDisplaySettings {
  id?: string;
  organizationId?: string;
  storeId?: string;
  adEnabled: boolean;
  adLayout: CustomerDisplayAdLayout;
  topSlotEnabled: boolean;
  bottomSlotEnabled: boolean;
  slideIntervalSeconds: number;
  topSlides: CustomerDisplayAdSlide[];
  bottomSlides: CustomerDisplayAdSlide[];
  updatedAt?: string;
}

export interface CustomerDisplaySettingsInput {
  adEnabled?: boolean;
  adLayout?: string | null;
  topSlotEnabled?: boolean;
  bottomSlotEnabled?: boolean;
  slideIntervalSeconds?: number;
  topSlides?: unknown;
  bottomSlides?: unknown;
}

export const CUSTOMER_DISPLAY_SLIDE_LIMIT = 12;
export const CUSTOMER_DISPLAY_DEFAULT_INTERVAL_SECONDS = 8;

export const DEFAULT_CUSTOMER_DISPLAY_SETTINGS: CustomerDisplaySettings = {
  adEnabled: true,
  adLayout: "single",
  topSlotEnabled: true,
  bottomSlotEnabled: true,
  slideIntervalSeconds: CUSTOMER_DISPLAY_DEFAULT_INTERVAL_SECONDS,
  topSlides: [],
  bottomSlides: [],
};

export function normalizeCustomerDisplaySettingsInput(input: CustomerDisplaySettingsInput = {}): CustomerDisplaySettings {
  const adLayout: CustomerDisplayAdLayout = input.adLayout === "split" ? "split" : "single";
  const slideIntervalSeconds = Number.isFinite(input.slideIntervalSeconds)
    ? Math.min(60, Math.max(3, Math.round(Number(input.slideIntervalSeconds))))
    : CUSTOMER_DISPLAY_DEFAULT_INTERVAL_SECONDS;

  return {
    adEnabled: input.adEnabled ?? true,
    adLayout,
    topSlotEnabled: input.topSlotEnabled ?? true,
    bottomSlotEnabled: input.bottomSlotEnabled ?? true,
    slideIntervalSeconds,
    topSlides: normalizeSlides(input.topSlides, "top"),
    bottomSlides: normalizeSlides(input.bottomSlides, "bottom"),
  };
}

export function normalizeSlides(value: unknown, slot: CustomerDisplayAdSlot): CustomerDisplayAdSlide[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item, index) => normalizeSlide(item, slot, index))
    .filter((item): item is CustomerDisplayAdSlide => item !== null)
    .slice(0, CUSTOMER_DISPLAY_SLIDE_LIMIT);
}

function normalizeSlide(value: unknown, slot: CustomerDisplayAdSlot, index: number): CustomerDisplayAdSlide | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const url = normalizeMediaUrl(source.url);
  if (!url) return null;
  const mediaType: CustomerDisplayMediaType = source.mediaType === "video" ? "video" : "image";
  const fit: CustomerDisplayMediaFit = source.fit === "contain" ? "contain" : "cover";
  const id = normalizeText(source.id, 80) || `${slot}-${index + 1}`;
  const title = normalizeText(source.title, 80);
  const description = normalizeText(source.description, 160);
  return {
    id,
    slot,
    mediaType,
    url,
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    fit,
  };
}

function normalizeText(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function normalizeMediaUrl(value: unknown) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("/")) return trimmed.slice(0, 500);
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    return url.toString().slice(0, 500);
  } catch {
    return "";
  }
}

// ── จอลูกค้า: ดึงโฆษณาใหม่ / ข้ามสื่อเสีย / จำกัดขนาดไฟล์ ─────────────────────

/** จอลูกค้าถามโฆษณาล่าสุดทุก 5 นาที (และทุกครั้งที่กลับมาเห็นหน้า) — ร้านแก้โฆษณาแล้วไม่ต้องรีเฟรชจอเอง */
export const CUSTOMER_DISPLAY_REFRESH_MS = 5 * 60 * 1000;

/** จำกัดขนาดไฟล์ก่อนอัปโหลด — วิดีโอเล่นวนตลอดวัน ไฟล์ใหญ่ = กินโควตา egress */
export const CUSTOMER_DISPLAY_VIDEO_MAX_BYTES = 50 * 1024 * 1024;
export const CUSTOMER_DISPLAY_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

/** ชื่อไฟล์เป็น UUID ไม่ถูกเขียนทับ → ให้เบราว์เซอร์แคชได้ 1 ปี ไม่ต้องโหลดใหม่ทุกรอบสไลด์ */
export const CUSTOMER_DISPLAY_MEDIA_CACHE_SECONDS = 31_536_000;

/** วิดีโอสลับเมื่อเล่นจบ (event ended) — ตัวจับเวลานี้เป็นแค่ตาข่ายกันจอค้างถ้า ended ไม่มา (เน็ตกระตุก/ไฟล์เสียกลางทาง) */
export const CUSTOMER_DISPLAY_VIDEO_FALLBACK_MS = 15 * 60 * 1000;
const CUSTOMER_DISPLAY_VIDEO_GRACE_MS = 15_000;

/**
 * สไลด์นี้ค้างบนจอนานเท่าไรก่อนสลับ (ใช้เมื่อช่องมีมากกว่า 1 สไลด์)
 * - รูป: ตาม "เปลี่ยนภาพทุกกี่วินาที"
 * - วิดีโอ: เล่นจนจบ (ไม่ตัดตามวินาที) — รู้ความยาวแล้วกันเผื่อ 15 วิ, ยังไม่รู้ใช้ 15 นาที
 */
export function customerDisplaySlideDwellMs(
  slide: Pick<CustomerDisplayAdSlide, "mediaType">,
  intervalSeconds: number,
  videoDurationMs?: number | null,
): number {
  if (slide.mediaType !== "video") return Math.max(1, intervalSeconds) * 1000;
  if (videoDurationMs && Number.isFinite(videoDurationMs) && videoDurationMs > 0) {
    return Math.min(videoDurationMs + CUSTOMER_DISPLAY_VIDEO_GRACE_MS, CUSTOMER_DISPLAY_VIDEO_FALLBACK_MS * 4);
  }
  return CUSTOMER_DISPLAY_VIDEO_FALLBACK_MS;
}

export function customerDisplayUploadSizeError(mediaType: CustomerDisplayMediaType, sizeBytes: number): string | null {
  const limit = mediaType === "video" ? CUSTOMER_DISPLAY_VIDEO_MAX_BYTES : CUSTOMER_DISPLAY_IMAGE_MAX_BYTES;
  if (!Number.isFinite(sizeBytes) || sizeBytes <= limit) return null;
  const limitMb = Math.round(limit / (1024 * 1024));
  const sizeMb = (sizeBytes / (1024 * 1024)).toFixed(1);
  return mediaType === "video"
    ? `วิดีโอใหญ่เกินไป (${sizeMb} MB) — จำกัด ${limitMb} MB ลองลดความละเอียดเป็น 720p หรือบีบอัดไฟล์`
    : `รูปใหญ่เกินไป (${sizeMb} MB) — จำกัด ${limitMb} MB`;
}

/** ลายเซ็นของเนื้อหาโฆษณา — ใช้เช็กว่าค่าที่ดึงมาใหม่ต่างจากที่จอแสดงอยู่หรือไม่ */
export function customerDisplaySettingsSignature(settings: CustomerDisplaySettings | null | undefined): string {
  const s = settings ?? DEFAULT_CUSTOMER_DISPLAY_SETTINGS;
  return JSON.stringify([
    s.adEnabled,
    s.adLayout,
    s.topSlotEnabled,
    s.bottomSlotEnabled,
    s.slideIntervalSeconds,
    s.topSlides,
    s.bottomSlides,
  ]);
}

export interface CustomerDisplayAdSlotView {
  key: "single" | "top" | "bottom";
  label: string;
  slides: CustomerDisplayAdSlide[];
}

/**
 * แปลงค่าตั้งค่าเป็นช่องโฆษณาที่จะแสดง โดยตัดสไลด์ที่สื่อโหลดไม่ขึ้น (failedUrls) ออก
 * ช่องที่ไม่เหลือสไลด์จะไม่แสดง — ไม่ให้ลูกค้าเห็นภาพแตก
 */
export function resolveCustomerDisplayAdSlots(
  settings: CustomerDisplaySettings,
  failedUrls: ReadonlySet<string> = new Set(),
): CustomerDisplayAdSlotView[] {
  if (!settings.adEnabled) return [];
  if (!settings.topSlotEnabled && !settings.bottomSlotEnabled) return [];
  const playable = (slides: CustomerDisplayAdSlide[]) => slides.filter((slide) => !failedUrls.has(slide.url));
  const top = settings.topSlotEnabled ? playable(settings.topSlides) : [];
  const bottom = settings.bottomSlotEnabled ? playable(settings.bottomSlides) : [];
  if (settings.adLayout === "split") {
    const slots: CustomerDisplayAdSlotView[] = [
      { key: "top", label: "ช่องบน", slides: top },
      { key: "bottom", label: "ช่องล่าง", slides: bottom },
    ];
    return slots.filter((slot) => slot.slides.length > 0);
  }
  const slides = [...top, ...bottom];
  return slides.length > 0 ? [{ key: "single", label: "โปรโมชัน", slides }] : [];
}

// ── จอลูกค้าว่าง → โฆษณาเต็มจอ ─────────────────────────────────────────────

/** ไม่มีการทำรายการนานเท่านี้ จอลูกค้าสลับเป็นโฆษณาเต็มจอ (600 วินาที = 10 นาที) */
export const CUSTOMER_DISPLAY_IDLE_AD_MS = 600 * 1000;

/** ข้อมูลจาก POS ที่จอใช้ตัดสินว่ามีการทำรายการหรือไม่ (ส่วนหนึ่งของ CustomerDisplaySnapshot) */
export interface CustomerDisplayActivitySource {
  status: "idle" | "scanning" | "checkout" | "paid";
  items: ReadonlyArray<{ name: string; quantity: number; totalPrice: number }>;
  total: number;
  payment?: { amount: number } | null;
  customer?: { name?: string } | null;
  customerName?: string;
}

/**
 * ลายเซ็นของ "การทำรายการ" — เปลี่ยนเมื่อสถานะ/ตะกร้า/ยอด/QR/ลูกค้าเปลี่ยนเท่านั้น
 * POS อาจส่งสถานะเดิมซ้ำ (re-render) — ข้อความซ้ำที่เนื้อหาเท่าเดิมไม่นับเป็นการทำรายการ
 */
export function customerDisplayActivityKey(snapshot: CustomerDisplayActivitySource | null | undefined): string {
  if (!snapshot) return "none";
  return JSON.stringify([
    snapshot.status,
    snapshot.total,
    snapshot.items.map((item) => [item.name, item.quantity, item.totalPrice]),
    snapshot.payment?.amount ?? null,
    snapshot.customer?.name ?? snapshot.customerName ?? null,
  ]);
}

/**
 * เข้าโหมดโฆษณาเต็มจอได้เฉพาะตอนไม่มีลูกค้ากำลังทำรายการ
 * (ว่าง / จ่ายเสร็จแล้ว / ยังไม่เคยได้ข้อมูลจาก POS) — ตะกร้าค้างหรือรอจ่าย QR ห้ามบังรายการ
 */
export function canEnterCustomerDisplayIdleAd(snapshot: CustomerDisplayActivitySource | null | undefined): boolean {
  if (!snapshot) return true;
  return snapshot.status === "idle" || snapshot.status === "paid";
}

/** โหมดเต็มจอรวมสไลด์ทุกช่องที่เปิดไว้เป็นชุดเดียว */
export function resolveCustomerDisplayFullscreenSlides(
  settings: CustomerDisplaySettings,
  failedUrls: ReadonlySet<string> = new Set(),
): CustomerDisplayAdSlotView | null {
  const [slot] = resolveCustomerDisplayAdSlots({ ...settings, adLayout: "single" }, failedUrls);
  return slot ? { ...slot, label: "โฆษณาเต็มจอ" } : null;
}
