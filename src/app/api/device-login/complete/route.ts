// POST /api/device-login/complete — เครื่องร้านแลกตั๋วครั้งเดียวเป็น session ของพนักงานที่อนุมัติ
//
// ทำไม POST (form submit) ไม่ใช่ GET: ตั๋วไม่ไปค้างใน URL/ประวัติเบราว์เซอร์/log ของ proxy
// สร้าง session ด้วย magic link ฝั่งเซิร์ฟเวอร์ (generateLink → verifyOtp) แล้วเซ็ต cookie ตามปกติ
// — admin.generateLink ไม่ส่งอีเมล และ token_hash ไม่ออกนอกเซิร์ฟเวอร์
//
// ลำดับ: ตรวจตั๋ว → สร้าง session → ค่อย mark completed
// (auth สะดุดกลางทาง = ตั๋วยังใช้ได้จนหมดอายุ ไม่ต้องให้พนักงานอนุมัติซ้ำ)
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { markDeviceLoginCompleted, verifyDeviceLoginTicket } from "@/modules/auth/device-login";
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

  const verified = await verifyDeviceLoginTicket(requestId, ticket);
  if (!verified) return back(request, "expired");

  try {
    const admin = await createSupabaseServiceClient();
    const { data: userRes, error: userErr } = await admin.auth.admin.getUserById(verified.userId);
    const email = userRes?.user?.email;
    if (userErr || !email) throw new Error(userErr?.message ?? "user has no email");

    const { data: link, error: linkErr } = await admin.auth.admin.generateLink({ type: "magiclink", email });
    const tokenHash = link?.properties?.hashed_token;
    if (linkErr || !tokenHash) throw new Error(linkErr?.message ?? "generateLink failed");

    const supabase = await createSupabaseServerClient();
    const { error: otpErr } = await supabase.auth.verifyOtp({ type: "magiclink", token_hash: tokenHash });
    if (otpErr) throw new Error(otpErr.message);

    // สร้าง session สำเร็จแล้วค่อยปิดตั๋ว — ถ้าตั๋วเดียวกันถูกใช้ไปก่อน (ยิงซ้อน) ให้ถอน session ที่เพิ่งสร้าง
    if (!(await markDeviceLoginCompleted(requestId, verified.ticketHash))) {
      await supabase.auth.signOut({ scope: "local" });
      return back(request, "expired");
    }

    // เปิดสาขาที่พนักงานอนุมัติไว้ (ไม่งั้นระบบเลือกสาขาแรกของบัญชี)
    if (verified.storeId) {
      (await cookies()).set("selected_store_id", verified.storeId, {
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
      message: `เครื่อง "${verified.deviceLabel ?? "ไม่ระบุชื่อ"}" เข้าใช้ด้วย QR`,
      storeId: verified.storeId ?? undefined,
      actorUserId: verified.userId,
      context: { requestId, deviceLabel: verified.deviceLabel },
    });
    return NextResponse.redirect(new URL("/pos", request.url), 303);
  } catch (error) {
    void logSystemEvent({
      level: "error",
      source: "auth.device-login",
      action: "complete",
      message: error instanceof Error ? error.message : "complete failed",
      actorUserId: verified.userId,
      context: { requestId },
    });
    return back(request, "failed");
  }
}
