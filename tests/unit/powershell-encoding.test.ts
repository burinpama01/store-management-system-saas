import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * กันบั๊กที่ทำให้ตัวติดตั้ง Print Hub พังคาเครื่องร้าน (2026-09-05)
 *
 * Windows PowerShell 5.1 อ่านไฟล์ .ps1 ที่ "ไม่มี UTF-8 BOM" ด้วย ANSI code page
 * ของเครื่อง (ไทย = cp874) ข้อความไทยในสคริปต์จึงเพี้ยนทั้งไฟล์ พาให้เครื่องหมายคำพูด
 * และวงเล็บผิดตาม แล้วล้มด้วย ParserError ตั้งแต่บรรทัดแรกที่มีภาษาไทย
 * (เครื่องร้านเจอ: Unexpected token / Missing closing ')' / Missing closing '}')
 *
 * PowerShell 7+ อ่านเป็น UTF-8 โดยไม่ต้องมี BOM แต่เครื่องร้านคือ Windows 10/11
 * ที่มี 5.1 ติดมากับเครื่อง และ install.cmd เรียกด้วย `powershell` (5.1) ไม่ใช่ `pwsh`
 * ดังนั้น BOM คือสิ่งบังคับ ไม่ใช่ทางเลือก
 */
const ROOTS = ["scripts", "windows"];
const SKIP_DIRS = new Set(["bin", "obj", "node_modules", ".git"]);
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

function collectPs1(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(entry)) collectPs1(full, out);
    } else if (entry.toLowerCase().endsWith(".ps1")) {
      out.push(full);
    }
  }
  return out;
}

const scripts = ROOTS.flatMap((root) => collectPs1(join(process.cwd(), root)));

describe("สคริปต์ PowerShell ต้องมี UTF-8 BOM", () => {
  it("เจอไฟล์ .ps1 ในโปรเจกต์", () => {
    expect(scripts.length).toBeGreaterThan(0);
  });

  it.each(scripts.map((path) => [path.replace(process.cwd(), "").replace(/\\/g, "/"), path]))(
    "%s ขึ้นต้นด้วย BOM",
    (_label, path) => {
      const head = readFileSync(path).subarray(0, 3);
      expect(head.equals(UTF8_BOM)).toBe(true);
    },
  );

  it("ไฟล์ที่มีภาษาไทยต้องมี BOM เสมอ (เคสที่พังจริง)", () => {
    const thai = /[฀-๿]/;
    for (const path of scripts) {
      const buffer = readFileSync(path);
      if (!thai.test(buffer.toString("utf8"))) continue;
      expect(buffer.subarray(0, 3).equals(UTF8_BOM), `${path} มีภาษาไทยแต่ไม่มี BOM`).toBe(true);
    }
  });
});
