import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CUSTOMER_DISPLAY_IMAGE_MAX_BYTES,
  CUSTOMER_DISPLAY_VIDEO_MAX_BYTES,
  DEFAULT_CUSTOMER_DISPLAY_SETTINGS,
  CUSTOMER_DISPLAY_IDLE_AD_MS,
  CUSTOMER_DISPLAY_VIDEO_FALLBACK_MS,
  canEnterCustomerDisplayIdleAd,
  customerDisplayActivityKey,
  customerDisplaySettingsSignature,
  customerDisplaySlideDwellMs,
  customerDisplayUploadSizeError,
  resolveCustomerDisplayAdSlots,
  resolveCustomerDisplayFullscreenSlides,
  type CustomerDisplayAdSlide,
  type CustomerDisplaySettings,
} from "@/modules/settings/customer-display";

const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8");

function slide(slot: "top" | "bottom", url: string, mediaType: "image" | "video" = "image"): CustomerDisplayAdSlide {
  return { id: url, slot, url, mediaType, fit: "cover" };
}

function settings(patch: Partial<CustomerDisplaySettings> = {}): CustomerDisplaySettings {
  return {
    ...DEFAULT_CUSTOMER_DISPLAY_SETTINGS,
    topSlides: [slide("top", "https://cdn.test/a.jpg"), slide("top", "https://cdn.test/b.jpg")],
    bottomSlides: [slide("bottom", "https://cdn.test/c.mp4", "video")],
    ...patch,
  };
}

describe("resolveCustomerDisplayAdSlots", () => {
  it("merges both slots into one panel in single layout", () => {
    const slots = resolveCustomerDisplayAdSlots(settings());
    expect(slots).toHaveLength(1);
    expect(slots[0].key).toBe("single");
    expect(slots[0].slides.map((s) => s.url)).toEqual([
      "https://cdn.test/a.jpg",
      "https://cdn.test/b.jpg",
      "https://cdn.test/c.mp4",
    ]);
  });

  it("skips media that failed to load instead of showing a broken image", () => {
    const slots = resolveCustomerDisplayAdSlots(settings(), new Set(["https://cdn.test/a.jpg"]));
    expect(slots[0].slides.map((s) => s.url)).not.toContain("https://cdn.test/a.jpg");
    expect(slots[0].slides).toHaveLength(2);
  });

  it("hides a split slot whose every slide failed", () => {
    const slots = resolveCustomerDisplayAdSlots(
      settings({ adLayout: "split" }),
      new Set(["https://cdn.test/c.mp4"]),
    );
    expect(slots.map((s) => s.key)).toEqual(["top"]);
  });

  it("hides the whole ad panel when nothing is playable or ads are off", () => {
    const all = new Set(["https://cdn.test/a.jpg", "https://cdn.test/b.jpg", "https://cdn.test/c.mp4"]);
    expect(resolveCustomerDisplayAdSlots(settings(), all)).toEqual([]);
    expect(resolveCustomerDisplayAdSlots(settings({ adEnabled: false }))).toEqual([]);
    expect(resolveCustomerDisplayAdSlots(settings({ topSlotEnabled: false, bottomSlotEnabled: false }))).toEqual([]);
  });

  it("respects disabled slots", () => {
    const slots = resolveCustomerDisplayAdSlots(settings({ adLayout: "split", topSlotEnabled: false }));
    expect(slots.map((s) => s.key)).toEqual(["bottom"]);
  });
});

describe("customerDisplaySettingsSignature", () => {
  it("changes only when ad content changes", () => {
    const base = settings();
    expect(customerDisplaySettingsSignature({ ...base, updatedAt: "x", id: "y" })).toBe(
      customerDisplaySettingsSignature(base),
    );
    expect(customerDisplaySettingsSignature({ ...base, slideIntervalSeconds: 20 })).not.toBe(
      customerDisplaySettingsSignature(base),
    );
    expect(customerDisplaySettingsSignature(null)).toBe(
      customerDisplaySettingsSignature(DEFAULT_CUSTOMER_DISPLAY_SETTINGS),
    );
  });
});

describe("customerDisplayUploadSizeError", () => {
  it("blocks oversized video and image uploads with a Thai message", () => {
    expect(customerDisplayUploadSizeError("video", CUSTOMER_DISPLAY_VIDEO_MAX_BYTES)).toBeNull();
    expect(customerDisplayUploadSizeError("video", CUSTOMER_DISPLAY_VIDEO_MAX_BYTES + 1)).toContain("วิดีโอใหญ่เกินไป");
    expect(customerDisplayUploadSizeError("image", CUSTOMER_DISPLAY_IMAGE_MAX_BYTES)).toBeNull();
    expect(customerDisplayUploadSizeError("image", CUSTOMER_DISPLAY_IMAGE_MAX_BYTES + 1)).toContain("รูปใหญ่เกินไป");
  });
});

describe("customerDisplaySlideDwellMs", () => {
  it("rotates images by the configured interval", () => {
    expect(customerDisplaySlideDwellMs({ mediaType: "image" }, 8)).toBe(8000);
  });

  it("lets long videos (over 2 minutes) play to the end instead of cutting at the interval", () => {
    const threeMinutes = 3 * 60 * 1000;
    const dwell = customerDisplaySlideDwellMs({ mediaType: "video" }, 8, threeMinutes);
    expect(dwell).toBeGreaterThan(threeMinutes);
    expect(dwell).toBeLessThan(threeMinutes + 60_000);
  });

  it("falls back to a long safety timer when the video length is unknown", () => {
    expect(customerDisplaySlideDwellMs({ mediaType: "video" }, 8, null)).toBe(CUSTOMER_DISPLAY_VIDEO_FALLBACK_MS);
    expect(customerDisplaySlideDwellMs({ mediaType: "video" }, 8, Number.NaN)).toBe(CUSTOMER_DISPLAY_VIDEO_FALLBACK_MS);
  });
});

describe("idle fullscreen ad mode", () => {
  const idle = { status: "idle" as const, items: [], total: 0 };
  const scanning = {
    status: "scanning" as const,
    items: [{ name: "ลาเต้", quantity: 1, totalPrice: 60 }],
    total: 60,
  };

  it("switches after 600 seconds", () => {
    expect(CUSTOMER_DISPLAY_IDLE_AD_MS).toBe(600_000);
  });

  it("only enters when no customer is mid-transaction", () => {
    expect(canEnterCustomerDisplayIdleAd(null)).toBe(true);
    expect(canEnterCustomerDisplayIdleAd(idle)).toBe(true);
    expect(canEnterCustomerDisplayIdleAd({ ...scanning, status: "paid" })).toBe(true);
    expect(canEnterCustomerDisplayIdleAd(scanning)).toBe(false);
    expect(canEnterCustomerDisplayIdleAd({ ...scanning, status: "checkout" })).toBe(false);
  });

  it("treats repeated identical POS messages as no activity", () => {
    expect(customerDisplayActivityKey({ ...idle })).toBe(customerDisplayActivityKey({ ...idle }));
    expect(customerDisplayActivityKey(scanning)).not.toBe(customerDisplayActivityKey(idle));
    expect(
      customerDisplayActivityKey({ ...scanning, items: [{ name: "ลาเต้", quantity: 2, totalPrice: 120 }], total: 120 }),
    ).not.toBe(customerDisplayActivityKey(scanning));
  });

  it("merges every enabled slot into one fullscreen rotation", () => {
    const slot = resolveCustomerDisplayFullscreenSlides(settings({ adLayout: "split" }));
    expect(slot?.slides).toHaveLength(3);
    expect(resolveCustomerDisplayFullscreenSlides(settings({ adEnabled: false }))).toBeNull();
    expect(resolveCustomerDisplayFullscreenSlides(settings({ topSlides: [], bottomSlides: [] }))).toBeNull();
  });
});

describe("customer display screen wiring", () => {
  const screen = read("src/app/pos/grocery/display/CustomerDisplayScreen.tsx");
  const route = read("src/app/api/pos/customer-display/settings/route.ts");
  const form = read("src/app/(dashboard)/settings/customer-display/CustomerDisplaySettingsForm.tsx");

  it("polls the latest ad settings and keeps the screen awake", () => {
    expect(screen).toContain("/api/pos/customer-display/settings");
    expect(screen).toContain("CUSTOMER_DISPLAY_REFRESH_MS");
    expect(screen).toContain("visibilitychange");
    expect(screen).toContain("useWakeLock(true)");
  });

  it("advances video slides when they end and only loops a lone video", () => {
    expect(screen).toContain("onEnded={rotates ? advance : undefined}");
    expect(screen).toContain("loop={!rotates}");
    expect(screen).toContain("onLoadedMetadata");
    expect(screen).toContain("customerDisplaySlideDwellMs(slide, intervalSeconds, videoDurationMs)");
  });

  it("shows fullscreen ads after idle and returns on POS activity or touch", () => {
    expect(screen).toContain("idleAdMs = CUSTOMER_DISPLAY_IDLE_AD_MS");
    expect(screen).toContain("canEnterCustomerDisplayIdleAd(snapshot)");
    expect(screen).toContain("activityKey !== activityKeyRef.current");
    expect(screen).toContain('window.addEventListener("pointerdown", onPointer)');
    expect(screen).toContain("customer-display-idle-ad");
  });

  it("skips and reports broken media", () => {
    expect(screen).toContain("onError={() => onMediaError(slide)}");
    expect(screen).toContain("resolveCustomerDisplayAdSlots(effectiveAdSettings, failedMediaUrls)");
    expect(route).toContain("logSystemEvent");
    expect(route).toContain("reportCustomerDisplayMediaError");
  });

  it("guards the settings endpoint without redirecting the display to /login", () => {
    expect(route).toContain("getOptionalResolvedCurrentPermissions");
    expect(route).toContain('can("pos.use")');
    expect(route).toContain('requireFeature("customerDisplay")');
    expect(route).toContain("status: 401");
    expect(route).not.toContain("requirePermission(");
    // สิทธิ์โหลดล้ม (ลาออก/ไม่มี membership) ต้องได้ 401 ไม่ใช่ 500
    expect(route).toMatch(/try \{\s*permissions = await getOptionalResolvedCurrentPermissions\(\);\s*\} catch/);
    // รับ log เฉพาะลิงก์สื่อจริง
    expect(route).toContain(String.raw`/^(https?:\/\/|\/)/i.test(url)`);
    // จอข้ามผล redirect ไป /login ตอน session หมด และแจ้งไฟล์เสียใหม่เมื่อโฆษณาเปลี่ยน
    expect(screen).toContain("res.redirected");
    expect(screen).toContain("if (changed) reportedMediaUrlsRef.current = new Set();");
  });

  it("limits upload size and sets a long cache on uploaded media", () => {
    expect(form).toContain("customerDisplayUploadSizeError(mediaType, uploadBody.size)");
    expect(form).toContain("cacheControl: String(CUSTOMER_DISPLAY_MEDIA_CACHE_SECONDS)");
  });
});
