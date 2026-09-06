// เลขเวอร์ชันที่โชว์ข้างปุ่มดาวน์โหลดต้องตรงกับของจริงที่แจกอยู่ ไม่งั้นร้านเช็คไม่ได้
// ว่าเครื่องแคชเชียร์ลงตัวใหม่หรือยัง (ทั้ง Launcher และ Print Hub ไม่อัปเดตตัวเอง)
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PRINT_HUB_VERSION } from "@/modules/printing/hub-version";
import { LAUNCHER_VERSION } from "@/modules/launcher/version";

const read = (relative: string) => readFileSync(join(process.cwd(), relative), "utf8");

describe("เวอร์ชันชุดติดตั้งที่หน้าเว็บแจก", () => {
  it("Print Hub ตรงกับ AGENT_VERSION ในตัว agent จริง", () => {
    const agent = read("scripts/print-hub.mjs");
    expect(agent).toContain(`export const AGENT_VERSION = "${PRINT_HUB_VERSION}";`);
  });

  it("Launcher ตรงกับ <Version> ใน csproj", () => {
    const csproj = read("windows/StoreOS.Launcher/StoreOS.Launcher.csproj");
    expect(csproj).toContain(`<Version>${LAUNCHER_VERSION}</Version>`);
  });

  it("ปุ่มดาวน์โหลด Print Hub โชว์เวอร์ชัน + ตั้งชื่อไฟล์ตามเวอร์ชัน", () => {
    const source = read("src/app/(dashboard)/settings/print-hub/PrintHubManager.tsx");
    expect(source).toContain("download={`storeos-print-hub-${PRINT_HUB_VERSION}.zip`}");
    // query string กัน browser/CDN ส่งไฟล์เก่าที่แคชไว้ให้ตอนกดโหลดใหม่
    expect(source).toContain("/downloads/storeos-print-hub.zip?v=${PRINT_HUB_VERSION}");
    expect(source).toContain("เวอร์ชัน {PRINT_HUB_VERSION}");
  });

  it("ลิงก์ดาวน์โหลด Launcher โชว์เวอร์ชัน + ตั้งชื่อไฟล์ตามเวอร์ชัน", () => {
    expect(read("src/app/page.tsx")).toContain("(v{LAUNCHER_VERSION})");
    expect(read("src/app/download/windows-launcher/route.ts")).toContain(
      "`storeos-launcher-${LAUNCHER_VERSION}.zip`",
    );
  });

  it("ชื่อ tag ของ GitHub Release ต้องผูกกับ LAUNCHER_VERSION ตัวเดียวกับชื่อไฟล์", () => {
    // ชุดติดตั้งย้ายจาก Supabase storage มา GitHub Releases เพราะโตเกินเพดาน 50MB
    // ที่นั่นไฟล์ไม่ได้ทับ path เดิม แต่ผูกกับ tag — เลขที่หลุดจากกันแปลว่าลิงก์ 404
    const source = read("src/app/download/windows-launcher/route.ts");
    expect(source).toContain("launcher-v${LAUNCHER_VERSION}");
    expect(source).not.toContain("storage/v1/object/public/app/storeos-launcher.zip");
  });
});
