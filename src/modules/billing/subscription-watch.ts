/**
 * เฝ้าดูวันหมดอายุแพ็กเกจของร้าน แล้วตัดสินว่าวันนี้ต้องเตือนใครบ้าง
 *
 * ทำไมต้องมี: ก่อนหน้านี้ไม่มีอะไรตรวจ current_period_end เลย ร้านหมดอายุแล้วสิทธิ์
 * ตกเป็น free เงียบ ๆ (ตรวจบน prod 2026-09-03 พบหมดไปแล้ว 8 ร้านโดยไม่มีใครรู้)
 *
 * ไฟล์นี้ตั้งใจให้ "บริสุทธิ์" — ไม่แตะฐานข้อมูล ไม่ส่งอะไรออก เพื่อให้ทดสอบกฎการเตือน
 * ได้ครบทุกขอบโดยไม่ต้องพึ่ง Supabase และให้ cron เป็นคนเอาผลไปยิงจริง
 */

/** ขั้นการเตือน — ใช้เป็นกุญแจกันเตือนซ้ำวันเดียวกันด้วย */
export type SubscriptionAlertStage = "d7" | "d3" | "d1" | "expired";

export const ALERT_STAGE_DAYS: Record<Exclude<SubscriptionAlertStage, "expired">, number> = {
  d7: 7,
  d3: 3,
  d1: 1,
};

export interface WatchedSubscription {
  readonly organizationId: string;
  readonly organizationName: string;
  readonly plan: string;
  /** false = สัญญาไม่มีวันหมดอายุ — ต้องไม่ถูกเตือนเด็ดขาด */
  readonly expires: boolean;
  readonly promoTrial: boolean;
  readonly currentPeriodEnd: string | null;
  readonly suspended: boolean;
}

export interface SubscriptionAlert {
  readonly organizationId: string;
  readonly organizationName: string;
  readonly plan: string;
  readonly promoTrial: boolean;
  readonly stage: SubscriptionAlertStage;
  /** จำนวนวันที่เหลือ — 0 เมื่อหมดแล้ว */
  readonly daysLeft: number;
  readonly currentPeriodEnd: string;
}

/** จำนวนวันเต็มจากตอนนี้ถึงวันหมดอายุ (ปัดขึ้น) — ติดลบเมื่อเลยมาแล้ว */
export function daysRemaining(currentPeriodEnd: string, now: Date): number {
  const end = new Date(currentPeriodEnd).getTime();
  if (Number.isNaN(end)) return Number.NaN;
  return Math.ceil((end - now.getTime()) / 86_400_000);
}

/**
 * เลือกขั้นการเตือนของ subscription หนึ่งราย — คืน null เมื่อวันนี้ยังไม่ต้องเตือน
 *
 * กฎที่ยึด:
 *   • สัญญาไม่มีวันหมดอายุ / ร้านที่ถูกระงับ / ไม่มีวันหมด → ไม่เตือน
 *   • หมดอายุไปแล้ว → เตือน "expired" (ยิงครั้งเดียวเพราะกันซ้ำด้วย log รายวัน)
 *   • เหลือ 1 / 3 / 7 วันพอดี → เตือนขั้นนั้น ๆ
 *   • เหลือ 2, 4, 5, 6 วัน → ไม่เตือน (ไม่งั้นรบกวนทุกวัน)
 */
export function pickAlertStage(
  sub: WatchedSubscription,
  now: Date,
): SubscriptionAlert | null {
  if (!sub.expires || sub.suspended || !sub.currentPeriodEnd) return null;

  const days = daysRemaining(sub.currentPeriodEnd, now);
  if (Number.isNaN(days)) return null;

  const base = {
    organizationId: sub.organizationId,
    organizationName: sub.organizationName,
    plan: sub.plan,
    promoTrial: sub.promoTrial,
    currentPeriodEnd: sub.currentPeriodEnd,
  };

  if (days <= 0) return { ...base, stage: "expired", daysLeft: 0 };

  for (const [stage, threshold] of Object.entries(ALERT_STAGE_DAYS)) {
    if (days === threshold) {
      return { ...base, stage: stage as Exclude<SubscriptionAlertStage, "expired">, daysLeft: days };
    }
  }
  return null;
}

/** ตัดสินทั้งชุด แล้วเรียงให้เรื่องด่วนที่สุดอยู่บน (หมดแล้ว → เหลือน้อยสุด) */
export function planSubscriptionAlerts(
  subs: readonly WatchedSubscription[],
  now: Date = new Date(),
): SubscriptionAlert[] {
  const alerts: SubscriptionAlert[] = [];
  for (const sub of subs) {
    const alert = pickAlertStage(sub, now);
    if (alert) alerts.push(alert);
  }
  return alerts.sort((a, b) => a.daysLeft - b.daysLeft);
}

/** กุญแจกันเตือนซ้ำ: หนึ่งองค์กร หนึ่งขั้น หนึ่งวัน */
export function alertIdempotencyKey(alert: SubscriptionAlert, day: string): string {
  return `${alert.organizationId}:${alert.stage}:${day}`;
}

/** ข้อความที่ส่งถึงร้าน — ต่างกันระหว่างโปรทดลองกับแพ็กเกจที่ซื้อแล้ว */
export function buildTenantAlertCopy(alert: SubscriptionAlert): { title: string; message: string } {
  const what = alert.promoTrial ? "สิทธิ์ทดลองใช้ฟรี" : "แพ็กเกจ";
  if (alert.stage === "expired") {
    return {
      title: `${what}หมดอายุแล้ว`,
      message: `${what}ของ ${alert.organizationName} หมดอายุแล้ว ระบบจะจำกัดฟีเจอร์จนกว่าจะต่ออายุ — ต่อได้ที่ ตั้งค่า > แพ็กเกจ`,
    };
  }
  return {
    title: `${what}จะหมดอายุใน ${alert.daysLeft} วัน`,
    message: `${what}ของ ${alert.organizationName} เหลืออีก ${alert.daysLeft} วัน (ถึง ${formatThaiDate(alert.currentPeriodEnd)}) — ต่ออายุได้ที่ ตั้งค่า > แพ็กเกจ`,
  };
}

/** สรุปให้ผู้ดูแลแพลตฟอร์มอ่านทีเดียวจบว่าวันนี้มีร้านไหนต้องตาม */
export function buildAdminDigest(alerts: readonly SubscriptionAlert[], day: string): string {
  if (alerts.length === 0) return `[${day}] ไม่มีร้านที่ใกล้หมดอายุหรือหมดอายุวันนี้`;

  const expired = alerts.filter((a) => a.stage === "expired");
  const upcoming = alerts.filter((a) => a.stage !== "expired");
  const lines = [`[${day}] สรุปแพ็กเกจร้าน — หมดอายุแล้ว ${expired.length} ร้าน · ใกล้หมด ${upcoming.length} ร้าน`, ""];

  if (expired.length > 0) {
    lines.push("หมดอายุแล้ว:");
    for (const a of expired) {
      lines.push(`  • ${a.organizationName} (${a.plan}${a.promoTrial ? " · ทดลอง" : ""}) หมดเมื่อ ${formatThaiDate(a.currentPeriodEnd)}`);
    }
    lines.push("");
  }
  if (upcoming.length > 0) {
    lines.push("ใกล้หมดอายุ:");
    for (const a of upcoming) {
      lines.push(`  • ${a.organizationName} (${a.plan}${a.promoTrial ? " · ทดลอง" : ""}) เหลือ ${a.daysLeft} วัน ถึง ${formatThaiDate(a.currentPeriodEnd)}`);
    }
  }
  return lines.join("\n");
}

function formatThaiDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("th-TH", {
    timeZone: "Asia/Bangkok",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(d);
}
