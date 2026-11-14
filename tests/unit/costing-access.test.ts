import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decideCostingAccess } from "@/modules/costing/access-policy";

const base = {
  canViewReports: true,
  canManageCatalog: true,
  role: "manager",
  hasAdvancedReports: true,
  businessMode: "restaurant" as const,
};

describe("decideCostingAccess", () => {
  it("manager ร้านอาหารที่มีรายงานขั้นสูง ดูและแก้ได้", () => {
    expect(decideCostingAccess(base)).toEqual({ allowed: true, canEdit: true });
  });

  it("ไม่มี catalog.manage = ดูได้แต่แก้ไม่ได้", () => {
    expect(decideCostingAccess({ ...base, canManageCatalog: false })).toEqual({ allowed: true, canEdit: false });
  });

  it("cashier/staff ไม่เห็นแม้ได้ reports.view (RLS เป็น manager)", () => {
    for (const role of ["cashier", "staff"]) {
      expect(decideCostingAccess({ ...base, role })).toMatchObject({ allowed: false, reason: "role" });
    }
  });

  it("แพ็กเกจไม่มีรายงานขั้นสูง → ล็อกพร้อมข้อความ", () => {
    expect(decideCostingAccess({ ...base, hasAdvancedReports: false, planLockMessage: "อัปเกรด" })).toMatchObject({ allowed: false, reason: "plan", message: "อัปเกรด" });
  });

  it("ร้านขายปลีก/บริการซ่อน · ร้านเก่าที่ยังไม่มีโปรไฟล์ยังใช้ได้", () => {
    expect(decideCostingAccess({ ...base, businessMode: "retail" })).toMatchObject({ allowed: false, reason: "business_mode" });
    expect(decideCostingAccess({ ...base, businessMode: "service" })).toMatchObject({ allowed: false, reason: "business_mode" });
    expect(decideCostingAccess({ ...base, businessMode: null }).allowed).toBe(true);
  });

  it("ไม่มี reports.view ปฏิเสธก่อนเรื่องอื่น", () => {
    expect(decideCostingAccess({ ...base, canViewReports: false })).toMatchObject({ reason: "no_permission" });
  });
});

describe("costing wiring", () => {
  const actions = readFileSync("src/app/(dashboard)/costing/actions.ts", "utf8");
  const layout = readFileSync("src/app/(dashboard)/layout.tsx", "utf8");
  const repo = readFileSync("src/modules/costing/repository.ts", "utf8");

  it("ทุกแอ็กชันผ่านด่าน editor และทิ้ง log", () => {
    const exported = actions.match(/export async function \w+/g) ?? [];
    expect(exported.length).toBe(6);
    expect((actions.match(/await requireEditor\(\)/g) ?? []).length).toBe(exported.length);
    expect((actions.match(/await logCosting\(/g) ?? []).length).toBe(exported.length);
    expect(actions).toContain('source: "costing"');
  });

  it("สูตรซ้ำถูกปฏิเสธก่อนถึงฐานข้อมูล และกลับไปใช้ค่าร้านไม่ลบประวัติ", () => {
    expect(actions).toContain("วัตถุดิบในสูตรซ้ำกัน");
    expect(repo).toContain('supabase.rpc("costing_save_menu"');
    expect(repo).not.toMatch(/from\("cost_allocation_templates"\)\.delete\(\)/);
    expect(repo).toContain("use_store_default: true");
  });

  it("เมนู sidebar ใช้ด่านเดียวกับหน้า", () => {
    expect(layout).toContain("decideCostingAccess({");
    expect(layout).toContain('{ href: "/costing", label: "ต้นทุน" }');
  });

  it("ไม่ดึง webhook_secret ของช่องทางเดลิเวอรี", () => {
    expect(repo).toContain('.select("commission_rate, status")');
    expect(repo).not.toMatch(/connect_channel_links"\)\.select\("\*"\)/);
  });
});
