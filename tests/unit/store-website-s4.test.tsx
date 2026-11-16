import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { bannerBlockSchema, parseWebsiteDocument, showcase3dBlockSchema, MAX_SHOWCASE_ITEMS } from "@/modules/store-website/schema";
import { WEBSITE_TEMPLATES, documentFromTemplate, emptyBlock, isNewTemplate } from "@/modules/store-website/templates";
import { WebsiteRenderer } from "@/modules/store-website/WebsiteRenderer";
import type { WebsiteRenderData } from "@/modules/store-website/repository";
import { hostOf, isApexDomain, isPrimaryHost, normalizeDomain, rewritePathForStoreDomain, validateDomain } from "@/modules/store-website/domains";

const read = (path: string) => readFileSync(path, "utf8");
const P = (id: string, name: string, imageUrl: string | null = `https://img.example.com/${id}.jpg`) => ({ id, name, price: 45, imageUrl, categoryName: "" });
const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444"];
const data: WebsiteRenderData = {
  store: { id: "s1", name: "each other II", slug: "eachother", logoUrl: null, address: null, phone: null, closingTime: null },
  products: [P(ids[0], "อเมริกาโน่"), P(ids[1], "ลาเต้"), P(ids[2], "มัทฉะ"), P(ids[3], "โกโก้", null)],
  passPlans: [],
  memberUrl: null,
};
const html = (blocks: unknown[]) => {
  const doc = documentFromTemplate(WEBSITE_TEMPLATES[0], "ร้าน");
  const parsed = parseWebsiteDocument({ ...doc, blocks });
  if (parsed.error !== null) throw new Error(parsed.error);
  return renderToStaticMarkup(<WebsiteRenderer document={parsed.data} data={data} today="2026-11-16" />);
};

describe("แบนเนอร์เลือกสัดส่วนได้", () => {
  const banner = emptyBlock("banner");
  if (banner.type !== "banner") throw new Error("expected banner");
  it("แบนเนอร์ใหม่ = 16:9 · แบนเนอร์เก่าไม่มีค่า = อัตโนมัติ (ยังผ่าน schema)", () => {
    expect(banner.aspect).toBe("16:9");
    const { aspect: _drop, ...legacy } = banner;
    void _drop;
    expect(bannerBlockSchema.safeParse(legacy).success).toBe(true);
    expect(bannerBlockSchema.safeParse({ ...banner, aspect: "7:3" }).success).toBe(false);
  });
  it("สัดส่วนคงที่ใช้ aspect-ratio (รูปโชว์ครบ) · auto ใช้ min-height เดิม · ไม่มีข้อความ = ไม่มีเงาทับรูป", () => {
    const fixed = html([{ ...banner, aspect: "3:1", title: "", subtitle: "", imageUrl: "https://img.example.com/promo.jpg" }]);
    expect(fixed).toContain("aspect-ratio:3 / 1");
    expect(fixed).not.toContain("rgba(0,0,0,.55)");
    expect(fixed).toContain('role="img"');
    const auto = html([{ ...banner, aspect: "auto", imageUrl: "https://img.example.com/promo.jpg" }]);
    expect(auto).toContain("min-height:120px");
  });
});

describe("บล็อกโชว์เมนู 3D", () => {
  const block = emptyBlock("showcase3d");
  if (block.type !== "showcase3d") throw new Error("expected showcase3d");
  it("schema จำกัดจำนวนเมนูและต้องเป็น uuid", () => {
    expect(showcase3dBlockSchema.safeParse(block).success).toBe(true);
    expect(showcase3dBlockSchema.safeParse({ ...block, productIds: ["x"] }).success).toBe(false);
    const many = Array.from({ length: MAX_SHOWCASE_ITEMS + 1 }, () => ids[0]);
    expect(showcase3dBlockSchema.safeParse({ ...block, productIds: many }).success).toBe(false);
  });
  it("ไม่เลือกเมนู = เมนูที่มีรูป · 3 เมนูขึ้นไปเป็นวงล้อ CSS 3D + มีแบบแถวสำหรับลดการเคลื่อนไหว (ไม่ใช้ WebGL)", () => {
    const out = html([block]);
    expect(out).toContain(`class="w3d-ring"`);
    expect(out).toContain("rotateY(120deg)");
    expect(out).not.toContain("โกโก้"); // ไม่มีรูป → ไม่อยู่ในชุดอัตโนมัติ
    expect(out).toContain("prefers-reduced-motion: reduce){.w3d-stage{display:none}");
    expect(read("src/modules/store-website/WebsiteRenderer.tsx")).not.toMatch(/from "three"|@react-three/);
  });
  it("น้อยกว่า 3 เมนู = แสดงเป็นแถวธรรมดา", () => {
    const out = html([{ ...block, productIds: [ids[0], ids[1]] }]);
    expect(out).not.toContain(`class="w3d-ring"`);
    expect(out).toContain("ลาเต้");
  });
});

describe("คลังเทมเพลตรายเดือน", () => {
  it("ป้าย “ใหม่” 30 วันนับจากวันเผยแพร่", () => {
    const now = Date.parse("2026-11-16T00:00:00Z");
    expect(isNewTemplate({ publishedAt: "2026-11-01T00:00:00Z" }, now)).toBe(true);
    expect(isNewTemplate({ publishedAt: "2026-10-01T00:00:00Z" }, now)).toBe(false);
    expect(isNewTemplate({ publishedAt: null }, now)).toBe(false);
  });
  it("ตาราง + RLS: ร้านอ่านได้เฉพาะที่เผยแพร่ เขียนไม่ได้ · server action ใช้ resolveTemplate (รวมคลัง)", () => {
    const sql = read("supabase/migrations/20261123120000_website_s4_templates_domains.sql");
    expect(sql).toContain("create table if not exists public.website_templates");
    expect(sql).toContain("revoke insert, update, delete on table public.website_templates from authenticated;");
    expect(sql).toContain("using (is_published);");
    const actions = read("src/app/(dashboard)/website/actions.ts");
    expect(actions).toContain("await resolveTemplate(templateId)");
    expect(actions).not.toContain("findTemplate(");
    expect(read("src/app/system/website-templates/actions.ts")).toContain("await requireSystemAccess()");
  });
});

describe("โดเมนของร้านเอง", () => {
  it("แปลง/ตรวจโดเมน", () => {
    expect(normalizeDomain(" https://WWW.EachOther.Cafe/menu?x=1 ")).toBe("www.eachother.cafe");
    expect(validateDomain("www.eachother.cafe")).toBeNull();
    expect(validateDomain("www.store-os.online")).not.toBeNull();
    expect(validateDomain("abc.vercel.app")).not.toBeNull();
    expect(validateDomain("bad_domain.com")).not.toBeNull();
    expect(validateDomain("")).not.toBeNull();
  });
  it("โดเมนหลักใช้ A · โดเมนย่อยใช้ CNAME (รวม .co.th)", () => {
    expect(isApexDomain("eachother.cafe")).toBe(true);
    expect(isApexDomain("eachother.co.th")).toBe(true);
    expect(isApexDomain("www.eachother.co.th")).toBe(false);
    expect(isApexDomain("www.eachother.cafe")).toBe(false);
  });
  it("host หลักของระบบไม่ถูกมองเป็นโดเมนร้าน", () => {
    expect(isPrimaryHost(hostOf("www.store-os.online"))).toBe(true);
    expect(isPrimaryHost(hostOf("store-os-manage.vercel.app"))).toBe(true);
    expect(isPrimaryHost(hostOf("localhost:3000"))).toBe(true);
    expect(isPrimaryHost(hostOf("WWW.EachOther.Cafe:443"))).toBe(false);
  });
  it("path บนโดเมนร้าน → หน้าเว็บร้าน/หน้าสั่ง · path ระบบไม่แปลง", () => {
    expect(rewritePathForStoreDomain("/", "eachother")).toBe("/s/eachother");
    expect(rewritePathForStoreDomain("/order", "eachother")).toBe("/s/eachother/order");
    expect(rewritePathForStoreDomain("/login", "eachother")).toBeNull();
    expect(rewritePathForStoreDomain("/api/x", "eachother")).toBeNull();
  });
  it("ร้านตั้งสถานะ active เองไม่ได้ (trigger) · proxy ไม่เชื่อ x-forwarded-host · RPC คืนเฉพาะโดเมนที่ใช้งานได้", () => {
    const sql = read("supabase/migrations/20261123120000_website_s4_templates_domains.sql");
    expect(sql).toContain("raise exception 'เปลี่ยนโดเมนได้ผ่านหน้าตั้งค่าเว็บไซต์เท่านั้น';");
    expect(sql).toContain("and w.custom_domain_status = 'active'");
    expect(sql).toContain("grant execute on function public.website_slug_for_domain(text) to anon, authenticated;");
    const proxy = read("src/proxy.ts");
    expect(proxy).toContain('hostOf(request.headers.get("host"))');
    expect(proxy).not.toContain('get("x-forwarded-host")');
  });
  it("หลังรีวิว: proxy ใช้คีย์ PUBLISHABLE · โดเมนในบัญชีอื่นไม่นับว่าสำเร็จ · กันเปลี่ยนโดเมนรัว · ตั้งโดเมนใหม่กดตรวจได้ทันที", () => {
    const proxy = read("src/proxy.ts");
    expect(proxy).toContain("process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
    expect(proxy).not.toContain("ANON_KEY");
    const vercel = read("src/modules/store-website/vercel-domains.ts");
    expect(vercel).toContain('if (res.ok || code === "domain_already_in_use_by_project") return');
    const actions = read("src/app/(dashboard)/website/actions.ts");
    expect(actions).toContain("current.domainChangedAt && Date.parse(current.domainChangedAt) > Date.now() - 30_000");
    const repo = read("src/modules/store-website/repository.ts");
    expect(repo).toContain("custom_domain_changed_at: new Date().toISOString(), custom_domain_checked_at: null");
    expect(read("src/app/system/website-templates/actions.ts")).toContain("{ checked: true, requireDomain: true }");
  });
});

describe("ปกร้านหนีอักขระใน url รูป", () => {
  it("วงเล็บในลิงก์รูปปกถูก encode", () => {
    const hero = emptyBlock("hero");
    if (hero.type !== "hero") throw new Error("expected hero");
    const out = html([{ ...hero, imageUrl: "https://img.example.com/a(1).jpg" }]);
    expect(out).toContain("a%281%29.jpg");
  });
});
