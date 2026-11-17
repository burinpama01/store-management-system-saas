import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NOTIFICATION_TYPES, STAFF_PUSH_NOTIFICATION_TYPES, isPushRecipientRole } from "@/modules/notifications/types";
import { DEFAULT_NOTIFICATION_TEMPLATES, NOTIFICATION_TEMPLATE_VARS } from "@/modules/notifications/templates";
import { ORDER_ALERT_TYPES } from "@/shared/notifications/alert-sound";

const read = (path: string) => readFileSync(path, "utf8");
const NEW_TYPES = ["new_online_order", "salary_advance_request", "pass_purchase"] as const;

describe("หัวข้อแจ้งเตือนของฟีเจอร์ใหม่", () => {
  it("อยู่ใน matrix หน้าตั้งค่า + มีข้อความตั้งต้น + ป้ายในศูนย์แจ้งเตือน", () => {
    const settings = read("src/app/(dashboard)/settings/notifications/page.tsx");
    const center = read("src/app/(dashboard)/notifications/NotificationCenter.tsx");
    for (const type of NEW_TYPES) {
      expect(NOTIFICATION_TYPES).toContain(type);
      expect(DEFAULT_NOTIFICATION_TEMPLATES[type].title).toBeTruthy();
      expect(NOTIFICATION_TEMPLATE_VARS[type]).toContain("store");
      expect(settings).toContain(`  ${type}: "`);
      expect(center).toContain(`  ${type}: { label:`);
    }
  });

  it("migration เปิดชนิดใหม่ทั้ง settings/templates โดยไม่ทำชนิดเดิมหาย + คอลัมน์กันแจ้งซ้ำของแพ็ก", () => {
    const sql = read("supabase/migrations/20261124120000_notify_new_feature_topics.sql");
    for (const type of NOTIFICATION_TYPES) expect(sql.split(`'${type}'`).length - 1).toBe(2);
    expect(sql).toContain("add column if not exists notified_at timestamptz");
    expect(sql).toContain("set notified_at = coalesce(updated_at, now()) where status = 'paid' and notified_at is null");
  });

  it("ออเดอร์ออนไลน์ = เสียงออเดอร์ + ถึงพนักงานหน้าร้าน · เบิกเงิน/ซื้อแพ็ก = ผู้บริหารเท่านั้น", () => {
    expect(ORDER_ALERT_TYPES.has("new_online_order")).toBe(true);
    expect(STAFF_PUSH_NOTIFICATION_TYPES.has("new_online_order")).toBe(true);
    for (const type of ["salary_advance_request", "pass_purchase"] as const) {
      expect(isPushRecipientRole(type, "staff")).toBe(false);
      expect(isPushRecipientRole(type, "cashier")).toBe(false);
      expect(isPushRecipientRole(type, "owner")).toBe(true);
    }
    expect(read("src/modules/notifications/push.ts")).toMatch(/ORDER_PUSH_TYPES[\s\S]*"new_online_order"/);
  });

  it("แจ้งออเดอร์ออนไลน์/แพ็กตอน Beam ยืนยัน (webhook + lookup) ไม่พึ่งหน้าจอลูกค้า · กันซ้ำด้วย notified_at", () => {
    expect(read("src/modules/payments/webhook-beam.ts")).toContain(
      'if (nextStatus === "PAID" || nextStatus === "LATE_PAID") await runGatewayPaidEffects(row.id);',
    );
    expect(read("src/modules/payments/beam-service.ts")).toContain('if (resolved === "PAID") await runGatewayPaidEffects(row.id);');
    const effects = read("src/modules/payments/paid-effects.ts");
    expect(effects).toContain('if (!data || data.status !== "PAID") return;');
    expect(effects).toContain("notifyOnlineOrderPaidOnce(");
    expect(effects).toContain("notifyPassPurchasePaidOnce(");
    expect(read("src/modules/online-orders/notify.ts")).toContain('type: "new_online_order"');
    const pass = read("src/modules/prepaid-passes/notify.ts");
    expect(pass).toContain('.is("notified_at", null)');
    expect(pass).toContain('.eq("status", "paid")');
    const tracking = read("src/app/s/[slug]/order/actions.ts");
    expect(tracking).not.toContain('type: "new_delivery_order"');
    expect(tracking).toContain("notifyOnlineOrderPaidOnce(order)");
  });

  it("ขอเบิกเงินส่งผ่านหน้าตั้งค่าแจ้งเตือน (LINE/Telegram/Push) แทน push ตรง", () => {
    const src = read("src/app/(dashboard)/my-advance/actions.ts");
    expect(src).toContain('type: "salary_advance_request"');
    // แพ็กที่ไม่มีระบบแจ้งเตือน ยัง push ตรงถึงผู้จัดการแบบเดิม (คำขอไม่เงียบ)
    expect(src).toContain("if (!getPlanFeatures(billing).lineNotify) {");
    expect(src.indexOf("await pushPayrollNotification(")).toBeLessThan(src.indexOf('type: "salary_advance_request"'));
  });
});
