import { NextResponse } from "next/server";
import {
  ANDROID_DOWNLOAD_PATH,
  ANDROID_NOTES,
  ANDROID_SHA256,
  ANDROID_SIZE_BYTES,
  ANDROID_VERSION_CODE,
  ANDROID_VERSION_NAME,
} from "@/modules/mobile/android-version";

/**
 * รุ่นล่าสุดของแอป Android — คู่ขนานกับ `/api/launcher/latest` ของฝั่ง Windows
 *
 * public (ไม่ต้องล็อกอิน) เพราะเป็นข้อมูลชุดเดียวกับลิงก์ดาวน์โหลดที่เปิดอยู่แล้ว
 * และต้องอ่านได้ตั้งแต่ก่อนใครล็อกอิน
 *
 * ยังไม่มี SHA-256 ที่ถูกต้อง = 503 ให้ผู้เรียกข้ามรอบนี้ ดีกว่าชี้ไฟล์ที่ตรวจไม่ได้
 */
export const dynamic = "force-dynamic";

export function GET() {
  if (!/^[0-9a-f]{64}$/.test(ANDROID_SHA256) || ANDROID_SIZE_BYTES <= 0) {
    return NextResponse.json({ error: "release_not_ready" }, { status: 503 });
  }

  return NextResponse.json(
    {
      versionName: ANDROID_VERSION_NAME,
      versionCode: ANDROID_VERSION_CODE,
      url: ANDROID_DOWNLOAD_PATH,
      sha256: ANDROID_SHA256,
      size: ANDROID_SIZE_BYTES,
      notes: ANDROID_NOTES,
    },
    { headers: { "Cache-Control": "public, max-age=300" } },
  );
}
