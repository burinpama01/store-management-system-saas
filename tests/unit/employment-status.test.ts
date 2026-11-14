import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isEmploymentEnded, resignedMembershipIds, storeLocalDate } from "@/modules/hr/employment-status";
import { filterPushEligibleUserIds } from "@/modules/notifications/repository";

const root = process.cwd();
const src = (f: string) => readFileSync(join(root, f), "utf8").replace(/\r\n/g, "\n");

// 11 พ.ย. 2026 20:00 UTC = 12 พ.ย. 03:00 เวลาไทย
const NOW = new Date("2026-11-11T20:00:00Z");
const stores = [
  { id: "sA", organization_id: "o1", timezone: "Asia/Bangkok" },
  { id: "sB", organization_id: "o1", timezone: "Asia/Bangkok" },
  { id: "sC", organization_id: "o2", timezone: "Asia/Bangkok" },
];

describe("สถานะพนักงานลาออก", () => {
  it("วันออกงานยังนับว่าทำงานอยู่ · เลยวันออกงาน = ลาออก · ใช้วันที่ตามเวลาสาขา", () => {
    expect(storeLocalDate(NOW, "Asia/Bangkok")).toBe("2026-11-12");
    expect(isEmploymentEnded("2026-11-12", "2026-11-12")).toBe(false);
    expect(isEmploymentEnded("2026-11-11", "2026-11-12")).toBe(true);
    expect(isEmploymentEnded(null, "2026-11-12")).toBe(false);
  });

  it("สมาชิกภาพผูกสาขา: ตัดเฉพาะสาขาที่เลยวันออกงาน (สาขาอื่น/องค์กรอื่นยังใช้ได้)", () => {
    const ms = [
      { id: "m1", organization_id: "o1", store_id: "sA", role: "staff" },
      { id: "m2", organization_id: "o1", store_id: "sB", role: "staff" },
      { id: "m3", organization_id: "o2", store_id: "sC", role: "staff" },
    ];
    const profiles = [
      { store_id: "sA", employment_end_date: "2026-11-11" },
      { store_id: "sB", employment_end_date: "2026-11-12" },
      { store_id: "sC", employment_end_date: null },
    ];
    expect([...resignedMembershipIds(ms, profiles, stores, NOW)]).toEqual(["m1"]);
  });

  it("ไม่มีโปรไฟล์ = ไม่ตัด (เช่นผู้จัดการที่ไม่ได้ตั้งค่าจ้าง)", () => {
    const ms = [{ id: "m1", organization_id: "o1", store_id: "sA", role: "manager" }];
    expect(resignedMembershipIds(ms, [], stores, NOW).size).toBe(0);
  });

  it("ระดับองค์กร: ตัดเมื่อทุกโปรไฟล์ในองค์กรเลยวันออกงาน · เจ้าของไม่ถูกตัดเด็ดขาด", () => {
    const orgWide = [{ id: "m1", organization_id: "o1", store_id: null, role: "admin" }];
    const allEnded = [
      { store_id: "sA", employment_end_date: "2026-11-01" },
      { store_id: "sB", employment_end_date: "2026-11-05" },
    ];
    expect(resignedMembershipIds(orgWide, allEnded, stores, NOW).has("m1")).toBe(true);
    const oneActive = [allEnded[0], { store_id: "sB", employment_end_date: null }];
    expect(resignedMembershipIds(orgWide, oneActive, stores, NOW).size).toBe(0);
    const owner = [{ id: "m9", organization_id: "o1", store_id: null, role: "owner" }];
    expect(resignedMembershipIds(owner, allEnded, stores, NOW).size).toBe(0);
    // โปรไฟล์ขององค์กรอื่นไม่เกี่ยว
    expect(resignedMembershipIds(orgWide, [{ store_id: "sC", employment_end_date: "2026-01-01" }], stores, NOW).size).toBe(0);
  });

  it("แจ้งเตือนร้าน: คนลาออกไม่อยู่ในผู้รับ · เจ้าของไม่ถูกตัด", () => {
    const rows = [
      { user_id: "u-staff", store_id: "sA", role: "staff" as const },
      { user_id: "u-left", store_id: "sA", role: "staff" as const },
      { user_id: "u-owner", store_id: null, role: "owner" as const },
    ];
    const got = filterPushEligibleUserIds(rows, "sA", "new_qr_order", new Set(["u-left", "u-owner"]));
    expect([...got].sort()).toEqual(["u-owner", "u-staff"]);
    // ไม่ส่งรายชื่อ = แบบเดิม
    expect(filterPushEligibleUserIds(rows, "sA", "new_qr_order").size).toBe(3);
  });

  it("เส้นทางระบบ: ตัดสิทธิ์ใน getUserStores, พาไปหน้าไม่มีสิทธิ์, แจ้งเตือนเงินเดือนตัดคนลาออก", () => {
    const session = src("src/modules/auth/session.ts");
    expect(session).toContain("const memberships = allMemberships.filter((m) => !resignedIds.has(m.id));");
    expect(session).toContain("profilesResult.error");
    const guards = src("src/modules/auth/guards.ts");
    expect(guards).toContain("stores.length === 0 && resignedMemberships.length > 0");
    expect(guards).toContain('if (!path.startsWith("/api/")) redirect("/account-inactive");');
    // เจ้าของกิจการไม่ถูกนับเป็นคนลาออกในการตัดผู้รับแจ้งเตือน
    expect(src("src/modules/hr/employment-status.ts")).toContain('.eq("role", "owner")');
    const notify = src("src/modules/hr/advanced/notify.ts");
    expect(notify).toContain("!resigned.has(id)");
    const page = src("src/app/account-inactive/page.tsx");
    expect(page).toContain("action={signOut}");
    expect(page).toContain("<OpenStoreForm />");
    const action = src("src/app/account-inactive/actions.ts");
    // มีร้านที่ใช้ได้อยู่แล้ว = ไม่สร้างซ้ำ · สร้างสิทธิ์เจ้าของระดับองค์กร
    expect(action).toContain('if (stores.length > 0) redirect("/dashboard");');
    expect(action).toContain('role: "owner"');
    // กันกดซ้ำสร้างกิจการซ้ำ
    expect(action).toContain('.eq("owner_id", user.id)');
  });
});
