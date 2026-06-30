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
    request.nextUrl.pathname === "/member" ||
    request.nextUrl.pathname.startsWith("/member/") ||
    request.nextUrl.pathname === "/pricing" ||
    request.nextUrl.pathname === "/register" ||
    request.nextUrl.pathname === "/privacy-policy" ||
    request.nextUrl.pathname === "/terms-of-service" ||
    request.nextUrl.pathname === "/api/line/webhook" ||
    request.nextUrl.pathname === "/api/print/hub/poll" ||
    request.nextUrl.pathname === "/api/print/hub/ack" ||
    // StoreOS Connect: webhook ขาเข้าจาก JDC (auth ด้วย HMAC ใน handler ไม่ใช้ session)
    request.nextUrl.pathname.startsWith("/api/connect/v1/webhooks/") ||
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

  return supabaseResponse;
}
