"use server";

import { createSupabaseServerClient } from "@/server/integrations/supabase/server";
import { logActionError } from "@/modules/system/event-log";
import { landingPathForCurrentUser } from "@/modules/auth/guards";
import { RETURN_TO_PARAM, sanitizeReturnTo } from "@/modules/auth/return-to";
import { redirect } from "next/navigation";

function logSignInError(error: { code?: string; message: string }) {
  logActionError({ source: "auth.login", action: "signIn", error });
  if (process.env.NODE_ENV === "production") {
    console.error("[signIn] Supabase error:", error.code ?? "unknown");
    return;
  }
  console.error("[signIn] Supabase error:", error.code, error.message);
}

export async function signIn(
  _prevState: { error: string | null },
  formData: FormData,
): Promise<{ error: string | null }> {
  const email = (formData.get("email") as string | null)?.trim() ?? "";
  const password = (formData.get("password") as string | null) ?? "";

  if (!email || !password) {
    return { error: "กรุณากรอก Email และ Password" };
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    const msg = error.message.toLowerCase();
    const isInvalid =
      msg.includes("invalid login credentials") || msg.includes("invalid credentials");
    logSignInError(error);
    return {
      error: isInvalid ? "Email หรือ Password ไม่ถูกต้อง" : "เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง",
    };
  }

  // กลับไปหน้าที่ตั้งใจจะเปิดก่อนถูกพามาล็อกอิน (ตรวจซ้ำฝั่ง server — ค่าในฟอร์มแก้ได้)
  const returnTo = sanitizeReturnTo(formData.get(RETURN_TO_PARAM));
  if (returnTo) redirect(returnTo);
  const landing = await landingPathForCurrentUser();
  // สิทธิ์ยังโหลดไม่ทันจะได้ /login กลับมา — กันวนกลับหน้าล็อกอินหลังล็อกอินสำเร็จ
  redirect(landing === "/login" ? "/dashboard" : landing);
}
