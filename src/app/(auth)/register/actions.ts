"use server";

import { redirect } from "next/navigation";
import {
  createSupabaseServerClient,
  createSupabaseServiceClient,
} from "@/server/integrations/supabase/server";
import {
  buildUniqueSlug,
  validateRegistrationInput,
} from "@/modules/auth/registration";

export interface RegisterState {
  error: string | null;
  notice: string | null;
}

function logRegisterError(scope: string, error: { message?: string } | null) {
  if (process.env.NODE_ENV === "production") {
    console.error(`[register] ${scope} failed`);
    return;
  }
  console.error(`[register] ${scope} failed:`, error?.message);
}

export async function registerOwner(
  _prev: RegisterState,
  formData: FormData,
): Promise<RegisterState> {
  const input = {
    email: (formData.get("email") as string | null)?.trim() ?? "",
    password: (formData.get("password") as string | null) ?? "",
    organizationName: (formData.get("organizationName") as string | null)?.trim() ?? "",
    storeName: (formData.get("storeName") as string | null)?.trim() ?? "",
  };

  const validation = validateRegistrationInput(input);
  if (!validation.valid) {
    return { error: validation.errors.join(" · "), notice: null };
  }

  // Create the auth identity via the server client so session cookies are set
  // when email confirmation is disabled.
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signUp({
    email: input.email,
    password: input.password,
  });
  if (error) {
    logRegisterError("signUp", error);
    return { error: "สมัครไม่สำเร็จ กรุณาลองใหม่อีกครั้ง", notice: null };
  }
  const user = data.user;
  if (!user) {
    return { error: "สมัครไม่สำเร็จ กรุณาลองใหม่อีกครั้ง", notice: null };
  }
  // Supabase returns a user with an empty identities array when the email already exists.
  if (Array.isArray(user.identities) && user.identities.length === 0) {
    return { error: "อีเมลนี้ถูกใช้งานแล้ว กรุณาเข้าสู่ระบบ", notice: null };
  }

  // Bootstrap tenant via service client: a brand-new user has no membership yet,
  // so RLS would block these inserts under the user-scoped client.
  const svc = await createSupabaseServiceClient();

  const { data: org, error: orgErr } = await svc
    .from("organizations")
    .insert({
      name: input.organizationName,
      slug: buildUniqueSlug(input.organizationName, "org"),
      owner_id: user.id,
    })
    .select("id")
    .single();
  if (orgErr || !org) {
    logRegisterError("create organization", orgErr);
    return { error: "สร้างกิจการไม่สำเร็จ กรุณาลองใหม่อีกครั้ง", notice: null };
  }

  const { data: store, error: storeErr } = await svc
    .from("stores")
    .insert({
      organization_id: org.id,
      name: input.storeName,
      slug: buildUniqueSlug(input.storeName, "store"),
      currency_code: "THB",
      timezone: "Asia/Bangkok",
      locale: "th-TH",
    })
    .select("id")
    .single();
  if (storeErr || !store) {
    logRegisterError("create store", storeErr);
    await svc.from("organizations").delete().eq("id", org.id);
    return { error: "สร้างร้านไม่สำเร็จ กรุณาลองใหม่อีกครั้ง", notice: null };
  }

  const now = new Date().toISOString();
  const { error: memErr } = await svc.from("memberships").insert({
    organization_id: org.id,
    store_id: null,
    user_id: user.id,
    role: "owner",
    invited_at: now,
    joined_at: now,
  });
  if (memErr) {
    logRegisterError("create membership", memErr);
    await svc.from("stores").delete().eq("id", store.id);
    await svc.from("organizations").delete().eq("id", org.id);
    return { error: "ตั้งค่าสิทธิ์เจ้าของไม่สำเร็จ กรุณาลองใหม่อีกครั้ง", notice: null };
  }

  // Default free subscription is best-effort; billing falls back to free when absent.
  await svc
    .from("subscriptions")
    .insert({ organization_id: org.id, plan: "free", status: "active" });

  if (data.session) {
    redirect("/onboarding");
  }

  return {
    error: null,
    notice: "สร้างบัญชีสำเร็จ กรุณายืนยันอีเมลของคุณ แล้วเข้าสู่ระบบ",
  };
}
