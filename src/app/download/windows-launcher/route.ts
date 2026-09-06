import { LAUNCHER_VERSION } from "@/modules/launcher/version";
import { NextResponse } from "next/server";

/**
 * ดาวน์โหลด StoreOS Launcher สำหรับเครื่องแคชเชียร์ Windows
 *
 * ทำไมไม่ใช่ Supabase storage เหมือนไฟล์อื่น: ชุดติดตั้งโตเป็น ~115MB ตั้งแต่ฝัง
 * โมเดลเสียง Vosk ลงไป (โมเดล 68MB + ไลบรารี 44MB + ตัวโปรแกรม self-contained)
 * ซึ่งเกินเพดานอัปโหลด 50MB ของโปรเจกต์ Supabase และย่อให้ต่ำกว่านั้นไม่ได้จริง
 * ถ้ายังฝังโมเดลไว้ — GitHub Releases รับได้ถึง 2GB ต่อไฟล์ และ repo นี้เป็น public อยู่แล้ว
 *
 * สัญญาที่ต้องรักษา: ชื่อ tag และชื่อไฟล์ผูกกับ LAUNCHER_VERSION ตัวเดียว
 * ปล่อยรุ่นใหม่ = สร้าง release `launcher-v<เวอร์ชัน>` ที่มีไฟล์
 * `storeos-launcher-<เวอร์ชัน>.zip` แล้วขยับ LAUNCHER_VERSION ตาม
 * (มีเทสต์บังคับให้เลขตรงกับ csproj อยู่แล้ว)
 *
 * ในชุดมี: ตัวโปรแกรม (self-contained ไม่ต้องลง .NET), install.cmd ที่ติดตั้ง
 * WebView2 + Print Hub + Node ให้อัตโนมัติ และชุดข้อมูลเสียงของคำปลุก
 * สร้างไฟล์ด้วย scripts/windows-launcher/build-launcher.ps1
 */
export const dynamic = "force-dynamic";

const RELEASE_BASE = "https://github.com/burinpama01/store-management-system-saas/releases/download";

export function GET() {
  const filename = `storeos-launcher-${LAUNCHER_VERSION}.zip`;
  return NextResponse.redirect(
    `${RELEASE_BASE}/launcher-v${LAUNCHER_VERSION}/${filename}`,
    { status: 307 },
  );
}
