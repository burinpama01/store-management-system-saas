import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// 2026-10-04: RPC ตัดสิทธิ์ล้มทุกครั้งเพราะ INSERT subscriptions มีคอลัมน์ 13 ค่า 12
// (42601) — Beam รับเงินแล้วร้านไม่ได้ต่ออายุ เทสต์นี้นับให้ตรงกันใน migration ล่าสุด
const migration = "supabase/migrations/20261004000000_fix_settle_platform_billing_order_values.sql";

/** แยกด้วย comma ระดับบนสุด (ไม่นับ comma ในวงเล็บ เช่น now()) */
function splitTopLevel(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of list) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function insertShapes(sql: string): { table: string; columns: number; values: number }[] {
  const re = /insert into public\.(\w+)\s*\(([\s\S]*?)\)\s*values\s*\(([\s\S]*?)\)\s*(?:on conflict|;)/gi;
  return [...sql.matchAll(re)].map((m) => ({
    table: m[1],
    columns: splitTopLevel(m[2]).length,
    values: splitTopLevel(m[3]).length,
  }));
}

describe("settle_platform_billing_order", () => {
  const sql = readFileSync(join(process.cwd(), migration), "utf8");

  it("ทุก INSERT มีจำนวนคอลัมน์เท่ากับจำนวนค่า", () => {
    const shapes = insertShapes(sql);
    expect(shapes.map((s) => s.table)).toEqual(["payment_submissions", "subscriptions", "audit_logs"]);
    for (const shape of shapes) expect(shape, shape.table).toMatchObject({ values: shape.columns });
  });

  it("ยังกันสัญญาไม่มีวันหมดอายุ และปิดข้อเสนอแบบถึงวันที่หลังจ่าย", () => {
    expect(sql).toContain("o.plan='enterprise'");
    expect(sql).toContain("enterprise_limited=excluded.enterprise_limited");
    expect(sql).toContain("term_kind = 'until'");
  });
});
