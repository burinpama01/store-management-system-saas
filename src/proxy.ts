import { NextResponse, type NextRequest } from "next/server";
import { updateSession } from "@/server/integrations/supabase/middleware";
import { hostOf, isPrimaryHost, rewritePathForStoreDomain } from "@/modules/store-website/domains";

/**
 * โดเมนของร้านเอง (S4): host → slug ผ่าน RPC website_slug_for_domain (anon)
 * แคชในหน่วยความจำของ instance — เจอ 5 นาที / ไม่เจอ 1 นาที (ไม่ยิงฐานข้อมูลทุกครั้งที่ลูกค้าเปิด)
 */
const domainCache = new Map<string, { slug: string | null; expires: number }>();
const HIT_TTL = 5 * 60_000;
const MISS_TTL = 60_000;

async function slugForDomain(host: string): Promise<string | null> {
  const now = Date.now();
  const cached = domainCache.get(host);
  if (cached && cached.expires > now) return cached.slug;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return null;
  let slug: string | null = null;
  try {
    const res = await fetch(`${url}/rest/v1/rpc/website_slug_for_domain`, {
      method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ p_host: host }),
      cache: "no-store",
      signal: AbortSignal.timeout(3_000),
    });
    if (res.ok) {
      const value = (await res.json()) as unknown;
      slug = typeof value === "string" && /^[a-z0-9-]{3,40}$/.test(value) ? value : null;
    } else {
      // ฐานข้อมูลตอบผิดพลาด → ไม่แคชผลว่าง (ลองใหม่ครั้งหน้า)
      return null;
    }
  } catch {
    return null;
  }
  if (domainCache.size > 500) {
    // ลบเฉพาะที่หมดอายุก่อน — ล้างทั้งหมดเฉพาะเมื่อยังเยอะเกิน (กันยิงฐานข้อมูลพร้อมกันทีเดียว)
    for (const [k, v] of domainCache) if (v.expires <= now) domainCache.delete(k);
    if (domainCache.size > 500) domainCache.clear();
  }
  domainCache.set(host, { slug, expires: now + (slug ? HIT_TTL : MISS_TTL) });
  return slug;
}

/** path ที่ยอมให้ผ่านบนโดเมนร้าน (หน้าสมาชิก/ API ที่หน้าสั่งออนไลน์และสมาชิกเรียก) */
function isAllowedOnStoreDomain(pathname: string): boolean {
  return pathname.startsWith("/api/") || pathname.startsWith("/member/") || pathname.startsWith("/s/");
}

export async function proxy(request: NextRequest) {
  // ใช้ host จริงของคำขอ (ไม่เชื่อ x-forwarded-host ที่ client ปลอมได้ — กันแคชหน้าแรกโดนสลับเป็นเว็บร้าน)
  const host = hostOf(request.headers.get("host"));
  if (!isPrimaryHost(host)) {
    const slug = await slugForDomain(host);
    if (!slug) {
      return new NextResponse("ไม่พบเว็บไซต์ร้านสำหรับโดเมนนี้", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    const target = rewritePathForStoreDomain(request.nextUrl.pathname, slug);
    if (target) {
      const url = request.nextUrl.clone();
      url.pathname = target;
      return NextResponse.rewrite(url);
    }
    if (isAllowedOnStoreDomain(request.nextUrl.pathname)) return updateSession(request);
    // หน้าระบบหลังร้าน (login, dashboard ...) ไม่เปิดบนโดเมนร้าน → กลับหน้าแรกของร้าน
    const home = request.nextUrl.clone();
    home.pathname = "/";
    home.search = "";
    return NextResponse.redirect(home);
  }
  return updateSession(request);
}

export const config = {
  matcher: [
    // "s/" = เว็บไซต์ร้านสาธารณะ (/s/<slug>) — ไม่ต้องรีเฟรช session ทุกครั้งที่ลูกค้าเปิด
    // (ไม่งั้นทุกการเปิดหน้าเว็บร้าน = 1 invocation + 1 auth call ไป Supabase)
    "/((?!_next/static|_next/image|favicon.ico|s/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|zip|mp3)$).*)",
  ],
};
