"use server";

/**
 * คนที่ลาออกจากร้านเดิมแล้ว เปิดร้านของตัวเองด้วยบัญชีเดิม (ไม่ต้องสมัครใหม่)
 * สร้างกิจการ + สาขาแรก + สิทธิ์เจ้าของ แบบเดียวกับหน้าสมัคร แล้วพาไปเลือกแพ็กเกจ
 */
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getCurrentUser, getUserStores } from "@/modules/auth/session";
import { buildUniqueSlug } from "@/modules/auth/registration";
import { logSystemEvent } from "@/modules/system/event-log";
import { notifyPlatformAdmin } from "@/modules/system/admin-alert";
import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";

export interface OpenStoreState {
  error: string | null;
}

function cleanName(raw: FormDataEntryValue | null): string {
  return String(raw ?? "").replace(/\s+/g, " ").trim();
}

export async function openOwnStoreAction(_prev: OpenStoreState, formData: FormData): Promise<OpenStoreState> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const organizationName = cleanName(formData.get("organizationName"));
  const storeName = cleanName(formData.get("storeName")) || organizationName;
  if (organizationName.length < 2 || organizationName.length > 100) return { error: "ชื่อกิจการต้องยาว 2–100 ตัวอักษร" };
  if (storeName.length < 2 || storeName.length > 100) return { error: "ชื่อร้านต้องยาว 2–100 ตัวอักษร" };

  // ยังมีร้านที่ใช้งานได้อยู่ (เช่นเป็นเจ้าของร้านอื่นแล้ว) = ไม่ต้องสร้างซ้ำ
  const { stores } = await getUserStores();
  if (stores.length > 0) redirect("/dashboard");

  const svc = await createSupabaseServiceClient();
  // กดซ้ำ/เปิดสองแท็บ = ห้ามสร้างกิจการซ้ำ (getUserStores แคชต่อคำขอ จึงกันเองไม่ได้)
  const { data: owned } = await svc
    .from("organizations")
    .select("id, created_at")
    .eq("owner_id", user.id)
    .gte("created_at", new Date(Date.now() - 10 * 60_000).toISOString())
    .limit(1);
  if (owned && owned.length > 0) return { error: "กำลังสร้างร้านอยู่ หรือสร้างไปแล้วเมื่อสักครู่ — รอสักครู่แล้วเข้าสู่ระบบใหม่" };
  const fail = async (step: string, err: unknown, cleanup: () => Promise<void>) => {
    await cleanup().catch(() => undefined);
    await logSystemEvent({
      level: "error",
      source: "auth.account-inactive",
      action: "openOwnStoreAction",
      message: `เปิดร้านของตัวเองไม่สำเร็จ (${step}): ${err instanceof Error ? err.message : (err as { message?: string })?.message ?? String(err)}`,
      actorUserId: user.id,
    }).catch(() => undefined);
    return { error: "เปิดร้านไม่สำเร็จ กรุณาลองใหม่อีกครั้ง" };
  };

  const { data: org, error: orgErr } = await svc
    .from("organizations")
    .insert({ name: organizationName, slug: buildUniqueSlug(organizationName, "org"), owner_id: user.id })
    .select("id")
    .single();
  if (orgErr || !org) return fail("create organization", orgErr, async () => undefined);

  const { data: store, error: storeErr } = await svc
    .from("stores")
    .insert({
      organization_id: org.id,
      name: storeName,
      slug: buildUniqueSlug(storeName, "store"),
      currency_code: "THB",
      timezone: "Asia/Bangkok",
      locale: "th-TH",
    })
    .select("id")
    .single();
  if (storeErr || !store) {
    return fail("create store", storeErr, async () => {
      await svc.from("organizations").delete().eq("id", org.id);
    });
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
    return fail("create membership", memErr, async () => {
      await svc.from("stores").delete().eq("id", store.id);
      await svc.from("organizations").delete().eq("id", org.id);
    });
  }

  // สิทธิ์ทดลองใช้เหมือนหน้าสมัคร — แคมเปญปิด/เคยใช้สิทธิ์แล้วไม่ถือเป็นความผิดพลาด
  const { data: trialRows, error: trialErr } = await svc.rpc("claim_free_trial", {
    p_organization_id: org.id,
    p_user_id: user.id,
  });
  const trialClaimed = Boolean(trialRows?.[0]?.ok);

  await logSystemEvent({
    level: trialErr ? "warn" : "info",
    source: "auth.account-inactive",
    action: "openOwnStoreAction",
    message: `พนักงานที่ลาออกแล้วเปิดร้านของตัวเอง: ${organizationName}${trialClaimed ? " (รับสิทธิ์ทดลอง)" : ""}`,
    organizationId: org.id,
    storeId: store.id,
    actorUserId: user.id,
    context: { trialClaimed, trialError: trialErr?.message ?? null },
  });
  void notifyPlatformAdmin({
    source: "auth.account-inactive",
    action: "tenantSignedUp",
    level: "info",
    subject: `มีร้านเปิดใหม่ (จากบัญชีพนักงานเดิม): ${organizationName}`,
    body: [`ชื่อกิจการ: ${organizationName}`, `สาขาแรก: ${storeName}`, trialClaimed ? "รับสิทธิ์ทดลองแล้ว" : "ไม่ได้รับสิทธิ์ทดลอง"].join("\n"),
    context: { organizationId: org.id, storeId: store.id, trialClaimed },
  });

  (await cookies()).set("selected_store_id", store.id, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 30,
  });
  redirect(trialClaimed ? "/onboarding?linePrompt=1" : "/settings/billing");
}
