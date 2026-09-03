/**
 * รันงานเฝ้าดูวันหมดอายุแพ็กเกจ — เรียกวันละครั้งจาก cron
 *
 * แยกจาก subscription-watch.ts (ตรรกะบริสุทธิ์) เพราะไฟล์นี้แตะฐานข้อมูลและส่งของออกจริง
 * กันยิงซ้ำด้วยการ insert ลง subscription_alert_log ก่อนส่ง — ชน unique index เมื่อไหร่
 * แปลว่ามีคนยิงไปแล้ววันนี้ ให้ข้าม (cron รันซ้ำ/สองอินสแตนซ์พร้อมกันก็ปลอดภัย)
 */
import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import { notifyOwnerNow } from "@/modules/notifications/dispatcher";
import { logActionError, logSystemEvent } from "@/modules/system/event-log";
import { notifyPlatformAdmin } from "@/modules/system/admin-alert";
import { isExpiringState, type BillingPlan, type BillingStatus } from "./types";
import {
  alertIdempotencyKey,
  buildAdminDigest,
  buildTenantAlertCopy,
  planSubscriptionAlerts,
  type SubscriptionAlert,
  type WatchedSubscription,
} from "./subscription-watch";

const SOURCE = "billing.subscription-watch";

export interface SubscriptionWatchResult {
  readonly day: string;
  readonly scanned: number;
  readonly alerted: number;
  readonly skipped: number;
  readonly failed: number;
}

/** วันปัจจุบันตามเวลาไทย — ต้องตรงกับคอลัมน์ alerted_on */
function bangkokDay(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** ดึง subscription ทุกรายพร้อมข้อมูลที่จำเป็นต่อการตัดสินใจ */
async function loadWatchedSubscriptions(): Promise<WatchedSubscription[]> {
  const supabase = await createSupabaseServiceClient();
  const [subsRes, orgsRes] = await Promise.all([
    supabase
      .from("subscriptions")
      .select("organization_id, plan, status, current_period_end, promo_trial_code, enterprise_limited"),
    supabase.from("organizations").select("id, name, suspended_at"),
  ]);
  if (subsRes.error) throw subsRes.error;
  if (orgsRes.error) throw orgsRes.error;

  const orgById = new Map((orgsRes.data ?? []).map((o) => [o.id, o]));

  return (subsRes.data ?? []).flatMap((row) => {
    const org = orgById.get(row.organization_id);
    if (!org) return [];
    const raw = row as Record<string, unknown>;
    const plan = row.plan as BillingPlan;
    const promoTrial = Boolean(raw.promo_trial_code);
    return [
      {
        organizationId: row.organization_id,
        organizationName: org.name,
        plan,
        promoTrial,
        currentPeriodEnd: row.current_period_end,
        suspended: Boolean(org.suspended_at),
        // ตัวตัดสินเดียวกับที่ด่านสิทธิ์ใช้จริง — สัญญาไม่มีวันหมดอายุจะไม่ถูกเตือน
        expires: isExpiringState({
          plan,
          status: row.status as BillingStatus,
          currentPeriodEnd: row.current_period_end,
          cancelAtPeriodEnd: false,
          trialEnd: null,
          promoTrial,
          enterpriseLimited: Boolean(raw.enterprise_limited),
        }),
      },
    ];
  });
}

/**
 * จองสิทธิ์ส่งของขั้นนี้ในวันนี้ — true = จองได้ (ยังไม่มีใครส่ง), false = ส่งไปแล้ว
 * ใช้ insert ธรรมดาแล้วดูว่าชน unique index ไหม เพื่อให้เป็น atomic จริง
 */
async function claimAlert(alert: SubscriptionAlert, day: string): Promise<boolean> {
  const supabase = await createSupabaseServiceClient();
  // ตารางนี้ไม่ได้อยู่ใน database.types (เพิ่มใหม่) — cast เพื่อไม่ให้ generics ทั้ง repo บวม
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const table = supabase.from("subscription_alert_log") as any;
  const { error } = await table.insert({
    organization_id: alert.organizationId,
    stage: alert.stage,
    alerted_on: day,
  });
  if (!error) return true;
  // 23505 = ชน unique index แปลว่าส่งไปแล้ววันนี้ ถือว่าปกติ ไม่ใช่ข้อผิดพลาด
  if ((error as { code?: string }).code === "23505") return false;
  throw error;
}

/** ส่งถึงร้านหนึ่งราย (ศูนย์แจ้งเตือนในแอป + push/LINE ตามที่ร้านเปิดไว้) */
async function alertTenant(alert: SubscriptionAlert): Promise<void> {
  const copy = buildTenantAlertCopy(alert);
  await notifyOwnerNow({
    type: "subscription_expiring",
    destination: "owner",
    title: copy.title,
    message: copy.message,
    organizationId: alert.organizationId,
    metadata: { stage: alert.stage, daysLeft: alert.daysLeft, plan: alert.plan },
  });
}

/**
 * งานหลัก — สแกนทุก subscription แล้วเตือนร้านที่ถึงกำหนด พร้อมสรุปส่งผู้ดูแล
 * ไม่ throw: ความผิดพลาดของร้านหนึ่งต้องไม่ทำให้ร้านที่เหลือไม่ได้รับแจ้ง
 */
export async function runSubscriptionWatch(now: Date = new Date()): Promise<SubscriptionWatchResult> {
  const day = bangkokDay(now);
  const startedAt = Date.now();

  let subs: WatchedSubscription[];
  try {
    subs = await loadWatchedSubscriptions();
  } catch (error) {
    logActionError({ source: SOURCE, action: "loadWatchedSubscriptions", error });
    return { day, scanned: 0, alerted: 0, skipped: 0, failed: 1 };
  }

  const alerts = planSubscriptionAlerts(subs, now);
  const sent: SubscriptionAlert[] = [];
  let skipped = 0;
  let failed = 0;

  for (const alert of alerts) {
    try {
      const claimed = await claimAlert(alert, day);
      if (!claimed) {
        skipped += 1;
        continue;
      }
      await alertTenant(alert);
      sent.push(alert);
    } catch (error) {
      failed += 1;
      logActionError({
        source: SOURCE,
        action: "alertTenant",
        error,
        organizationId: alert.organizationId,
        context: { stage: alert.stage, key: alertIdempotencyKey(alert, day) },
      });
    }
  }

  // สรุปถึงผู้ดูแล — ส่งเฉพาะวันที่มีอะไรให้ตาม จะได้ไม่กลายเป็นอีเมลที่ทุกคนเมิน
  if (sent.length > 0) {
    await notifyPlatformAdmin({
      source: SOURCE,
      action: "dailyDigest",
      level: sent.some((a) => a.stage === "expired") ? "warn" : "info",
      subject: `สรุปแพ็กเกจร้านประจำวัน ${day}`,
      body: buildAdminDigest(sent, day),
      context: { alerted: sent.length, skipped, failed },
    });
  }

  await logSystemEvent({
    level: failed > 0 ? "warn" : "info",
    source: SOURCE,
    action: "runSubscriptionWatch",
    message: `ตรวจแพ็กเกจ ${subs.length} ร้าน · เตือน ${sent.length} · ข้าม(เตือนไปแล้ว) ${skipped} · ล้มเหลว ${failed}`,
    durationMs: Date.now() - startedAt,
    context: { day, stages: sent.map((a) => `${a.organizationName}:${a.stage}`) },
  });

  return { day, scanned: subs.length, alerted: sent.length, skipped, failed };
}
