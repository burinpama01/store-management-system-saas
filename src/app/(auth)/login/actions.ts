"use server";

import { createSupabaseServerClient } from "@/server/integrations/supabase/server";
import { redirect } from "next/navigation";

function logSignInError(error: { code?: string; message: string }) {
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

  redirect("/dashboard");
}
