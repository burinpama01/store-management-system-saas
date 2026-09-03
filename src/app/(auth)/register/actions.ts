"use server";

import { redirect } from "next/navigation";
import { logActionError } from "@/modules/system/event-log";
import {
  createSupabaseServerClient,
  createSupabaseServiceClient,
} from "@/server/integrations/supabase/server";
import {
  buildUniqueSlug,
  validateRegistrationInput,
} from "@/modules/auth/registration";
import { FREE_TRIAL_DAYS } from "@/modules/billing/free-trial";

export interface RegisterState {
  error: string | null;
  notice: string | null;
}

function logRegisterError(scope: string, error: { message?: string } | null) {
  if (process.env.NODE_ENV === "production") {
    logActionError({ source: "auth.register", action: scope, error: error ?? new Error(scope) });
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

  // On any bootstrap failure, remove the just-created auth user too. Otherwise the
  // email is "taken" (signUp returns empty identities) yet has no tenant, leaving
  // the user unable to re-register or use the app.
  const rollback = async () => {
    try {
      await svc.auth.admin.deleteUser(user.id);
    } catch (e) {
      logRegisterError("rollback delete auth user", e as { message?: string });
    }
  };

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
    await rollback();
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
    await rollback();
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
    await rollback();
    return { error: "ตั้งค่าสิทธิ์เจ้าของไม่สำเร็จ กรุณาลองใหม่อีกครั้ง", notice: null };
  }

  // แคมเปญทดลอง Enterprise ฟรี 30 วัน: กดรับให้อัตโนมัติตอนสมัคร และตัดสิทธิ์
  // ครั้งเดียวทันที กันไปกดซ้ำที่หน้า Billing ทีหลัง
  // แคมเปญปิดอยู่/ถูกใช้สิทธิ์ไปแล้ว ไม่ถือเป็นความผิดพลาดของการสมัคร —
  // ปล่อยให้สมัครสำเร็จแล้วไปเลือกซื้อแพ็กเกจที่หน้า Billing แทน
  const { data: trialRows, error: trialErr } = await svc.rpc("claim_free_trial", {
    p_organization_id: org.id,
    p_user_id: user.id,
  });
  const trialClaimed = Boolean(trialRows?.[0]?.ok);
  if (trialErr) {
    logRegisterError("claim free trial", trialErr);
  }

  if (data.session) {
    redirect("/onboarding?linePrompt=1");
  }

  return {
    error: null,
    notice: trialClaimed
      ? `สร้างบัญชีสำเร็จ รับสิทธิ์ทดลอง Enterprise ฟรี ${FREE_TRIAL_DAYS} วันแล้ว กรุณายืนยันอีเมลของคุณ แล้วเข้าสู่ระบบ`
      : "สร้างบัญชีสำเร็จ กรุณายืนยันอีเมลของคุณ แล้วเข้าสู่ระบบ",
  };
}
