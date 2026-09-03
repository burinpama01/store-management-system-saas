/**
 * แจ้งผู้ดูแลแพลตฟอร์ม (ซูเปอร์แอดมิน) เรื่องที่ต้องรู้ทันที
 *
 * ใช้กับเหตุการณ์ที่ "ไม่มีใครอยู่หน้างานคอยดู" เช่น มีร้านสมัครใหม่, ร้านใกล้หมดอายุ,
 * Stripe webhook ล้มเหลว — ทุกครั้งจะบันทึกลง /system/logs ด้วยเสมอ เพื่อให้ย้อนดูได้
 * แม้อีเมลจะส่งไม่ออก (โดเมนยังไม่ verify ก็ยังเห็นใน log)
 */
import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import { sendTransactionalEmail } from "@/modules/notifications/email";
import { getEnterpriseFromEmail } from "@/modules/billing/platform-settings";
import { logSystemEvent } from "./event-log";

export interface AdminAlertInput {
  /** ส่วนของระบบที่เป็นต้นเรื่อง เช่น "billing.subscription-watch" */
  readonly source: string;
  readonly action: string;
  readonly subject: string;
  /** เนื้อความแบบข้อความล้วน (จะถูกแปลงเป็น HTML ให้) */
  readonly body: string;
  readonly level?: "error" | "warn" | "info";
  readonly context?: Record<string, unknown> | null;
}

export interface AdminAlertResult {
  readonly emailed: boolean;
  readonly skipped: boolean;
  readonly message: string;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** ห่อข้อความล้วนเป็น HTML อ่านง่าย โดยคงการขึ้นบรรทัดไว้ */
export function buildAdminAlertHtml(subject: string, body: string): string {
  return [
    `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:560px;margin:0 auto;color:#1f2937">`,
    `<h2 style="color:#111827;font-size:18px">${escapeHtml(subject)}</h2>`,
    `<pre style="font-size:14px;line-height:1.6;white-space:pre-wrap;font-family:inherit;margin:0">${escapeHtml(body)}</pre>`,
    `<hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 0" />`,
    `<p style="font-size:12px;color:#6b7280">StoreOS · แจ้งเตือนผู้ดูแลแพลตฟอร์ม · ดูรายละเอียดที่ /system/logs</p>`,
    `</div>`,
  ].join("");
}

/**
 * หาอีเมลผู้ดูแลแพลตฟอร์ม: ตั้งทับด้วย PLATFORM_ALERT_EMAIL ได้ ไม่งั้นใช้ super_admin คนแรก
 * คืน null เมื่อหาไม่เจอ — ผู้เรียกต้องยอมให้ข้ามไปโดยไม่พัง
 */
export async function resolveAdminAlertEmail(): Promise<string | null> {
  const override = process.env.PLATFORM_ALERT_EMAIL?.trim();
  if (override) return override;

  try {
    const supabase = await createSupabaseServiceClient();
    const { data } = await supabase
      .from("memberships")
      .select("user_id")
      .eq("role", "super_admin")
      .limit(1)
      .maybeSingle();
    if (!data?.user_id) return null;
    const { data: userData } = await supabase.auth.admin.getUserById(data.user_id);
    return userData.user?.email ?? null;
  } catch {
    return null;
  }
}

/**
 * ส่งแจ้งเตือนถึงผู้ดูแล — ไม่ throw เด็ดขาด และบันทึก log ทุกเส้นทาง
 * (ส่งสำเร็จ / ข้ามเพราะยังไม่ตั้งค่าอีเมล / ส่งไม่ออก)
 */
export async function notifyPlatformAdmin(input: AdminAlertInput): Promise<AdminAlertResult> {
  const level = input.level ?? "info";

  // บันทึกก่อนส่งเสมอ — เหตุการณ์ต้องไม่หายแม้อีเมลจะส่งไม่ออก
  await logSystemEvent({
    level,
    source: input.source,
    action: input.action,
    message: input.subject,
    context: { ...(input.context ?? {}), รายละเอียด: input.body.slice(0, 800) },
  });

  const to = await resolveAdminAlertEmail();
  if (!to) {
    await logSystemEvent({
      level: "warn",
      source: input.source,
      action: `${input.action}:email`,
      message: "ข้ามการส่งอีเมลถึงผู้ดูแล: หาอีเมลปลายทางไม่ได้",
    });
    return { emailed: false, skipped: true, message: "ไม่พบอีเมลผู้ดูแลแพลตฟอร์ม" };
  }

  const from = (await getEnterpriseFromEmail()) ?? undefined;
  const result = await sendTransactionalEmail({
    to,
    from,
    subject: `StoreOS — ${input.subject}`,
    html: buildAdminAlertHtml(input.subject, input.body),
    text: `${input.subject}\n\n${input.body}\n\nStoreOS`,
  });

  if (!result.ok || result.skipped) {
    await logSystemEvent({
      level: "warn",
      source: input.source,
      action: `${input.action}:email`,
      message: `ส่งอีเมลถึงผู้ดูแลไม่สำเร็จ: ${result.message}`,
      context: { skipped: result.skipped },
    });
  }

  return { emailed: result.ok && !result.skipped, skipped: result.skipped, message: result.message };
}
