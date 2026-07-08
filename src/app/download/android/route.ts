import { NextResponse } from "next/server";

/**
 * ดาวน์โหลดแอป Android (APK) — redirect ไปยังไฟล์ใน Supabase public storage
 * (bucket `app`, path `storeos-android.apk`). อัปเดตแอป = อัปโหลดไฟล์ทับ path เดิม
 * ลิงก์สาธารณะ /download/android ไม่ต้องเปลี่ยนและไม่ต้อง deploy ใหม่
 */
export const dynamic = "force-dynamic";

export function GET() {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!base) {
    return NextResponse.json({ error: "download unavailable" }, { status: 503 });
  }
  return NextResponse.redirect(
    `${base}/storage/v1/object/public/app/storeos-android.apk`,
    { status: 307 },
  );
}
