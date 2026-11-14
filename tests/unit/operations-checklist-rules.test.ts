import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  addDays,
  computeAreaReadiness,
  dayOfWeek,
  formatClockOutBlockMessage,
  isChecklistOverdue,
  opsErrorMessage,
  pendingClockOutChecklists,
  validateTemplateInput,
} from "@/modules/operations/rules";
import {
  buildStarterTemplates,
  normalizeKitchenNames,
  STORE_PACKS,
  suggestPacks,
  type StorePackId,
} from "@/modules/operations/starter-packs";
import { buildSettingsTabs } from "@/app/(dashboard)/settings/settings-tabs";
import { resolvePermissions } from "@/modules/auth/permission-resolver";
import { describeChecklistEvent } from "@/modules/operations/history";
import { NOTIFICATION_TYPES } from "@/modules/notifications/types";
import type { ChecklistRun, ChecklistRunItem, ChecklistTemplate, TemplateInput } from "@/modules/operations/types";

const read = (path: string) => readFileSync(path, "utf8");

function template(overrides: Partial<ChecklistTemplate> = {}): ChecklistTemplate {
  return {
    id: "tpl-1",
    storeId: "store-1",
    name: "ปิดครัว",
    area: "ครัว",
    phase: "close",
    dueTime: "21:30",
    daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
    requireBeforeClockOut: true,
    assigneeUserIds: ["user-a"],
    version: 1,
    isActive: true,
    sortOrder: 0,
    updatedAt: "2026-10-15T00:00:00Z",
    items: [],
    ...overrides,
  };
}

function runItem(overrides: Partial<ChecklistRunItem> = {}): ChecklistRunItem {
  return {
    id: "item-1",
    sortOrder: 1,
    label: "ตู้เย็น",
    description: null,
    critical: false,
    valueType: "check",
    unit: null,
    minValue: null,
    maxValue: null,
    photoRule: "never",
    answer: "pass",
    value: null,
    note: null,
    photoPath: null,
    answeredBy: "user-a",
    answeredAt: "2026-10-15T02:00:00Z",
    ...overrides,
  };
}

function run(overrides: Partial<ChecklistRun> = {}): ChecklistRun {
  return {
    id: "run-1",
    storeId: "store-1",
    organizationId: "org-1",
    templateId: "tpl-open",
    templateVersion: 1,
    templateName: "เปิดครัว",
    area: "ครัว",
    phase: "open",
    shiftDate: "2026-10-15",
    status: "submitted",
    startedBy: "user-a",
    startedAt: "2026-10-15T02:00:00Z",
    submittedBy: "user-a",
    submittedAt: "2026-10-15T02:10:00Z",
    items: [runItem()],
    ...overrides,
  };
}

describe("dates", () => {
  it("dayOfWeek ไม่ขึ้นกับ timezone เครื่อง (2026-10-15 = พฤหัส)", () => {
    expect(dayOfWeek("2026-10-15")).toBe(4);
    expect(dayOfWeek("2026-10-18")).toBe(0);
  });
  it("addDays ข้ามเดือน/ปี", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2027-01-01", -1)).toBe("2026-12-31");
  });
});

describe("pendingClockOutChecklists — เจ้าของข้อ 1", () => {
  const date = "2026-10-15";
  it("บล็อกเฉพาะผู้รับผิดชอบที่ยังไม่ส่ง", () => {
    const templates = [template()];
    expect(pendingClockOutChecklists(templates, new Set(), "user-a", date)).toHaveLength(1);
    expect(pendingClockOutChecklists(templates, new Set(), "user-b", date)).toHaveLength(0);
    expect(pendingClockOutChecklists(templates, new Set(["tpl-1"]), "user-a", date)).toHaveLength(0);
  });
  it("ไม่บล็อกเมื่อปิดสวิตช์/ปิดใช้/ไม่ใช่วันที่ใช้", () => {
    expect(pendingClockOutChecklists([template({ requireBeforeClockOut: false })], new Set(), "user-a", date)).toHaveLength(0);
    expect(pendingClockOutChecklists([template({ isActive: false })], new Set(), "user-a", date)).toHaveLength(0);
    expect(pendingClockOutChecklists([template({ daysOfWeek: [1] })], new Set(), "user-a", date)).toHaveLength(0);
  });
  it("ข้อความบอกชื่อเช็กลิสต์ที่ค้าง", () => {
    expect(formatClockOutBlockMessage([template(), template({ name: "ปิดบาร์" })])).toContain("“ปิดครัว”, “ปิดบาร์”");
  });
});

describe("computeAreaReadiness — ไม่ใช้คะแนนเฉลี่ย", () => {
  const date = "2026-10-15";
  const openTemplate = template({ id: "tpl-open", name: "เปิดครัว", phase: "open" });
  it("ข้อสำคัญไม่ผ่าน = NOT_READY แม้ข้ออื่นผ่านหมด", () => {
    const runs = [run({ items: [runItem(), runItem({ id: "i2", label: "เนื้อ", critical: true, answer: "fail" })] })];
    const [area] = computeAreaReadiness([openTemplate], runs, date);
    expect(area.readiness).toBe("NOT_READY");
    expect(area.reasons[0]).toContain("เนื้อ");
  });
  it("ข้อทั่วไปไม่ผ่าน = LIMITED", () => {
    const runs = [run({ items: [runItem({ answer: "fail" })] })];
    expect(computeAreaReadiness([openTemplate], runs, date)[0].readiness).toBe("LIMITED");
  });
  it("ข้อสำคัญไม่ผ่านในเช็กลิสต์ที่ยังไม่ส่งก็นับ", () => {
    const runs = [run({ status: "in_progress", items: [runItem({ critical: true, answer: "fail" })] })];
    expect(computeAreaReadiness([openTemplate], runs, date)[0].readiness).toBe("NOT_READY");
  });
  it("ส่งเช็กลิสต์เปิดร้านครบไม่มีข้อไม่ผ่าน = READY", () => {
    expect(computeAreaReadiness([openTemplate], [run()], date)[0].readiness).toBe("READY");
  });
  it("ยังไม่ส่ง = UNKNOWN พร้อมเหตุผล", () => {
    const [area] = computeAreaReadiness([openTemplate], [], date);
    expect(area.readiness).toBe("UNKNOWN");
    expect(area.reasons).toEqual(["ยังไม่ส่ง: เปิดครัว"]);
  });
  it("แยกพื้นที่ครัว/บาร์", () => {
    const bar = template({ id: "tpl-bar", name: "เปิดบาร์", area: "บาร์", phase: "open" });
    const result = computeAreaReadiness([openTemplate, bar], [run()], date);
    expect(result.map((entry) => [entry.area, entry.readiness])).toEqual([
      ["ครัว", "READY"],
      ["บาร์", "UNKNOWN"],
    ]);
  });
});

describe("isChecklistOverdue — ตรงกับ ops_checklist_due_alerts()", () => {
  it("เลยเวลาในวันเดียวกัน", () => {
    expect(isChecklistOverdue("21:30", "2026-10-15", { date: "2026-10-15", time: "21:29" })).toBe(false);
    expect(isChecklistOverdue("21:30", "2026-10-15", { date: "2026-10-15", time: "21:30" })).toBe(true);
  });
  it("กำหนดก่อน 05:00 = หลังเที่ยงคืนของกะ", () => {
    expect(isChecklistOverdue("01:00", "2026-10-15", { date: "2026-10-15", time: "23:00" })).toBe(false);
    expect(isChecklistOverdue("01:00", "2026-10-15", { date: "2026-10-16", time: "01:05" })).toBe(true);
  });
  it("ไม่มีกำหนด = ไม่เลย", () => {
    expect(isChecklistOverdue(null, "2026-10-15", { date: "2026-10-16", time: "12:00" })).toBe(false);
  });
});

describe("validateTemplateInput", () => {
  const [base] = buildStarterTemplates({ packs: ["restaurant"], kitchenNames: [] });
  it("ปฏิเสธชื่อว่าง วันว่าง ไม่มีข้อ ช่วงกลับด้าน เวลาผิด", () => {
    expect(validateTemplateInput({ ...base, name: "  " })).not.toBeNull();
    expect(validateTemplateInput({ ...base, daysOfWeek: [] })).not.toBeNull();
    expect(validateTemplateInput({ ...base, items: [] })).not.toBeNull();
    expect(validateTemplateInput({ ...base, dueTime: "25:00" })).not.toBeNull();
    expect(
      validateTemplateInput({ ...base, items: [{ ...base.items[0], valueType: "number", minValue: 5, maxValue: 1 }] }),
    ).toBe("ค่าต่ำสุดต้องไม่มากกว่าค่าสูงสุด");
  });
});

describe("คลังแม่แบบตามประเภทร้าน", () => {
  const ALL = STORE_PACKS.map((pack) => pack.id);

  it("ทุกแม่แบบผ่านการตรวจ ปิดใช้ ไม่มีผู้รับผิดชอบ และไม่ฝังช่วงอุณหภูมิ", () => {
    const templates = buildStarterTemplates({ packs: ALL, kitchenNames: ["ครัวร้อน", "ครัวเย็น"] });
    expect(templates.length).toBeGreaterThan(10);
    for (const template of templates) {
      expect(validateTemplateInput(template)).toBeNull();
      expect(template.isActive).toBe(false);
      expect(template.assigneeUserIds).toEqual([]);
      for (const item of template.items) {
        expect(item.minValue).toBeNull();
        expect(item.maxValue).toBeNull();
      }
    }
    expect(new Set(templates.map((template) => template.name)).size).toBe(templates.length);
    expect(templates.map((template) => template.sortOrder)).toEqual(templates.map((_, index) => index));
  });

  it.each([
    ["restaurant", ["เปิดครัว", "ระหว่างวัน · ครัว", "ปิดครัว"]],
    ["cafe", ["เปิดบาร์กาแฟ", "ปิดบาร์กาแฟ"]],
    ["bar", ["เปิดบาร์", "ปิดร้านกลางคืน"]],
    ["grocery", ["เปิดร้านของชำ", "ปิดร้านของชำ"]],
    ["convenience", ["เปิดร้านสะดวกซื้อ", "ตรวจระหว่างกะ", "ส่งกะ / ปิดร้าน"]],
    ["fresh", ["รับและตรวจของสด", "ตรวจตู้เย็นและช่องแช่แข็ง"]],
    ["expiry", ["ตรวจวันหมดอายุสินค้า"]],
  ] as Array<[StorePackId, string[]]>)("ชุด %s", (pack, names) => {
    expect(buildStarterTemplates({ packs: [pack], kitchenNames: [] }).map((template) => template.name)).toEqual(names);
  });

  it("เลือกรวม อาหาร + กาแฟ ได้ครัวและบาร์กาแฟแยกพื้นที่", () => {
    const templates = buildStarterTemplates({ packs: ["cafe", "restaurant"], kitchenNames: [] });
    expect(templates.map((template) => template.area)).toEqual(["ครัว", "ครัว", "ครัว", "บาร์กาแฟ", "บาร์กาแฟ"]);
  });

  it("หลายครัว = ชุดเปิด/ระหว่างวัน/ปิด ต่อครัว ไม่ซ้ำกับครัวหลัก", () => {
    const templates = buildStarterTemplates({ packs: ["restaurant", "multi_kitchen"], kitchenNames: ["ครัวร้อน", " ครัวเย็น ", "ครัวร้อน", ""] });
    expect(templates.map((template) => template.name)).toEqual([
      "เปิดครัวร้อน", "ระหว่างวัน · ครัวร้อน", "ปิดครัวร้อน",
      "เปิดครัวเย็น", "ระหว่างวัน · ครัวเย็น", "ปิดครัวเย็น",
    ]);
    expect(templates.filter((template) => template.phase === "close").every((template) => template.requireBeforeClockOut)).toBe(true);
  });

  it("ครัวสร้างครั้งเดียวไม่ว่าลำดับ pack ที่ส่งมา", () => {
    const names = (list: StorePackId[]) => buildStarterTemplates({ packs: list, kitchenNames: [] }).map((template) => template.name);
    expect(names(["multi_kitchen", "restaurant"])).toEqual(names(["restaurant", "multi_kitchen"]));
    expect(names(["multi_kitchen", "restaurant"])).toHaveLength(3);
  });

  it("หลายครัวแต่ไม่ได้ตั้งชื่อ = ใช้ครัวเดียว", () => {
    expect(buildStarterTemplates({ packs: ["multi_kitchen"], kitchenNames: [" "] }).map((template) => template.name)).toEqual([
      "เปิดครัว", "ระหว่างวัน · ครัว", "ปิดครัว",
    ]);
  });

  it("จำกัดจำนวนและความยาวชื่อครัว, ไม่รับ pack แปลก", () => {
    expect(normalizeKitchenNames(Array.from({ length: 10 }, (_, i) => `ครัว ${i}`))).toHaveLength(6);
    expect(normalizeKitchenNames(["ก".repeat(80)])[0]).toHaveLength(40);
    expect(buildStarterTemplates({ packs: ["hacker" as StorePackId], kitchenNames: [] })).toEqual([]);
  });

  it("แนะนำชุดจากโปรไฟล์ร้าน", () => {
    expect(suggestPacks("restaurant")).toEqual(["restaurant"]);
    expect(suggestPacks("retail")).toEqual(["grocery"]);
    expect(suggestPacks(null)).toEqual([]);
  });
});

describe("เมนูตั้งค่า งานหน้าร้าน", () => {
  it("owner/admin เห็น ส่วน manager/cashier/staff ไม่เห็น (ตรงกับสิทธิ์ RPC)", () => {
    const hrefs = (role: "owner" | "admin" | "manager" | "cashier" | "staff") =>
      buildSettingsTabs(resolvePermissions(role, [], "org", "store")).map((tab) => tab.href);
    expect(hrefs("owner")).toContain("/settings/operations");
    expect(hrefs("admin")).toContain("/settings/operations");
    expect(hrefs("manager")).not.toContain("/settings/operations");
    expect(hrefs("cashier")).not.toContain("/settings/operations");
    expect(hrefs("staff")).not.toContain("/settings/operations");
  });
});

describe("opsErrorMessage", () => {
  it("แปลรหัสจาก RPC เป็นภาษาไทย และไม่เผยข้อความดิบ", () => {
    expect(opsErrorMessage('ERROR: ops_note_required_critical (P0001)')).toContain("ข้อสำคัญไม่ผ่าน");
    expect(opsErrorMessage("some internal pg error")).toBe("บันทึกไม่สำเร็จ ลองใหม่อีกครั้ง");
  });
});

describe("describeChecklistEvent — ใคร ทำอะไร เมื่อไร (เจ้าของข้อ 6)", () => {
  it("แก้คำตอบแสดงก่อน → หลัง", () => {
    const text = describeChecklistEvent({
      id: "e1",
      templateId: null,
      runId: "run-1",
      runItemId: "item-1",
      actorUserId: "user-a",
      action: "item_changed",
      detail: { label: "ตู้เย็น", before: { answer: "fail", value: 7.5, note: null }, after: { answer: "pass", value: 4, note: null } },
      createdAt: "2026-10-15T14:00:00Z",
    });
    expect(text).toBe("แก้ “ตู้เย็น”: ไม่ผ่าน · ค่า 7.5 → ผ่าน · ค่า 4");
  });
});

describe("source wiring", () => {
  it("clockOutAction ตรวจเช็กลิสต์หลังกฎปิดรอบเงินสด ด้วยวันที่ของกะ", () => {
    const source = read("src/app/(dashboard)/attendance/actions.ts");
    const cashIndex = source.indexOf("กรุณาปิดรอบเงินสดก่อนออกงาน");
    const gateIndex = source.indexOf("checkClockOutChecklistGate({");
    expect(cashIndex).toBeGreaterThan(0);
    expect(gateIndex).toBeGreaterThan(cashIndex);
    expect(source.slice(gateIndex, gateIndex + 250)).toContain("shiftDate: active.date");
    expect(gateIndex).toBeLessThan(source.indexOf("await clockOut(active.id"));
  });

  it("migration: client เขียนตารางตรงไม่ได้, ประวัติ append-only, flag default false", () => {
    const sql = read("supabase/migrations/20261114120000_ops_checklists.sql");
    expect(sql).toContain("add column if not exists operations_enabled boolean not null default false");
    expect(sql).toMatch(/revoke all on table public\.ops_checklist_templates[\s\S]*from anon, authenticated;/);
    expect(sql).not.toMatch(/grant (insert|update|delete)[^;]*to authenticated/);
    expect(sql).toContain("ops_checklist_events is append-only");
    expect(sql).toContain("on public.ops_checklist_events for select\n  using (auth_user_role_in_store(organization_id, store_id, 'admin'))");
    expect(sql).toContain("where exists (select 1 from public.ops_checklist_due_alerts())");
    // constraint ชนิดแจ้งเตือนต้องมีชนิดเดิมครบ ไม่ทำของเดิมหาย
    for (const type of NOTIFICATION_TYPES) expect(sql).toContain(`'${type}'`);
    // เปิดรอบใหม่ต้องล้าง dedupe ข้อสำคัญ ให้แจ้งเจ้าของได้อีกครั้ง
    expect(sql).toMatch(/delete from public\.ops_notification_log[\s\S]*run_id = p_run_id/);
  });

  it("ชนิดแจ้งเตือน ops_checklist ครบทุกจุด", () => {
    expect(read("src/modules/notifications/types.ts")).toContain('"ops_checklist"');
    expect(read("src/modules/notifications/templates.ts")).toContain("ops_checklist:");
    expect(read("src/app/(dashboard)/notifications/NotificationCenter.tsx")).toContain("ops_checklist:");
    expect(read("src/app/(dashboard)/settings/notifications/page.tsx")).toContain("ops_checklist:");
    expect(read("src/server/integrations/supabase/middleware.ts")).toContain('"/api/operations/cron/checklist-due"');
  });
});
