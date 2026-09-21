import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import type { Database } from "./database.types";

export async function updateSession(request: NextRequest) {
  // Expose the current path to Server Components (for subscription-expiry gating).
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-pathname", request.nextUrl.pathname);

  let supabaseResponse = NextResponse.next({ request: { headers: requestHeaders } });

  const supabase = createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({ request: { headers: requestHeaders } });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // Refresh session token — must not write any logic between createServerClient and getUser()
  const { data: { user } } = await supabase.auth.getUser();

  const isAuthRoute =
    request.nextUrl.pathname.startsWith("/login") ||
    request.nextUrl.pathname.startsWith("/reset-password") ||
    request.nextUrl.pathname.startsWith("/update-password") ||
    request.nextUrl.pathname.startsWith("/auth");
  const isPublicRoute =
    request.nextUrl.pathname === "/" ||
    request.nextUrl.pathname === "/qr" ||
    request.nextUrl.pathname.startsWith("/qr/") ||
    // QR ขอเพลงของร้าน (ลูกค้าไม่ได้ล็อกอิน) — ระวัง: "/music-requests" ของพนักงานไม่ขึ้นต้น "/music/"
    request.nextUrl.pathname.startsWith("/music/") ||
    request.nextUrl.pathname === "/member" ||
    request.nextUrl.pathname.startsWith("/member/") ||
    request.nextUrl.pathname === "/pricing" ||
    request.nextUrl.pathname === "/register" ||
    request.nextUrl.pathname === "/privacy-policy" ||
    request.nextUrl.pathname === "/terms-of-service" ||
    request.nextUrl.pathname === "/account-deletion" ||
    request.nextUrl.pathname.startsWith("/download/") ||
    request.nextUrl.pathname === "/api/line/webhook" ||
    request.nextUrl.pathname === "/api/print/hub/poll" ||
    request.nextUrl.pathname === "/api/print/hub/ack" ||
    // StoreOS Launcher บนเครื่องแคชเชียร์ส่ง log กลับมา (auth ด้วย Hub token ใน handler
    // ไม่มี session ผู้ใช้ เพราะโปรแกรมทำงานตั้งแต่ก่อนใครล็อกอินเข้าเว็บ)
    request.nextUrl.pathname === "/api/launcher/logs" ||
    // Launcher 0.5.0+ ตรวจรุ่นใหม่ตั้งแต่ก่อนมีใครล็อกอิน (ข้อมูลเดียวกับลิงก์ดาวน์โหลดที่ public อยู่แล้ว)
    request.nextUrl.pathname === "/api/launcher/latest" ||
    // Launcher อ่านรุ่นล่าสุดของ Print Hub เพื่ออัปเดต agent ให้ — เหตุผลเดียวกับด้านบน
    request.nextUrl.pathname === "/api/print/hub/agent-latest" ||
    // StoreOS Connect: webhook ขาเข้าจาก JDC (auth ด้วย HMAC ใน handler ไม่ใช้ session)
    request.nextUrl.pathname.startsWith("/api/connect/v1/webhooks/") ||
    // BYO payment gateways (Beam / TrueMoney): webhook ขาเข้า — auth ด้วย HMAC/JWT
    // ต่อร้านใน handler ไม่มี session ผู้ใช้
    request.nextUrl.pathname.startsWith("/api/payments/webhooks/") ||
    // StoreOS Connect: cron reconcile (auth ด้วย CRON_SECRET ใน handler)
    request.nextUrl.pathname.startsWith("/api/connect/cron/") ||
    // แจ้งเตือนบุฟเฟต์ใกล้หมดเวลา: cron (auth ด้วย CRON_SECRET ใน handler)
    request.nextUrl.pathname.startsWith("/api/notifications/cron/") ||
    // Public REST API (Enterprise) — auth ด้วย API key ใน handler เอง ไม่ใช้ session
    request.nextUrl.pathname.startsWith("/api/v1/") ||
    // Same-origin proxy for receipt logo/footer images. Serves only public
    // Supabase storage objects (SSRF-guarded), so it needs no session — and
    // staying public avoids any auth-redirect breaking the raster image load.
    request.nextUrl.pathname === "/api/receipt-image";

  if (!user && !isAuthRoute && !isPublicRoute) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  // แอปมือถือ (Capacitor ตั้ง appendUserAgent) เปิดมาที่ / เสมอ — ข้ามหน้า landing:
  // ล็อกอินแล้วเข้าแอปทันที ยังไม่ล็อกอินไปหน้า login เลย (เว็บปกติยังเห็น landing เหมือนเดิม)
  const isNativeApp = (request.headers.get("user-agent") ?? "").includes("StoreOSApp");
  if (isNativeApp && request.nextUrl.pathname === "/") {
    const url = request.nextUrl.clone();
    url.pathname = user ? "/app-entry" : "/login";
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}
