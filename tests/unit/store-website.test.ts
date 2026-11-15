import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  isAllowedDeliveryUrl,
  isBannerActive,
  isSafeUrl,
  normalizeSlug,
  parseWebsiteDocument,
  validateSlug,
  MAX_BLOCKS,
} from "@/modules/store-website/schema";
import { WEBSITE_TEMPLATES, documentFromTemplate, emptyBlock } from "@/modules/store-website/templates";

const read = (path: string) => readFileSync(path, "utf8");

describe("เทมเพลตตั้งต้น", () => {
  it("มี 6 แบบ ครอบคลุม คาเฟ่ / ร้านอาหาร / ของชำ และ 3 สไตล์", () => {
    expect(WEBSITE_TEMPLATES).toHaveLength(6);
    expect(new Set(WEBSITE_TEMPLATES.map((t) => t.business))).toEqual(new Set(["cafe", "restaurant", "grocery"]));
    expect(new Set(WEBSITE_TEMPLATES.map((t) => t.style))).toEqual(new Set(["minimal", "cute", "luxury"]));
  });

  it("เอกสารจากทุกเทมเพลตผ่าน schema", () => {
    for (const template of WEBSITE_TEMPLATES) {
      const doc = documentFromTemplate(template, "each other II");
      expect(parseWebsiteDocument(doc).error).toBeNull();
    }
  });

  it("บล็อกเปล่าทุกชนิดผ่าน schema", () => {
    const doc = documentFromTemplate(WEBSITE_TEMPLATES[0], "ร้าน");
    const types = ["hero", "banner", "passes", "menu", "member", "info", "social", "delivery_apps", "text"] as const;
    const blocks = types.map((type) => emptyBlock(type, "ร้าน"));
    expect(parseWebsiteDocument({ ...doc, blocks }).error).toBeNull();
  });
});

describe("ความปลอดภัยของเอกสาร", () => {
  const base = documentFromTemplate(WEBSITE_TEMPLATES[0], "ร้าน");

  it("ลิงก์อันตรายถูกปฏิเสธ (javascript:/data:)", () => {
    expect(isSafeUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeUrl("data:text/html,hi")).toBe(false);
    expect(isSafeUrl("https://facebook.com/x")).toBe(true);
    const bad = { ...base, blocks: [{ ...emptyBlock("social"), links: [{ platform: "facebook", url: "javascript:alert(1)" }] }] };
    expect(parseWebsiteDocument(bad).error).not.toBeNull();
  });

  it("ลิงก์แอปเดลิเวอรีต้องเป็นโดเมนของแอปนั้นจริง", () => {
    expect(isAllowedDeliveryUrl("grab", "https://food.grab.com/th/en/restaurant/x")).toBe(true);
    expect(isAllowedDeliveryUrl("grab", "https://grab.com.evil.site/x")).toBe(false);
    expect(isAllowedDeliveryUrl("lineman", "https://lineman.line.me/x")).toBe(true);
    expect(isAllowedDeliveryUrl("foodpanda", "http://www.foodpanda.co.th/x")).toBe(false);
    const fake = { ...base, blocks: [{ ...emptyBlock("delivery_apps"), apps: [{ app: "grab", url: "https://phishing.example/grab" }] }] };
    expect(parseWebsiteDocument(fake).error).toContain("ลิงก์แอปเดลิเวอรี");
  });

  it("บล็อกเกินจำนวน/รหัสซ้ำ/สีผิดรูปแบบถูกปฏิเสธ", () => {
    const many = { ...base, blocks: Array.from({ length: MAX_BLOCKS + 1 }, () => emptyBlock("text")) };
    expect(parseWebsiteDocument(many).error).not.toBeNull();
    const dup = { ...base, blocks: [{ ...emptyBlock("text"), id: "a" }, { ...emptyBlock("text"), id: "a" }] };
    expect(parseWebsiteDocument(dup).error).toContain("ซ้ำ");
    expect(parseWebsiteDocument({ ...base, theme: { ...base.theme, primary: "red" } }).error).not.toBeNull();
  });

  it("ตัวเรนเดอร์ไม่ใช้ HTML ดิบ", () => {
    const src = read("src/modules/store-website/WebsiteRenderer.tsx");
    expect(src).not.toContain("dangerouslySetInnerHTML={");
    expect(src).toContain('rel="noopener noreferrer nofollow"');
  });
});

describe("ลิงก์ร้าน (slug)", () => {
  it("แปลงและตรวจ", () => {
    expect(normalizeSlug("  Each Other II!! ")).toBe("each-other-ii");
    expect(validateSlug("each-other-ii")).toBeNull();
    expect(validateSlug("ab")).not.toBeNull();
    expect(validateSlug("-bad")).not.toBeNull();
    expect(validateSlug("admin")).toContain("สงวน");
  });
});

describe("แบนเนอร์ตามช่วงวัน (เวลาไทย)", () => {
  it("แสดงเฉพาะในช่วง", () => {
    expect(isBannerActive({ startsOn: "2026-11-01", endsOn: "2026-11-30" }, "2026-11-15")).toBe(true);
    expect(isBannerActive({ startsOn: "2026-12-01", endsOn: "" }, "2026-11-15")).toBe(false);
    expect(isBannerActive({ startsOn: "", endsOn: "2026-11-14" }, "2026-11-15")).toBe(false);
    expect(isBannerActive({}, "2026-11-15")).toBe(true);
  });
});

describe("migration + เส้นทาง", () => {
  const sql = read("supabase/migrations/20261119120000_store_websites.sql");

  it("RLS: anon อ่านตรงไม่ได้, เขียนได้เฉพาะ owner/admin, slug ไม่ซ้ำ", () => {
    expect(sql).toContain("revoke all on table public.store_websites from anon;");
    expect(sql).toContain("auth_user_role_in_store(organization_id, store_id, 'admin')");
    expect(sql).toContain("create unique index if not exists store_websites_slug_unique on public.store_websites (lower(slug));");
    expect(sql).toContain("check (slug ~ '^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$')");
  });

  it("หน้าเว็บสาธารณะแคชได้: ISR + ไม่ผ่าน proxy (ไม่มี auth call ทุกครั้งที่เปิด)", () => {
    const page = read("src/app/s/[slug]/page.tsx");
    expect(page).toContain("export const revalidate = 300;");
    expect(page).not.toMatch(/cookies\(|headers\(/);
    expect(read("src/proxy.ts")).toContain("favicon.ico|s/|");
  });

  it("metadata กับหน้าดึงข้อมูลครั้งเดียว + ประวัติเก็บ 20 ฉบับ + ประวัติพังมี log (review)", () => {
    expect(read("src/app/s/[slug]/page.tsx")).toContain("const getPublishedWebsite = cache(loadPublishedWebsite);");
    expect(sql).toContain("limit 20");
    expect(read("src/modules/store-website/repository.ts")).toContain('action: "publishVersionHistory"');
    expect(read("src/app/(dashboard)/website/WebsiteEditor.tsx")).toContain('window.addEventListener("beforeunload", handler);');
  });

  it("หน้าเว็บสาธารณะแสดงเฉพาะเว็บที่เปิด + เผยแพร่ + ยัง Enterprise", () => {
    const repo = read("src/modules/store-website/repository.ts");
    expect(repo).toContain('.eq("is_enabled", true)');
    expect(repo).toContain("if (!row?.published_document) return null;");
    expect(repo).toContain("if (!canUseMemberPrivileges(billing)) return null;");
  });

  it("แก้เว็บได้เฉพาะ owner/admin ของร้าน Enterprise และ log ทุกการกระทำ", () => {
    const actions = read("src/app/(dashboard)/website/actions.ts");
    expect(actions).toContain("if (!isOpsManagerRole(resolved.role))");
    expect(actions).toContain("if (!canUseMemberPrivileges(billing)) return { error: LOCK };");
    expect(actions.match(/log\(/g)?.length).toBeGreaterThanOrEqual(7);
    expect(actions).toContain("revalidatePath(`/s/${slug}`)");
  });
});
