import { z } from "zod";

/**
 * เทศกาลบนเว็บไซต์ร้าน (S1) — "ชั้นตกแต่ง" ซ้อนบนเทมเพลตหลัก ใช้ได้กับทุกสไตล์
 * - วันที่คงที่ (ปีใหม่ สงกรานต์ วันแม่ ฯลฯ) คำนวณในโค้ด
 * - วันที่ตามจันทรคติ/ปฏิทินจีน เก็บรายปีในตาราง website_festival_dates (ซูเปอร์แอดมินตรวจ/แก้ได้)
 *   ใช้เฉพาะแถวที่ verified = true เพื่อไม่ให้ตกแต่งวันพระผิดวัน
 * - ไม่ต้องมี cron: หน้าเว็บแคช ISR 5 นาที เปลี่ยนตามวันเอง
 */

export type FestivalCategory = "thai" | "buddhist" | "chinese" | "global" | "shopping";
export type FestivalDecoration =
  | "lanterns" | "pumpkins" | "fireworks" | "krathong" | "water" | "snow" | "hearts" | "moon"
  | "lotus" | "balloons" | "flowers" | "sale" | "jay" | "incense" | "flag" | "jasmine" | "canna";

type FixedRule =
  | { kind: "fixed"; month: number; day: number; days: number; leadIn?: number }
  | { kind: "second_saturday_jan" }
  | { kind: "black_friday" }
  | { kind: "lunar" };

export interface FestivalDefinition {
  key: string;
  name: string;
  greeting: string;
  category: FestivalCategory;
  decoration: FestivalDecoration;
  /** สีเน้นของแถบเทศกาล */
  color: string;
  rule: FixedRule;
  /** ชุดเรียบ ไม่มีเอฟเฟกต์เคลื่อนไหว (วันสำคัญทางศาสนา/วันชาติ) */
  calm: boolean;
  /** เลขน้อย = สำคัญกว่า เมื่อซ้อนกันหลายเทศกาล */
  priority: number;
}

export const FESTIVALS: FestivalDefinition[] = [
  // ไทย
  { key: "new_year", name: "ปีใหม่", greeting: "สวัสดีปีใหม่", category: "thai", decoration: "fireworks", color: "#1a1f4d", rule: { kind: "fixed", month: 1, day: 1, days: 3 }, calm: false, priority: 10 },
  { key: "countdown", name: "สิ้นปี / เคานต์ดาวน์", greeting: "ส่งท้ายปีเก่า ต้อนรับปีใหม่", category: "thai", decoration: "fireworks", color: "#0b1a3a", rule: { kind: "fixed", month: 12, day: 29, days: 3 }, calm: false, priority: 12 },
  { key: "children_day", name: "วันเด็ก", greeting: "สุขสันต์วันเด็ก", category: "thai", decoration: "balloons", color: "#4dabf7", rule: { kind: "second_saturday_jan" }, calm: false, priority: 30 },
  { key: "teacher_day", name: "วันครู", greeting: "ระลึกพระคุณครู", category: "thai", decoration: "flowers", color: "#e8590c", rule: { kind: "fixed", month: 1, day: 16, days: 1 }, calm: true, priority: 40 },
  { key: "songkran", name: "สงกรานต์", greeting: "สุขสันต์วันสงกรานต์", category: "thai", decoration: "water", color: "#1c7ed6", rule: { kind: "fixed", month: 4, day: 13, days: 3 }, calm: false, priority: 10 },
  { key: "labour_day", name: "วันแรงงาน", greeting: "สุขสันต์วันแรงงาน", category: "thai", decoration: "flag", color: "#c92a2a", rule: { kind: "fixed", month: 5, day: 1, days: 1 }, calm: true, priority: 50 },
  { key: "mother_day", name: "วันแม่", greeting: "รักแม่ทุกวัน", category: "thai", decoration: "jasmine", color: "#1971c2", rule: { kind: "fixed", month: 8, day: 12, days: 1 }, calm: true, priority: 20 },
  { key: "father_day", name: "วันพ่อ", greeting: "รักพ่อทุกวัน", category: "thai", decoration: "canna", color: "#f59f00", rule: { kind: "fixed", month: 12, day: 5, days: 1 }, calm: true, priority: 20 },
  { key: "constitution_day", name: "วันรัฐธรรมนูญ", greeting: "วันรัฐธรรมนูญ", category: "thai", decoration: "flag", color: "#364fc7", rule: { kind: "fixed", month: 12, day: 10, days: 1 }, calm: true, priority: 60 },
  { key: "loy_krathong", name: "ลอยกระทง", greeting: "สุขสันต์วันลอยกระทง", category: "thai", decoration: "krathong", color: "#0b3a5c", rule: { kind: "lunar" }, calm: false, priority: 10 },
  // พุทธ
  { key: "makha_bucha", name: "มาฆบูชา", greeting: "วันมาฆบูชา", category: "buddhist", decoration: "lotus", color: "#c08a00", rule: { kind: "lunar" }, calm: true, priority: 15 },
  { key: "visakha_bucha", name: "วิสาขบูชา", greeting: "วันวิสาขบูชา", category: "buddhist", decoration: "lotus", color: "#c08a00", rule: { kind: "lunar" }, calm: true, priority: 15 },
  { key: "asanha_bucha", name: "อาสาฬหบูชา", greeting: "วันอาสาฬหบูชา", category: "buddhist", decoration: "lotus", color: "#c08a00", rule: { kind: "lunar" }, calm: true, priority: 15 },
  { key: "khao_phansa", name: "เข้าพรรษา", greeting: "วันเข้าพรรษา", category: "buddhist", decoration: "lotus", color: "#c08a00", rule: { kind: "lunar" }, calm: true, priority: 16 },
  { key: "ok_phansa", name: "ออกพรรษา", greeting: "วันออกพรรษา", category: "buddhist", decoration: "lotus", color: "#c08a00", rule: { kind: "lunar" }, calm: true, priority: 16 },
  // จีน
  { key: "chinese_new_year", name: "ตรุษจีน", greeting: "ซินเจียยู่อี่ ซินนี้ฮวดไช้", category: "chinese", decoration: "lanterns", color: "#c92a2a", rule: { kind: "lunar" }, calm: false, priority: 10 },
  { key: "qingming", name: "เชงเม้ง", greeting: "เทศกาลเชงเม้ง", category: "chinese", decoration: "incense", color: "#5c940d", rule: { kind: "fixed", month: 4, day: 4, days: 2 }, calm: true, priority: 45 },
  { key: "ghost_festival", name: "สารทจีน", greeting: "เทศกาลสารทจีน", category: "chinese", decoration: "incense", color: "#862e9c", rule: { kind: "lunar" }, calm: true, priority: 45 },
  { key: "vegetarian", name: "กินเจ", greeting: "เทศกาลกินเจ", category: "chinese", decoration: "jay", color: "#f08c00", rule: { kind: "lunar" }, calm: false, priority: 18 },
  { key: "mid_autumn", name: "ไหว้พระจันทร์", greeting: "เทศกาลไหว้พระจันทร์", category: "chinese", decoration: "moon", color: "#3a1e10", rule: { kind: "lunar" }, calm: false, priority: 20 },
  // สากล
  { key: "valentine", name: "วาเลนไทน์", greeting: "Happy Valentine's Day", category: "global", decoration: "hearts", color: "#d6336c", rule: { kind: "fixed", month: 2, day: 12, days: 3 }, calm: false, priority: 25 },
  { key: "halloween", name: "ฮาโลวีน", greeting: "Happy Halloween", category: "global", decoration: "pumpkins", color: "#3b1a52", rule: { kind: "fixed", month: 10, day: 29, days: 3 }, calm: false, priority: 25 },
  { key: "christmas", name: "คริสต์มาส", greeting: "Merry Christmas", category: "global", decoration: "snow", color: "#145c43", rule: { kind: "fixed", month: 12, day: 23, days: 3 }, calm: false, priority: 15 },
  // วันช้อปปิ้ง
  { key: "sale_9_9", name: "9.9", greeting: "9.9 ลดแรง", category: "shopping", decoration: "sale", color: "#e8590c", rule: { kind: "fixed", month: 9, day: 9, days: 1 }, calm: false, priority: 70 },
  { key: "sale_10_10", name: "10.10", greeting: "10.10 ลดแรง", category: "shopping", decoration: "sale", color: "#e8590c", rule: { kind: "fixed", month: 10, day: 10, days: 1 }, calm: false, priority: 70 },
  { key: "sale_11_11", name: "11.11", greeting: "11.11 ลดแรง", category: "shopping", decoration: "sale", color: "#e8590c", rule: { kind: "fixed", month: 11, day: 11, days: 1 }, calm: false, priority: 70 },
  { key: "sale_12_12", name: "12.12", greeting: "12.12 ลดแรง", category: "shopping", decoration: "sale", color: "#e8590c", rule: { kind: "fixed", month: 12, day: 12, days: 1 }, calm: false, priority: 70 },
  { key: "black_friday", name: "Black Friday", greeting: "Black Friday ลดใหญ่", category: "shopping", decoration: "sale", color: "#1d1b18", rule: { kind: "black_friday" }, calm: false, priority: 65 },
];

export const FESTIVAL_CATEGORY_LABELS: Record<FestivalCategory, string> = {
  thai: "วันสำคัญไทย",
  buddhist: "วันสำคัญทางพุทธศาสนา",
  chinese: "เทศกาลจีน",
  global: "เทศกาลสากล",
  shopping: "วันช้อปปิ้ง",
};

export const LUNAR_FESTIVAL_KEYS = FESTIVALS.filter((f) => f.rule.kind === "lunar").map((f) => f.key);

export function findFestival(key: string): FestivalDefinition | null {
  return FESTIVALS.find((f) => f.key === key) ?? null;
}

/** ตั้งค่าเทศกาลของร้าน (เก็บใน store_websites.festival_settings) */
export const festivalSettingsSchema = z.object({
  /** เปิด = เปลี่ยนชุดตกแต่งเองตามช่วงเทศกาล */
  auto: z.boolean(),
  /** แสดงล่วงหน้ากี่วันก่อนวันเทศกาล */
  leadDays: z.number().int().min(0).max(14),
  /** เทศกาลที่ร้านปิดไว้ */
  disabled: z.array(z.string().max(40)).max(FESTIVALS.length),
  /** ข้อความทักทายแทนค่าเริ่มต้น (ไม่บังคับ) */
  greetings: z.record(z.string().max(40), z.string().trim().max(80)).optional(),
});
export type FestivalSettings = z.infer<typeof festivalSettingsSchema>;

export const DEFAULT_FESTIVAL_SETTINGS: FestivalSettings = { auto: false, leadDays: 2, disabled: [], greetings: {} };

export function parseFestivalSettings(value: unknown): FestivalSettings {
  const parsed = festivalSettingsSchema.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_FESTIVAL_SETTINGS;
}

export interface LunarFestivalDate {
  festivalKey: string;
  year: number;
  startsOn: string;
  endsOn: string;
}

export interface FestivalWindow {
  festival: FestivalDefinition;
  startsOn: string;
  endsOn: string;
}

function iso(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function addDaysIso(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** ช่วงวันของเทศกาลในปีนั้น (null = เทศกาลจันทรคติที่ยังไม่มีวันที่ยืนยัน) */
export function festivalWindow(festival: FestivalDefinition, year: number, lunar: LunarFestivalDate[]): FestivalWindow | null {
  const rule = festival.rule;
  if (rule.kind === "fixed") {
    const start = iso(year, rule.month, rule.day);
    return { festival, startsOn: start, endsOn: addDaysIso(start, rule.days - 1) };
  }
  if (rule.kind === "second_saturday_jan") {
    const first = new Date(Date.UTC(year, 0, 1));
    const firstSaturday = 1 + ((6 - first.getUTCDay() + 7) % 7);
    const day = iso(year, 1, firstSaturday + 7);
    return { festival, startsOn: day, endsOn: day };
  }
  if (rule.kind === "black_friday") {
    // วันศุกร์หลังพฤหัสที่ 4 ของ พ.ย.
    const first = new Date(Date.UTC(year, 10, 1));
    const firstThursday = 1 + ((4 - first.getUTCDay() + 7) % 7);
    const day = iso(year, 11, firstThursday + 21 + 1);
    return { festival, startsOn: day, endsOn: day };
  }
  const row = lunar.find((entry) => entry.festivalKey === festival.key && entry.year === year);
  return row ? { festival, startsOn: row.startsOn, endsOn: row.endsOn } : null;
}

/** เทศกาลที่ควรแสดงวันนี้ (เวลาไทย, YYYY-MM-DD) ตามการตั้งค่าร้าน — null = ไม่มี */
export function activeFestival(today: string, settings: FestivalSettings, lunar: LunarFestivalDate[]): FestivalWindow | null {
  if (!settings.auto) return null;
  const year = Number(today.slice(0, 4));
  const disabled = new Set(settings.disabled);
  const candidates: FestivalWindow[] = [];
  for (const festival of FESTIVALS) {
    if (disabled.has(festival.key)) continue;
    // ปีที่แล้วด้วย: เทศกาลที่คร่อมปี (เคานต์ดาวน์ 29–31 ธ.ค.) และปีหน้า: แสดงล่วงหน้าข้ามปี (ปีใหม่)
    for (const y of [year - 1, year, year + 1]) {
      const window = festivalWindow(festival, y, lunar);
      if (!window) continue;
      if (addDaysIso(window.startsOn, -settings.leadDays) <= today && today <= window.endsOn) candidates.push(window);
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    // กำลังอยู่ในวันจริง มาก่อนช่วงแสดงล่วงหน้า
    const aLive = a.startsOn <= today ? 0 : 1;
    const bLive = b.startsOn <= today ? 0 : 1;
    if (aLive !== bLive) return aLive - bLive;
    return a.festival.priority - b.festival.priority;
  });
  return candidates[0];
}

/** ข้อมูลที่ตัวเรนเดอร์ใช้ */
export interface FestivalView {
  key: string;
  name: string;
  greeting: string;
  decoration: FestivalDecoration;
  color: string;
  calm: boolean;
}

export function toFestivalView(window: FestivalWindow | null, settings: FestivalSettings): FestivalView | null {
  if (!window) return null;
  const f = window.festival;
  return {
    key: f.key,
    name: f.name,
    greeting: settings.greetings?.[f.key]?.trim() || f.greeting,
    decoration: f.decoration,
    color: f.color,
    calm: f.calm,
  };
}

export function festivalPreview(key: string, settings: FestivalSettings): FestivalView | null {
  const f = findFestival(key);
  if (!f) return null;
  return toFestivalView({ festival: f, startsOn: "", endsOn: "" }, settings);
}

/** เทศกาลที่จะมาถึง (เปิดอยู่ในร้าน) ภายใน N วัน — ใช้แสดงในหลังร้าน */
export function upcomingFestivals(today: string, settings: FestivalSettings, lunar: LunarFestivalDate[], withinDays = 120, limit = 4): FestivalWindow[] {
  const year = Number(today.slice(0, 4));
  const until = addDaysIso(today, withinDays);
  const disabled = new Set(settings.disabled);
  const list: FestivalWindow[] = [];
  for (const festival of FESTIVALS) {
    if (disabled.has(festival.key)) continue;
    for (const y of [year, year + 1]) {
      const window = festivalWindow(festival, y, lunar);
      if (window && window.endsOn >= today && window.startsOn <= until) list.push(window);
    }
  }
  return list.sort((a, b) => (a.startsOn < b.startsOn ? -1 : a.startsOn > b.startsOn ? 1 : a.festival.priority - b.festival.priority)).slice(0, limit);
}

/** เทศกาลจันทรคติที่ยังไม่มีวันที่ยืนยันในปีนี้และปีหน้า */
export function pendingLunarFestivals(today: string, lunar: LunarFestivalDate[]): string[] {
  const year = Number(today.slice(0, 4));
  return LUNAR_FESTIVAL_KEYS.filter((key) => !lunar.some((d) => d.festivalKey === key && (d.year === year || d.year === year + 1)));
}
