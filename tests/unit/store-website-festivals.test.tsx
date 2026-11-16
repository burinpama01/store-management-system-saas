import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_FESTIVAL_SETTINGS,
  FESTIVALS,
  activeFestival,
  festivalPreview,
  festivalWindow,
  findFestival,
  parseFestivalSettings,
  pendingLunarFestivals,
  upcomingFestivals,
  type FestivalSettings,
  type LunarFestivalDate,
} from "@/modules/store-website/festivals";
import { FestivalOverlay } from "@/modules/store-website/FestivalOverlay";
import { WebsiteRenderer } from "@/modules/store-website/WebsiteRenderer";
import { WEBSITE_TEMPLATES, documentFromTemplate } from "@/modules/store-website/templates";
import type { WebsiteRenderData } from "@/modules/store-website/repository";

const read = (path: string) => readFileSync(path, "utf8");
const ON: FestivalSettings = { auto: true, leadDays: 2, disabled: [], greetings: {} };
const lunar: LunarFestivalDate[] = [
  { festivalKey: "chinese_new_year", year: 2027, startsOn: "2027-02-05", endsOn: "2027-02-08" },
  { festivalKey: "loy_krathong", year: 2026, startsOn: "2026-11-24", endsOn: "2026-11-24" },
];

describe("รายการเทศกาลไทย", () => {
  it("ครอบคลุมวันสำคัญไทย พุทธ จีน สากล และวันช้อปปิ้ง", () => {
    const keys = new Set(FESTIVALS.map((f) => f.key));
    for (const key of ["new_year", "songkran", "loy_krathong", "mother_day", "father_day", "makha_bucha", "visakha_bucha", "khao_phansa", "ok_phansa", "chinese_new_year", "vegetarian", "mid_autumn", "halloween", "christmas", "valentine", "sale_11_11", "black_friday"]) {
      expect(keys.has(key)).toBe(true);
    }
    expect(FESTIVALS.length).toBeGreaterThanOrEqual(26);
  });

  it("วันพระ/วันชาติใช้ชุดเรียบ (ไม่มีเอฟเฟกต์เคลื่อนไหว)", () => {
    for (const key of ["makha_bucha", "visakha_bucha", "asanha_bucha", "khao_phansa", "ok_phansa", "mother_day", "father_day"]) {
      expect(findFestival(key)?.calm).toBe(true);
    }
  });
});

describe("คำนวณวันเทศกาล (เวลาไทย)", () => {
  it("วันคงที่ / วันเด็ก (เสาร์ที่ 2 ม.ค.) / Black Friday", () => {
    expect(festivalWindow(findFestival("songkran")!, 2027, [])).toMatchObject({ startsOn: "2027-04-13", endsOn: "2027-04-15" });
    expect(festivalWindow(findFestival("children_day")!, 2027, [])).toMatchObject({ startsOn: "2027-01-09" });
    expect(festivalWindow(findFestival("children_day")!, 2028, [])).toMatchObject({ startsOn: "2028-01-08" });
    expect(festivalWindow(findFestival("black_friday")!, 2026, [])).toMatchObject({ startsOn: "2026-11-27" });
    expect(festivalWindow(findFestival("black_friday")!, 2027, [])).toMatchObject({ startsOn: "2027-11-26" });
    expect(festivalWindow(findFestival("black_friday")!, 2028, [])).toMatchObject({ startsOn: "2028-11-24" });
  });

  it("เทศกาลจันทรคติใช้เฉพาะวันที่ที่มีในตาราง (ไม่มี = ไม่แสดง)", () => {
    expect(festivalWindow(findFestival("chinese_new_year")!, 2027, lunar)).toMatchObject({ startsOn: "2027-02-05" });
    expect(festivalWindow(findFestival("makha_bucha")!, 2027, lunar)).toBeNull();
    expect(pendingLunarFestivals("2026-11-16", lunar)).toContain("makha_bucha");
    expect(pendingLunarFestivals("2026-11-16", lunar)).not.toContain("chinese_new_year");
  });
});

describe("เลือกเทศกาลที่แสดงวันนี้", () => {
  it("ปิดอัตโนมัติ = ไม่มีเทศกาล", () => {
    expect(activeFestival("2027-04-14", DEFAULT_FESTIVAL_SETTINGS, [])).toBeNull();
  });

  it("แสดงล่วงหน้าตามจำนวนวันที่ตั้ง", () => {
    expect(activeFestival("2027-04-11", ON, [])?.festival.key).toBe("songkran");
    expect(activeFestival("2027-04-10", ON, [])).toBeNull();
    expect(activeFestival("2027-04-16", ON, [])).toBeNull();
  });

  it("คร่อมปี: 30 ธ.ค. = เคานต์ดาวน์, 1 ม.ค. = ปีใหม่", () => {
    expect(activeFestival("2026-12-30", ON, [])?.festival.key).toBe("countdown");
    expect(activeFestival("2027-01-01", ON, [])?.festival.key).toBe("new_year");
  });

  it("วันจริงมาก่อนช่วงแสดงล่วงหน้า และเทศกาลที่ร้านปิดไม่แสดง", () => {
    // 24 พ.ย. 2026 = ลอยกระทง (วันจริง) แม้ Black Friday (27) อยู่ในช่วงล่วงหน้าก็ไม่ชนะ
    expect(activeFestival("2026-11-24", { ...ON, leadDays: 3 }, lunar)?.festival.key).toBe("loy_krathong");
    expect(activeFestival("2026-11-24", { ...ON, leadDays: 3, disabled: ["loy_krathong"] }, lunar)?.festival.key).toBe("black_friday");
  });

  it("สองเทศกาลวันเดียวกัน: ออกพรรษา (ชุดเรียบ) ชนะไหว้พระจันทร์", () => {
    const both: LunarFestivalDate[] = [
      { festivalKey: "ok_phansa", year: 2028, startsOn: "2028-10-03", endsOn: "2028-10-03" },
      { festivalKey: "mid_autumn", year: 2028, startsOn: "2028-10-03", endsOn: "2028-10-03" },
    ];
    expect(activeFestival("2028-10-03", ON, both)?.festival.key).toBe("ok_phansa");
  });

  it("ข้อความทักทายต้องเป็นเทศกาลที่รู้จัก", () => {
    expect(read("src/app/(dashboard)/website/actions.ts")).toContain("มีเทศกาลที่ไม่รู้จักในข้อความทักทาย");
  });

  it("ตั้งค่าเสีย/เก่า → ค่าเริ่มต้น (ปิด)", () => {
    expect(parseFestivalSettings({ auto: "yes" })).toEqual(DEFAULT_FESTIVAL_SETTINGS);
    expect(parseFestivalSettings(null).auto).toBe(false);
  });

  it("เทศกาลถัดไปเรียงตามวัน", () => {
    const list = upcomingFestivals("2026-11-16", ON, lunar);
    expect(list[0].festival.key).toBe("loy_krathong");
    expect(list.map((w) => w.startsOn)).toEqual([...list.map((w) => w.startsOn)].sort());
  });
});

describe("ชั้นตกแต่ง", () => {
  it("ชุดเรียบไม่มีสัญลักษณ์ลอย, ชุดปกติมี และปิดเองเมื่อลดการเคลื่อนไหว", () => {
    const calm = renderToStaticMarkup(<FestivalOverlay festival={festivalPreview("makha_bucha", ON)!} />);
    expect(calm).toContain("วันมาฆบูชา");
    expect(calm).not.toContain("wf-layer\"");
    const lively = renderToStaticMarkup(<FestivalOverlay festival={festivalPreview("chinese_new_year", ON)!} />);
    expect(lively).toContain('class="wf-layer"');
    expect(lively).toContain("prefers-reduced-motion");
  });

  it("ข้อความทักทายของร้านแทนค่าเริ่มต้นได้", () => {
    expect(festivalPreview("songkran", { ...ON, greetings: { songkran: "สงกรานต์นี้ ลด 15%" } })?.greeting).toBe("สงกรานต์นี้ ลด 15%");
  });

  it("เรนเดอร์บนเว็บร้านได้ (ตั้ง WEBSITE_PREVIEW_OUT เพื่อเขียนไฟล์ดูด้วยตา)", () => {
    const data: WebsiteRenderData = {
      store: { id: "s1", name: "each other II", slug: "eachother", logoUrl: null, address: null, phone: null, closingTime: "20:00:00" },
      products: [{ id: "00000000-0000-4000-8000-000000000001", name: "อเมริกาโน่", price: 45, imageUrl: null, categoryName: "" }],
      passPlans: [],
      memberUrl: null,
    };
    const out = process.env.WEBSITE_PREVIEW_OUT;
    if (out) mkdirSync(out, { recursive: true });
    for (const key of ["chinese_new_year", "loy_krathong", "songkran", "christmas", "makha_bucha", "halloween"]) {
      const html = renderToStaticMarkup(
        <WebsiteRenderer document={documentFromTemplate(WEBSITE_TEMPLATES[0], "each other II")} data={data} today="2026-11-16" festival={festivalPreview(key, ON)} />,
      );
      expect(html).toContain(`data-festival="${key}"`);
      if (out) writeFileSync(join(out, `${key}.html`), `<!doctype html><html lang="th"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;font-family:sans-serif">${html}</body></html>`);
    }
  });
});

describe("migration + สิทธิ์", () => {
  const sql = read("supabase/migrations/20261120120000_website_festivals.sql");
  it("ตารางวันที่ปิดสิทธิ์ anon/authenticated และวันพระเป็นร่างรอยืนยัน", () => {
    expect(sql).toContain("revoke all on table public.website_festival_dates from anon, authenticated;");
    expect(sql).toContain("('makha_bucha', 2027, '2027-02-20', '2027-02-20', false");
    expect(sql).toContain("('chinese_new_year', 2027, '2027-02-05', '2027-02-08', true");
  });
  it("หน้าเว็บใช้เฉพาะวันที่ยืนยันแล้ว และหน้าแก้วันที่ต้องเป็นซูเปอร์แอดมิน", () => {
    expect(read("src/modules/store-website/repository.ts")).toContain('.eq("verified", true)');
    expect(read("src/app/system/website-festivals/actions.ts")).toContain("user = await requireSystemAccess();");
  });
});
