import { NextResponse } from "next/server";
import {
  LAUNCHER_NOTES,
  LAUNCHER_SHA256,
  LAUNCHER_SIZE_BYTES,
  LAUNCHER_VERSION,
  launcherDownloadUrl,
} from "@/modules/launcher/version";

/**
 * รุ่นล่าสุดของ StoreOS Launcher — Launcher 0.5.0+ เรียกทุก 6 ชม. เพื่ออัปเดตตัวเอง
 *
 * public (ไม่ต้องล็อกอิน) เพราะ Launcher ตรวจตั้งแต่ก่อนมีใครล็อกอินเข้าเว็บ และข้อมูลนี้
 * เปิดเผยได้อยู่แล้ว (ลิงก์ดาวน์โหลดก็ public) — ความปลอดภัยอยู่ที่ฝั่ง Launcher:
 * รับเฉพาะ URL ของ release เราและ SHA-256 ต้องตรง (ดู LauncherUpdatePolicy.cs)
 *
 * ยังไม่มี SHA-256 ของรุ่นที่ประกาศ = ตอบ 503 ให้ Launcher ข้ามรอบนี้ (ดีกว่าชี้ไฟล์ที่ตรวจไม่ได้)
 */
export const dynamic = "force-dynamic";

export function GET(request: Request) {
  const channel = new URL(request.url).searchParams.get("channel") ?? "prod";
  if (channel !== "prod") {
    return NextResponse.json({ error: "unknown_channel" }, { status: 404 });
  }
  if (!/^[0-9a-f]{64}$/.test(LAUNCHER_SHA256) || LAUNCHER_SIZE_BYTES <= 0) {
    return NextResponse.json({ error: "release_not_ready" }, { status: 503 });
  }

  return NextResponse.json(
    {
      version: LAUNCHER_VERSION,
      url: launcherDownloadUrl(),
      sha256: LAUNCHER_SHA256,
      size: LAUNCHER_SIZE_BYTES,
      notes: LAUNCHER_NOTES,
    },
    { headers: { "Cache-Control": "public, max-age=300" } },
  );
}
