import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  STORE_AD_REVIEW_TRANSITIONS,
  canDisplayCustomerAds,
  checkStoreAdMedia,
  countStoreAdSlotsInUse,
  findStoreAdPackage,
  interleaveStoreAds,
  isStoreAdLive,
  mapStoreAdOrderRow,
  mergeStoreAdsIntoDisplay,
  nextStoreAdFreeAt,
} from "@/modules/ad-self-serve/orders";
import { DEFAULT_STORE_AD_OFFER } from "@/modules/ad-self-serve/rules";
import { NOTIFICATION_TYPES } from "@/modules/notifications/types";
import { DEFAULT_NOTIFICATION_TEMPLATES, NOTIFICATION_TEMPLATE_VARS } from "@/modules/notifications/templates";
import {
  CUSTOMER_DISPLAY_VIDEO_MAX_BYTES,
  DEFAULT_CUSTOMER_DISPLAY_SETTINGS,
  resolveCustomerDisplayAdSlots,
  type CustomerDisplayAdSlide,
  type CustomerDisplaySettings,
} from "@/modules/settings/customer-display";

const read = (path: string) => readFileSync(path, "utf8");
const MB = 1024 * 1024;
const NOW = Date.parse("2026-12-01T05:00:00Z");
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

function storeSlide(id: string, slot: "top" | "bottom" = "top"): CustomerDisplayAdSlide {
  return { id, slot, mediaType: "image", url: `https://cdn.example/${id}.jpg`, fit: "cover" };
}

function ad(id: string, slot: "any" | "top" | "bottom" = "any") {
  return { id, mediaType: "video" as const, mediaUrl: `https://cdn.example/ad-${id}.mp4`, slot };
}

describe("ตรวจไฟล์โฆษณาก่อนอัปโหลด", () => {
  const offer = DEFAULT_STORE_AD_OFFER;
  it("วิดีโอ MP4 ไม่เกิน 60 วิ / 50 MB ผ่าน · เผื่อปัดเศษ 1 วิ", () => {
    const ok = checkStoreAdMedia(offer, { mediaType: "video", extension: "MP4", sizeBytes: 20 * MB, durationSeconds: 60.6 });
    expect(ok).toMatchObject({ ok: true, mediaType: "video", extension: "mp4", contentType: "video/mp4", durationSeconds: 60.6 });
  });
  it("ยาวเกิน/ใหญ่เกิน/อ่านความยาวไม่ได้/นามสกุลแปลก = ไม่ผ่าน", () => {
    expect(checkStoreAdMedia(offer, { mediaType: "video", extension: "mp4", sizeBytes: MB, durationSeconds: 62 })).toMatchObject({ ok: false });
    expect(
      checkStoreAdMedia(offer, { mediaType: "video", extension: "mp4", sizeBytes: CUSTOMER_DISPLAY_VIDEO_MAX_BYTES + 1, durationSeconds: 10 }),
    ).toMatchObject({ ok: false });
    expect(checkStoreAdMedia(offer, { mediaType: "video", extension: "mp4", sizeBytes: MB, durationSeconds: NaN })).toMatchObject({ ok: false });
    expect(checkStoreAdMedia(offer, { mediaType: "video", extension: "avi", sizeBytes: MB, durationSeconds: 10 })).toMatchObject({ ok: false });
    expect(checkStoreAdMedia(offer, { mediaType: "image", extension: "svg", sizeBytes: MB, durationSeconds: null })).toMatchObject({ ok: false });
    expect(checkStoreAdMedia(offer, { mediaType: "image", extension: "png", sizeBytes: 11 * MB, durationSeconds: null })).toMatchObject({ ok: false });
  });
  it("ร้านไม่รับวิดีโอ/รูป = ไม่ผ่าน", () => {
    expect(checkStoreAdMedia({ ...offer, allowVideo: false }, { mediaType: "video", extension: "mp4", sizeBytes: MB, durationSeconds: 5 })).toMatchObject({ ok: false });
    expect(checkStoreAdMedia({ ...offer, allowImage: false }, { mediaType: "image", extension: "jpg", sizeBytes: MB, durationSeconds: null })).toMatchObject({ ok: false });
  });
  it("หาแพ็กตาม id เท่านั้น", () => {
    expect(findStoreAdPackage(offer.packages, "d7")?.price).toBe(199);
    expect(findStoreAdPackage(offer.packages, "x")).toBeNull();
    expect(findStoreAdPackage(offer.packages, 7)).toBeNull();
  });
});

describe("ช่องโฆษณา (จองช่อง / วันว่างถัดไป / กำลังแสดง)", () => {
  const orders = [
    { status: "active" as const, endsAt: iso(3 * 86_400_000) },
    { status: "active" as const, endsAt: iso(86_400_000) },
    { status: "active" as const, endsAt: iso(-1000) },
    { status: "pending_review" as const, endsAt: null },
    { status: "removed" as const, endsAt: iso(86_400_000) },
  ];
  it("นับเฉพาะกำลังแสดง (ยังไม่หมดอายุ) + รออนุมัติ", () => {
    expect(countStoreAdSlotsInUse(orders, NOW)).toBe(3);
  });
  it("วันว่างถัดไป = โฆษณาที่หมดเร็วที่สุด", () => {
    expect(nextStoreAdFreeAt(orders, NOW)).toBe(iso(86_400_000));
    expect(nextStoreAdFreeAt([{ status: "pending_review", endsAt: null }], NOW)).toBeNull();
  });
  it("ขึ้นจอเฉพาะ active ที่อยู่ในช่วงเวลาและมีไฟล์", () => {
    const base = { status: "active" as const, mediaUrl: "https://x/a.mp4", startsAt: iso(-1000), endsAt: iso(1000) };
    expect(isStoreAdLive(base, NOW)).toBe(true);
    expect(isStoreAdLive({ ...base, endsAt: iso(0) }, NOW)).toBe(false);
    expect(isStoreAdLive({ ...base, mediaUrl: null }, NOW)).toBe(false);
    expect(isStoreAdLive({ ...base, status: "pending_review" }, NOW)).toBe(false);
  });
});

describe("รวมโฆษณาลูกค้าเข้าจอ (ร้าน 1 : ลูกค้า 1)", () => {
  it("สลับกันแล้วต่อด้วยส่วนที่เหลือ", () => {
    expect(interleaveStoreAds(["s1", "s2", "s3"], ["c1"])).toEqual(["s1", "c1", "s2", "s3"]);
    expect(interleaveStoreAds([], ["c1", "c2"])).toEqual(["c1", "c2"]);
  });

  it("จอเดียว: รวมโฆษณาร้านทุกช่องที่เปิดแล้วสลับ · สื่อลูกค้าแสดงครบไม่ตัดขอบ", () => {
    const settings: CustomerDisplaySettings = {
      ...DEFAULT_CUSTOMER_DISPLAY_SETTINGS,
      topSlides: [storeSlide("t1")],
      bottomSlides: [storeSlide("b1", "bottom")],
    };
    const merged = mergeStoreAdsIntoDisplay(settings, [ad("a"), ad("b")]);
    const slots = resolveCustomerDisplayAdSlots(merged);
    expect(slots).toHaveLength(1);
    expect(slots[0].slides.map((s) => s.id)).toEqual(["t1", "customer-ad-a", "b1", "customer-ad-b"]);
    expect(slots[0].slides[1]).toMatchObject({ mediaType: "video", fit: "contain" });
  });

  it("แบ่งครึ่ง: any กระจายบน/ล่าง · ช่องที่ปิดย้ายไปช่องที่เปิด", () => {
    const split: CustomerDisplaySettings = {
      ...DEFAULT_CUSTOMER_DISPLAY_SETTINGS,
      adLayout: "split",
      topSlides: [storeSlide("t1")],
      bottomSlides: [storeSlide("b1", "bottom")],
    };
    const merged = mergeStoreAdsIntoDisplay(split, [ad("a"), ad("b"), ad("c", "bottom")]);
    expect(merged.topSlides.map((s) => s.id)).toEqual(["t1", "customer-ad-a"]);
    expect(merged.bottomSlides.map((s) => s.id)).toEqual(["b1", "customer-ad-b", "customer-ad-c"]);

    const topOff = mergeStoreAdsIntoDisplay({ ...split, topSlotEnabled: false }, [ad("a", "top")]);
    expect(topOff.bottomSlides.map((s) => s.id)).toEqual(["b1", "customer-ad-a"]);
  });

  it("ร้านปิดจอโฆษณา = ไม่แสดงและหน้าลงโฆษณาไม่รับคำสั่ง", () => {
    const off = { ...DEFAULT_CUSTOMER_DISPLAY_SETTINGS, adEnabled: false };
    expect(canDisplayCustomerAds(off)).toBe(false);
    expect(mergeStoreAdsIntoDisplay(off, [ad("a")])).toBe(off);
    expect(canDisplayCustomerAds({ ...DEFAULT_CUSTOMER_DISPLAY_SETTINGS, topSlotEnabled: false, bottomSlotEnabled: false })).toBe(false);
  });
});

describe("แปลงแถว / การตัดสินของร้าน", () => {
  it("แถวเสียไม่ทำหน้าพัง", () => {
    const order = mapStoreAdOrderRow({ id: "1", organization_id: "o", store_id: "s", status: "weird", amount: "199.00", slot: "x" });
    expect(order).toMatchObject({ status: "pending_payment", amount: 199, slot: "any", mediaType: null });
  });
  it("อนุมัติ/ไม่อนุมัติได้เฉพาะรออนุมัติ · ถอดได้เฉพาะกำลังแสดง", () => {
    expect(STORE_AD_REVIEW_TRANSITIONS.approve).toEqual({ from: ["pending_review"], to: "active" });
    expect(STORE_AD_REVIEW_TRANSITIONS.reject.from).toEqual(["pending_review"]);
    expect(STORE_AD_REVIEW_TRANSITIONS.remove).toEqual({ from: ["active"], to: "removed" });
  });
});

describe("migration A2–A4", () => {
  const sql = read("supabase/migrations/20261217120000_store_ad_self_serve_a2_a4.sql");

  it("ผูก Beam กับคำสั่ง 1:1 + trigger จุดเดียวไม่ว่า PAID มาจากทางไหน", () => {
    expect(sql).toContain("add column if not exists ad_order_id uuid references public.store_ad_orders(id) on delete set null");
    expect(sql).toContain("gateway_payments_ad_order_unique");
    expect(sql).toMatch(/when \(new\.ad_order_id is not null and new\.status = 'PAID' and old\.status is distinct from 'PAID'\)/);
    expect(sql).toContain("v_result := public.apply_store_ad_order_payment(new.ad_order_id, new.amount, 'beam', 'BEAM:' || new.id::text);");
    expect(sql).toContain("new.status := 'LATE_PAID';");
  });

  it("จ่ายแล้วขึ้นจอเฉพาะเมื่อร้านตั้งขึ้นทันทีและช่องยังไม่เต็ม (ล็อกแถวเงื่อนไขร้าน)", () => {
    expect(sql).toContain("from public.store_ad_offers where store_id = v_order.store_id for update");
    // นับช่องเหมือนฝั่งเว็บ: active ที่ยังไม่หมด + pending_review (รีวิว MAJOR-1)
    expect(sql).toContain("(status = 'active' and ends_at > now())\n      or status = 'pending_review'");
    expect(sql).toContain("elsif coalesce(v_offer.auto_publish, false) and v_active < coalesce(v_offer.max_concurrent, 0) then");
    expect(sql).toContain("if v_order.status <> 'pending_payment' then\n    return 'late';");
    expect(sql).toContain("exception when unique_violation then\n    return 'duplicate_ref';");
    expect(sql).toContain("store_ad_orders_payment_ref_unique");
    // ฟังก์ชันจ่ายเงินเรียกได้เฉพาะ service role
    expect(sql).toContain("revoke all on function public.apply_store_ad_order_payment(uuid, numeric, text, text) from public, anon, authenticated;");
    expect(sql).toContain("grant execute on function public.apply_store_ad_order_payment(uuid, numeric, text, text) to service_role;");
  });

  it("หัวข้อแจ้งเตือน ad_order เปิดทั้ง settings/templates โดยไม่ทำชนิดเดิมหาย", () => {
    for (const type of NOTIFICATION_TYPES) expect(sql.split(`'${type}'`).length - 1).toBe(2);
    expect(DEFAULT_NOTIFICATION_TEMPLATES.ad_order.title).toBeTruthy();
    expect(NOTIFICATION_TEMPLATE_VARS.ad_order).toContain("store");
    expect(read("src/app/(dashboard)/settings/notifications/page.tsx")).toContain('  ad_order: "');
    expect(read("src/app/(dashboard)/notifications/NotificationCenter.tsx")).toContain("  ad_order: { label:");
  });

  it("A4: ไม่จ่าย → cancelled · ครบกำหนด → expired · ลบไฟล์ผ่าน API เฉพาะเมื่อมีงาน", () => {
    expect(sql).toContain("select cron.schedule('store-ad-expire', '*/10 * * * *'");
    expect(sql).toContain("url := 'https://www.store-os.online/api/ads/cron/cleanup'");
    expect(sql).toContain("where exists (select 1 from public.store_ad_media_cleanup_due(1));");
    expect(sql).toContain("(o.status = 'cancelled' and o.updated_at < now() - interval '30 minutes')");
    expect(sql).toContain("o.status in ('expired', 'removed', 'rejected') and o.updated_at < now() - interval '7 days'");
  });
});

describe("โค้ดเชื่อมระบบ", () => {
  it("หน้า /ads และ cron ลบไฟล์เป็น public route", () => {
    const mw = read("src/server/integrations/supabase/middleware.ts");
    expect(mw).toContain('request.nextUrl.pathname.startsWith("/ads/")');
    expect(mw).toContain('request.nextUrl.pathname === "/api/ads/cron/cleanup"');
    const cron = read("src/app/api/ads/cron/cleanup/route.ts");
    expect(cron).toContain('db.rpc("verify_ad_cleanup_cron_key", { p_key: key })');
    expect(cron).toContain('.neq("status", "active")');
  });

  it("Beam: ใส่ ad_order_id เฉพาะตอนใช้ · webhook แจ้งร้านผ่าน paid-effects", () => {
    expect(read("src/modules/payments/beam-service.ts")).toContain("...(input.adOrderId ? { ad_order_id: input.adOrderId } : {}),");
    const effects = read("src/modules/payments/paid-effects.ts");
    expect(effects).toContain("if (data.ad_order_id) await notifyAdOrderPaidOnce(String(data.ad_order_id));");
    expect(read("src/modules/ad-self-serve/notify.ts")).toContain('type: "ad_order"');
  });

  it("อัปโหลดผูกกับคำสั่ง (signed URL ต่อคำสั่ง) · ไฟล์ที่ตรวจไม่ผ่านถูกลบ · จำกัดต่อ IP/เบอร์/ร้าน", () => {
    const actions = read("src/app/ads/[slug]/actions.ts");
    expect(actions).toContain("/ad-orders/${id}.${media.extension}");
    expect(actions).toContain("createSignedUploadUrl(path, { upsert: true })");
    expect(actions).toContain("await db.storage.from(STORE_AD_MEDIA_BUCKET).remove([order.mediaPath]);");
    expect(actions).toContain("STORE_AD_MAX_ORDERS_PER_IP_HOUR");
    expect(actions).toContain("STORE_AD_MAX_PENDING_PER_PHONE");
    expect(actions).toContain("if (store.slotsInUse >= offer.maxConcurrent) return fail(full(store));");
    // สลิป: ตรวจยอด/ผู้รับ/เวลา แล้วบันทึกผ่านฟังก์ชันเดียวกับ Beam
    expect(actions).toContain('db.rpc("apply_store_ad_order_payment"');
    expect(actions).toContain("validateDonationSlip(");
  });

  it("จอลูกค้าทั้ง 2 หน้า + API ดึงโฆษณาลูกค้ารวมเข้าไป", () => {
    for (const path of ["src/app/pos/display/page.tsx", "src/app/pos/grocery/display/page.tsx", "src/app/api/pos/customer-display/settings/route.ts"]) {
      expect(read(path)).toContain("withLiveStoreAds(");
    }
  });
});
