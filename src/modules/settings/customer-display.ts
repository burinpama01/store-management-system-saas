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
