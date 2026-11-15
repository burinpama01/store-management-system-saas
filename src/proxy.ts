import { type NextRequest } from "next/server";
import { updateSession } from "@/server/integrations/supabase/middleware";

export async function proxy(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  matcher: [
    // "s/" = เว็บไซต์ร้านสาธารณะ (/s/<slug>) — ไม่ต้องรีเฟรช session ทุกครั้งที่ลูกค้าเปิด
    // (ไม่งั้นทุกการเปิดหน้าเว็บร้าน = 1 invocation + 1 auth call ไป Supabase)
    "/((?!_next/static|_next/image|favicon.ico|s/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|zip|mp3)$).*)",
  ],
};
