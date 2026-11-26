import { NextResponse } from "next/server";
import { posLauncherDownloadUrl } from "@/modules/launcher/pos-launcher-version";

/**
 * ดาวน์โหลดโปรแกรม StoreOS POS สำหรับเครื่องแคชเชียร์ Windows (ขาย + พิมพ์ตรงเข้าเครื่องพิมพ์ IP
 * + จอลูกค้า + เพลง) — ส่งต่อไปไฟล์บน GitHub Releases (public) เหมือน /download/windows-launcher
 */
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.redirect(posLauncherDownloadUrl(), { status: 307 });
}
