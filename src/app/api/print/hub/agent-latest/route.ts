import { NextResponse } from "next/server";
import {
  PRINT_HUB_DOWNLOAD_PATH,
  PRINT_HUB_NOTES,
  PRINT_HUB_SHA256,
  PRINT_HUB_SIZE_BYTES,
  PRINT_HUB_VERSION,
} from "@/modules/printing/hub-version";

/**
 * รุ่นล่าสุดของ Print Hub — Launcher อ่านเพื่ออัปเดต agent ให้เครื่องร้าน
 *
 * ตัว agent อัปเดตตัวเองไม่ได้ (มันเป็นสคริปต์ที่ Scheduled Task เรียก ไม่ใช่โปรแกรม
 * ที่มีตัวติดตั้งของตัวเอง) ทุกครั้งที่แก้ agent จึงเคยต้องเดินไปลงใหม่ทีละร้าน
 * ซึ่งแปลว่าการแก้ฝั่ง agent แทบไม่เคยไปถึงหน้าร้านจริง Launcher ที่รันอยู่บนเครื่อง
 * เดียวกันและอัปเดตตัวเองเป็นอยู่แล้วจึงรับหน้าที่นี้แทน
 *
 * public (ไม่ต้องล็อกอิน) ด้วยเหตุผลเดียวกับ /api/launcher/latest — ลิงก์ดาวน์โหลด
 * ก็ public อยู่แล้ว ความปลอดภัยอยู่ที่ฝั่ง Launcher: SHA-256 ต้องตรงทุกไบต์
 *
 * ยังไม่มี SHA-256 ของรุ่นที่ประกาศ = ตอบ 503 ให้ Launcher ข้ามรอบนี้ ดีกว่าชี้ไฟล์
 * ที่ตรวจไม่ได้แล้วปล่อยให้มันเขียนทับ agent ที่ใช้งานได้อยู่
 */
export const dynamic = "force-dynamic";

export function GET(request: Request) {
  if (!/^[0-9a-f]{64}$/.test(PRINT_HUB_SHA256) || PRINT_HUB_SIZE_BYTES <= 0) {
    return NextResponse.json({ error: "release_not_ready" }, { status: 503 });
  }

  return NextResponse.json(
    {
      version: PRINT_HUB_VERSION,
      url: new URL(PRINT_HUB_DOWNLOAD_PATH, request.url).toString(),
      sha256: PRINT_HUB_SHA256,
      size: PRINT_HUB_SIZE_BYTES,
      notes: PRINT_HUB_NOTES,
    },
    { headers: { "Cache-Control": "public, max-age=300" } },
  );
}
