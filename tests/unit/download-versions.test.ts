// เลขเวอร์ชันที่โชว์ข้างปุ่มดาวน์โหลดต้องตรงกับของจริงที่แจกอยู่ ไม่งั้นร้านเช็คไม่ได้
// ว่าเครื่องแคชเชียร์ลงตัวใหม่หรือยัง (ทั้ง Launcher และ Print Hub ไม่อัปเดตตัวเอง)
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PRINT_HUB_SHA256,
  PRINT_HUB_SIZE_BYTES,
  PRINT_HUB_VERSION,
} from "@/modules/printing/hub-version";
import { LAUNCHER_VERSION } from "@/modules/launcher/version";
import {
  ANDROID_SHA256,
  ANDROID_SIZE_BYTES,
  ANDROID_VERSION_CODE,
  ANDROID_VERSION_NAME,
  isAndroidApp,
  isOutdated,
  parseAppVersionName,
} from "@/modules/mobile/android-version";

const read = (relative: string) => readFileSync(join(process.cwd(), relative), "utf8");

describe("เวอร์ชันชุดติดตั้งที่หน้าเว็บแจก", () => {
  it("Print Hub ตรงกับ AGENT_VERSION ในตัว agent จริง", () => {
    const agent = read("scripts/print-hub.mjs");
    expect(agent).toContain(`export const AGENT_VERSION = "${PRINT_HUB_VERSION}";`);
  });

  it("SHA-256 และขนาดของ Print Hub ตรงกับไฟล์ zip ที่แจกอยู่จริง", () => {
    // Launcher ทิ้งแพ็กเกจที่ hash ไม่ตรง ค่าผิดในไฟล์นี้จึงแปลว่า "ทุกร้านอัปเดตไม่ได้"
    // และไม่มีใครรู้จนกว่าจะมีคนไปดูที่เครื่องร้าน — เทสนี้จับตอน build แทน
    const zip = readFileSync(join(process.cwd(), "public/downloads/storeos-print-hub.zip"));
    expect(createHash("sha256").update(zip).digest("hex")).toBe(PRINT_HUB_SHA256);
    expect(zip.length).toBe(PRINT_HUB_SIZE_BYTES);
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

  it("รุ่น Android ที่เผยแพร่ต้องไม่ใหม่กว่า native candidate", () => {
    const gradle = read("mobile/android/app/build.gradle");
    const candidateName = gradle.match(/versionName "([^"]+)"/)?.[1];
    const candidateCode = Number(gradle.match(/versionCode (\d+)/)?.[1]);
    expect(candidateName).toBeTruthy();
    expect(candidateCode).toBeGreaterThanOrEqual(ANDROID_VERSION_CODE);
    expect(isOutdated(candidateName!, ANDROID_VERSION_NAME)).toBe(false);
    if (candidateCode === ANDROID_VERSION_CODE) expect(candidateName).toBe(ANDROID_VERSION_NAME);
  });

  it("User-Agent ของแอปต้องพ่วงเวอร์ชันเดียวกัน ไม่งั้นเว็บแยกรุ่นไม่ออก", () => {
    // ไม่มีเลขใน UA = เตือนอัปเดตไม่ได้เลย เพราะเซิร์ฟเวอร์ไม่รู้ว่าเครื่องไหนรุ่นอะไร
    // และต้องคง substring "StoreOSApp" ไว้ เพราะ middleware/browser-capability เช็คตัวนี้
    const config = read("mobile/capacitor.config.ts");
    const candidateName = read("mobile/android/app/build.gradle").match(/versionName "([^"]+)"/)?.[1];
    expect(candidateName).toBeTruthy();
    expect(config).toContain(`appendUserAgent: "StoreOSApp/${candidateName}"`);
  });

  it("SHA-256 และขนาดของ APK เป็นค่าที่ใช้ตรวจไฟล์ได้จริง", () => {
    expect(ANDROID_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(ANDROID_SIZE_BYTES).toBeGreaterThan(0);
  });
});

describe("อ่านรุ่นแอปจาก User-Agent", () => {
  const androidUa = (suffix: string) =>
    `Mozilla/5.0 (Linux; Android 13; SM-A135F) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36 ${suffix}`;

  it("เบราว์เซอร์ปกติไม่ใช่แอป", () => {
    expect(parseAppVersionName("Mozilla/5.0 (Windows NT 10.0) Chrome/120")).toBeNull();
    expect(isAndroidApp("Mozilla/5.0 (Windows NT 10.0) Chrome/120")).toBe(false);
  });

  it("แอปรุ่นเก่าที่ยังไม่มีเลขใน UA ถือเป็นรุ่น 0 จึงเห็นแบนเนอร์ได้ทันที", () => {
    expect(parseAppVersionName(androidUa("StoreOSApp"))).toBe("0");
    expect(isOutdated("0", ANDROID_VERSION_NAME)).toBe(true);
  });

  it("แอปที่พ่วงเลขเวอร์ชันมาอ่านได้ และรุ่นล่าสุดต้องไม่ถูกเตือน", () => {
    expect(parseAppVersionName(androidUa(`StoreOSApp/${ANDROID_VERSION_NAME}`))).toBe(
      ANDROID_VERSION_NAME,
    );
    expect(isOutdated(ANDROID_VERSION_NAME, ANDROID_VERSION_NAME)).toBe(false);
    expect(isOutdated("1.0.1", "1.0.2")).toBe(true);
    expect(isOutdated("1.0.10", "1.0.2")).toBe(false);
    expect(isOutdated("0.9.9", "1.0.0")).toBe(true);
  });

  it("แอป iOS ใช้ UA เดียวกันแต่ต้องไม่ถูกชวนโหลด APK", () => {
    const iosUa = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari StoreOSApp/1.0.2";
    expect(parseAppVersionName(iosUa)).toBe("1.0.2");
    expect(isAndroidApp(iosUa)).toBe(false);
  });
});
