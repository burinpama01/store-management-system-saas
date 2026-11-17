import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import { sendSmskubMessage } from "@/modules/notifications/smskub";
import { logSystemEvent } from "@/modules/system/event-log";

/**
 * SMS ภารกิจสะสม (M2) — คิวอยู่ใน DB, pg_cron เรียก API เมื่อมีคิวรอ
 * ภาษาไทยส่งแบบ UCS-2: 70 ตัวอักษร = 1 เครดิต, ข้อความยาว (แบ่งส่ง) = 67 ตัวต่อเครดิต
 * จำกัดไม่เกิน 2 เครดิต (134 ตัว) — ตัดชื่อร้าน/ภารกิจก่อน ลิงก์ต้องอยู่ครบ
 */

export type MissionSmsKind = "near" | "reward" | "expiring";

export interface MissionSmsRow {
  id: string;
  kind: MissionSmsKind;
  phone: string;
  storeName: string;
  storeSlug: string;
  missionName: string | null;
  rewardName: string | null;
  voucherExpiresAt: string | null;
}

export const SMS_MAX_CHARS = 134;
const SHORT_LINK_BASE = "store-os.online/m/";

/** ความยาวแบบนับ code unit (UCS-2) ซึ่งเป็นวิธีที่ผู้ให้บริการนับเครดิต */
export function smsLength(text: string): number {
  return text.length;
}

export function smsCredits(text: string): number {
  const len = smsLength(text);
  if (len <= 70) return 1;
  return Math.ceil(len / 67);
}

function clip(text: string, max: number): string {
  const chars = Array.from(text.trim());
  return chars.length <= max ? chars.join("") : `${chars.slice(0, Math.max(max - 1, 1)).join("")}…`;
}

function thaiShortDate(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("th-TH", { day: "numeric", month: "short", timeZone: "Asia/Bangkok" }).replace(/\s+/g, "");
}

export function buildMissionSms(row: Pick<MissionSmsRow, "kind" | "storeName" | "storeSlug" | "missionName" | "voucherExpiresAt">): string {
  const link = `${SHORT_LINK_BASE}${row.storeSlug}`;
  const body =
    row.kind === "near"
      ? `อีก 1 ชิ้นครบภารกิจ ${clip(row.missionName ?? "", 24)} รับรางวัลเลย`
      : row.kind === "reward"
        ? `ยินดีด้วย! ทำภารกิจครบ ได้คูปองรางวัลแล้ว ใช้ได้ถึง${thaiShortDate(row.voucherExpiresAt)}`
        : `คูปองรางวัลภารกิจจะหมดอายุ${thaiShortDate(row.voucherExpiresAt)} แวะมาใช้นะ`;
  const tail = ` ${link}`;
  const budget = SMS_MAX_CHARS - smsLength(body) - smsLength(tail) - 2;
  const store = clip(row.storeName, Math.max(Math.min(budget, 20), 4));
  let message = `${store}: ${body}${tail}`;
  if (smsLength(message) > SMS_MAX_CHARS) message = `${body}${tail}`;
  return message;
}

/** จองคิว → ส่ง → บันทึกผล ทีละข้อความ (เพดาน/ยินยอม/เวลาส่ง ตรวจใน claim_store_mission_sms) */
export async function runMissionSms(limit = 50): Promise<{ claimed: number; sent: number; failed: number }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- RPC ใหม่ยังไม่อยู่ใน database.types
  const db: any = await createSupabaseServiceClient();
  const { data, error } = await db.rpc("claim_store_mission_sms", { p_limit: limit });
  if (error) throw new Error(`claim_store_mission_sms: ${error.message}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- แถวดิบจาก RPC
  const rows: MissionSmsRow[] = ((data ?? []) as any[]).map((r) => ({
    id: r.id,
    kind: r.kind,
    phone: r.phone,
    storeName: r.store_name,
    storeSlug: r.store_slug,
    missionName: r.mission_name,
    rewardName: r.reward_name,
    voucherExpiresAt: r.voucher_expires_at,
  }));

  let sent = 0;
  let failed = 0;
  for (const row of rows) {
    const message = buildMissionSms(row);
    try {
      await sendSmskubMessage(row.phone, message, `StoreOS Missions ${row.storeSlug.slice(0, 30)}`);
      await db.rpc("finish_store_mission_sms", { p_id: row.id, p_ok: true, p_message: message, p_error: null });
      sent += 1;
    } catch (e) {
      failed += 1;
      const detail = e instanceof Error ? e.message : String(e);
      await db.rpc("finish_store_mission_sms", { p_id: row.id, p_ok: false, p_message: message, p_error: detail });
      void logSystemEvent({
        level: "error",
        source: "missions.sms",
        action: "send",
        message: `ส่ง SMS ภารกิจไม่สำเร็จ: ${detail.slice(0, 200)}`,
        context: { queueId: row.id, kind: row.kind, credits: smsCredits(message) },
      });
    }
  }

  void logSystemEvent({
    level: failed > 0 ? "warn" : "info",
    source: "missions.sms",
    action: "run",
    message: `SMS ภารกิจ: จอง ${rows.length} ส่งสำเร็จ ${sent} ล้มเหลว ${failed}`,
    context: { claimed: rows.length, sent, failed },
  });
  return { claimed: rows.length, sent, failed };
}
