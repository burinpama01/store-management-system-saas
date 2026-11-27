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
export const CUSTOMER_DISPLAY_VIDEO_MAX_BYTES = 30 * 1024 * 1024;
export const CUSTOMER_DISPLAY_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

/** ชื่อไฟล์เป็น UUID ไม่ถูกเขียนทับ → ให้เบราว์เซอร์แคชได้ 1 ปี ไม่ต้องโหลดใหม่ทุกรอบสไลด์ */
export const CUSTOMER_DISPLAY_MEDIA_CACHE_SECONDS = 31_536_000;

export function customerDisplayUploadSizeError(mediaType: CustomerDisplayMediaType, sizeBytes: number): string | null {
  const limit = mediaType === "video" ? CUSTOMER_DISPLAY_VIDEO_MAX_BYTES : CUSTOMER_DISPLAY_IMAGE_MAX_BYTES;
  if (!Number.isFinite(sizeBytes) || sizeBytes <= limit) return null;
  const limitMb = Math.round(limit / (1024 * 1024));
  const sizeMb = (sizeBytes / (1024 * 1024)).toFixed(1);
  return mediaType === "video"
    ? `วิดีโอใหญ่เกินไป (${sizeMb} MB) — จำกัด ${limitMb} MB ลองตัดให้สั้นลงหรือลดความละเอียดเป็น 720p`
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
