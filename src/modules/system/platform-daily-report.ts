/**
 * รายงานสรุปรายวันฝั่งผู้ดูแลแพลตฟอร์ม (ซูเปอร์แอดมิน) — ตัวประกอบข้อความ (บริสุทธิ์)
 *
 * ทำไมต้องมี: ของเดิมสรุปให้ผู้ดูแลแค่ "ร้านที่ใกล้หมด/หมดอายุ" และส่งเฉพาะวันที่มีเรื่องให้ตาม
 * ผู้ดูแลจึงไม่มีทางรู้จากอีเมลเลยว่ามีใครสมัครใหม่ ใครยังใช้งานอยู่ ใครหายไป
 * ไฟล์นี้เพิ่มสามคำถามนั้นเข้าไปในสรุปเดียวกัน: ผู้ใช้ใหม่ / ผู้ใช้ล่าสุด / ผู้ใช้ที่ยังแอคทีฟ
 *
 * ไม่แตะฐานข้อมูลและไม่ส่งอะไรออก — ตัวโหลดข้อมูลกับตัวส่งอยู่ที่ platform-daily-report-runner.ts
 */

export interface PlatformDailyTenant {
  readonly organizationId: string;
  readonly name: string;
  readonly plan: string;
  readonly createdAt: string;
  readonly ownerEmail?: string | null;
  /** จำนวนบิลที่ปิดใน 7 วันล่าสุด — 0 = ไม่ได้ขายเลย */
  readonly orderCount7d: number;
  readonly revenue7d: number;
  /** เวลาปิดบิลล่าสุด (null = ไม่มีบิลเลยในช่วงที่ตรวจ) */
  readonly lastOrderAt: string | null;
}

export interface PlatformDailyReport {
  /** วันที่ออกรายงาน (เวลาไทย) */
  readonly today: string;
  /** วันของตัวเลขที่สรุป — เมื่อวาน คือวันเดียวที่ปิดวันแล้วจริง ๆ */
  readonly yesterday: string;
  readonly totalTenants: number;
  readonly suspendedTenants: number;
  /** องค์กรที่สมัครเมื่อวาน */
  readonly newTenants: readonly PlatformDailyTenant[];
  readonly newTenants7d: number;
  /** สมาชิกใหม่ที่เข้าร่วมองค์กรใด ๆ ใน 7 วันล่าสุด (พนักงานที่ถูกเพิ่มเข้าระบบ) */
  readonly newMembers7d: number;
  /** องค์กรที่สมัครล่าสุด (เรียงใหม่→เก่า) */
  readonly recentTenants: readonly PlatformDailyTenant[];
  /** องค์กรที่มีบิลอย่างน้อย 1 ใบใน 7 วันล่าสุด (เรียงตามยอด) */
  readonly activeTenants: readonly PlatformDailyTenant[];
  /** องค์กรที่ไม่มีบิลเลยใน 14 วันล่าสุด — กลุ่มเสี่ยงเลิกใช้ */
  readonly dormantTenants: readonly PlatformDailyTenant[];
  readonly yesterdayOrderCount: number;
  readonly yesterdayRevenue: number;
  /** จำนวนองค์กรที่ขายได้เมื่อวาน */
  readonly yesterdaySellingTenants: number;
}

function baht(amount: number): string {
  return `฿${amount.toLocaleString("th-TH", { maximumFractionDigits: 2 })}`;
}

function shortDate(iso: string | null): string {
  if (!iso) return "—";
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return new Intl.DateTimeFormat("th-TH", {
    timeZone: "Asia/Bangkok",
    day: "numeric",
    month: "short",
  }).format(parsed);
}

function tenantLine(tenant: PlatformDailyTenant, suffix: string): string {
  const email = tenant.ownerEmail ? ` · ${tenant.ownerEmail}` : "";
  return `  • ${tenant.name} (${tenant.plan})${email} ${suffix}`.trimEnd();
}

/** จำนวนวันเต็มที่เงียบไป — ใช้บอกว่าร้านหายไปนานแค่ไหน */
export function daysSince(iso: string | null, now: Date): number | null {
  if (!iso) return null;
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.floor((now.getTime() - at) / 86_400_000));
}

/**
 * ข้อความสรุปรายวันถึงผู้ดูแล — ต่อท้ายด้วยส่วน "แพ็กเกจที่ต้องตาม" ที่ subscription watch สร้างไว้
 * (ส่งไว้เป็น subscriptionSection; ว่างได้เมื่อวันนั้นไม่มีร้านต้องตาม)
 */
export function buildPlatformDailyDigest(
  report: PlatformDailyReport,
  subscriptionSection?: string | null,
  now: Date = new Date(),
): string {
  const lines: string[] = [
    `[${report.today}] สรุปแพลตฟอร์มประจำวัน`,
    "",
    `ยอดขายทั้งแพลตฟอร์มเมื่อวาน (${report.yesterday}): ${baht(report.yesterdayRevenue)} · ${report.yesterdayOrderCount} บิล · ขายได้ ${report.yesterdaySellingTenants} ร้าน`,
    `ผู้ใช้ทั้งหมด ${report.totalTenants} องค์กร (ระงับ ${report.suspendedTenants}) · แอคทีฟ 7 วัน ${report.activeTenants.length} · เงียบเกิน 14 วัน ${report.dormantTenants.length}`,
    "",
  ];

  lines.push(`ผู้ใช้ใหม่เมื่อวาน: ${report.newTenants.length} องค์กร (7 วันล่าสุด ${report.newTenants7d} องค์กร · สมาชิกใหม่ ${report.newMembers7d} คน)`);
  if (report.newTenants.length > 0) {
    for (const tenant of report.newTenants) {
      lines.push(tenantLine(tenant, `สมัคร ${shortDate(tenant.createdAt)}`));
    }
  }
  lines.push("");

  if (report.recentTenants.length > 0) {
    lines.push("ผู้ใช้ล่าสุด:");
    for (const tenant of report.recentTenants) {
      const idle = daysSince(tenant.lastOrderAt, now);
      const activity = tenant.lastOrderAt
        ? `ขายล่าสุด ${shortDate(tenant.lastOrderAt)}${idle !== null && idle > 0 ? ` (${idle} วันก่อน)` : ""}`
        : "ยังไม่เคยปิดบิล";
      lines.push(tenantLine(tenant, `สมัคร ${shortDate(tenant.createdAt)} · ${activity}`));
    }
    lines.push("");
  }

  lines.push(`ผู้ใช้ที่ยังแอคทีฟ (มีบิลใน 7 วัน): ${report.activeTenants.length} องค์กร`);
  for (const tenant of report.activeTenants.slice(0, 10)) {
    lines.push(tenantLine(tenant, `${baht(tenant.revenue7d)} · ${tenant.orderCount7d} บิล`));
  }
  lines.push("");

  if (report.dormantTenants.length > 0) {
    lines.push(`เงียบเกิน 14 วัน (ควรตามก่อนเลิกใช้): ${report.dormantTenants.length} องค์กร`);
    for (const tenant of report.dormantTenants.slice(0, 10)) {
      const idle = daysSince(tenant.lastOrderAt, now);
      lines.push(
        tenantLine(
          tenant,
          tenant.lastOrderAt ? `ขายล่าสุด ${shortDate(tenant.lastOrderAt)}${idle !== null ? ` (${idle} วันก่อน)` : ""}` : "ยังไม่เคยปิดบิล",
        ),
      );
    }
    lines.push("");
  }

  if (subscriptionSection && subscriptionSection.trim()) {
    lines.push("— แพ็กเกจ —");
    lines.push(subscriptionSection.trim());
  }

  return lines.join("\n").trimEnd();
}
