import { NextResponse } from "next/server";

/**
 * ดาวน์โหลด StoreOS Launcher สำหรับเครื่องแคชเชียร์ Windows — redirect ไปไฟล์ zip
 * ใน Supabase public storage (bucket `app`, path `storeos-launcher.zip`)
 *
 * ในชุดมี: ตัวโปรแกรม (self-contained ไม่ต้องลง .NET), install.cmd ที่ติดตั้ง
 * WebView2 + Print Hub + Node ให้อัตโนมัติ และสคริปต์ตรวจชุดรู้จำเสียง
 * สร้างไฟล์ด้วย scripts/windows-launcher/build-launcher.ps1 แล้วอัปโหลดทับ path เดิม
 * ลิงก์สาธารณะ /download/windows-launcher ไม่ต้องเปลี่ยนและไม่ต้อง deploy ใหม่
 */
export const dynamic = "force-dynamic";

export function GET() {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!base) {
    return NextResponse.json({ error: "download unavailable" }, { status: 503 });
  }
  return NextResponse.redirect(
    `${base}/storage/v1/object/public/app/storeos-launcher.zip`,
    { status: 307 },
  );
}
