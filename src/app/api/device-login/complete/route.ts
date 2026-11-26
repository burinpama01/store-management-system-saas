// POST /api/device-login/complete — เครื่องร้านแลกตั๋วครั้งเดียวเป็น session ของพนักงานที่อนุมัติ
//
// ทำไม POST (form submit) ไม่ใช่ GET: ตั๋วไม่ไปค้างใน URL/ประวัติเบราว์เซอร์/log ของ proxy
// สร้าง session ด้วย magic link ฝั่งเซิร์ฟเวอร์ (generateLink → verifyOtp) แล้วเซ็ต cookie ตามปกติ
// — ไม่มีการส่งอีเมล และ token_hash ไม่ออกนอกเซิร์ฟเวอร์
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { consumeDeviceLoginTicket } from "@/modules/auth/device-login";
import { createSupabaseServerClient, createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import { logSystemEvent } from "@/modules/system/event-log";

export const dynamic = "force-dynamic";

function back(request: Request, error: string) {
  const url = new URL("/device-login", request.url);
  url.searchParams.set("error", error);
  return NextResponse.redirect(url, 303);
}

export async function POST(request: Request) {
  const form = await request.formData().catch(() => null);
  const requestId = String(form?.get("requestId") ?? "");
  const ticket = String(form?.get("ticket") ?? "");

  const consumed = await consumeDeviceLoginTicket(requestId, ticket);
  if (!consumed) return back(request, "expired");

  try {
    const admin = await createSupabaseServiceClient();
    const { data: userRes, error: userErr } = await admin.auth.admin.getUserById(consumed.userId);
    const email = userRes?.user?.email;
    if (userErr || !email) throw new Error(userErr?.message ?? "user has no email");

    const { data: link, error: linkErr } = await admin.auth.admin.generateLink({ type: "magiclink", email });
    const tokenHash = link?.properties?.hashed_token;
    if (linkErr || !tokenHash) throw new Error(linkErr?.message ?? "generateLink failed");

    const supabase = await createSupabaseServerClient();
    const { error: otpErr } = await supabase.auth.verifyOtp({ type: "magiclink", token_hash: tokenHash });
    if (otpErr) throw new Error(otpErr.message);

    // เปิดสาขาที่พนักงานอนุมัติไว้ (ไม่งั้นระบบเลือกสาขาแรกของบัญชี)
    if (consumed.storeId) {
      (await cookies()).set("selected_store_id", consumed.storeId, {
        path: "/",
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        maxAge: 60 * 60 * 24 * 30,
      });
    }

    void logSystemEvent({
      level: "info",
      source: "auth.device-login",
      action: "complete",
      message: `เครื่อง "${consumed.deviceLabel ?? "ไม่ระบุชื่อ"}" เข้าใช้ด้วย QR`,
      storeId: consumed.storeId ?? undefined,
      actorUserId: consumed.userId,
      context: { requestId, deviceLabel: consumed.deviceLabel },
    });
    return NextResponse.redirect(new URL("/pos", request.url), 303);
  } catch (error) {
    void logSystemEvent({
      level: "error",
      source: "auth.device-login",
      action: "complete",
      message: error instanceof Error ? error.message : "complete failed",
      actorUserId: consumed.userId,
      context: { requestId },
    });
    return back(request, "failed");
  }
}
