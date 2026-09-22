// ผู้ช่วยหลังร้านใช้ได้เฉพาะเจ้าของหรือผู้จัดการ
//
// เทสนี้ล็อกไว้สองชั้น: (1) ตารางสิทธิ์ยังแมปตรงกับสองบทบาทนั้นจริง (2) tool ทุกตัวของ
// ฟีเจอร์นี้ใส่ด่านไว้ครบ — ข้อหลังสำคัญเพราะ tool บัญชีใช้ cashflow.record ซึ่ง
// **พนักงานหน้าร้านทุกคนมี** ถ้าลืมใส่ด่านเพิ่ม staff จะสั่งผู้ช่วยลงบัญชีได้เลย

import { describe, it, expect } from "vitest";
import { ROLE_DEFAULT_PERMISSIONS } from "@/modules/tenants/types";
import { createDispatcher, ToolRegistry } from "@/modules/ai-assistant/foundation";
import { DEFAULT_BILLING_STATE } from "@/modules/billing/types";
import type { Role } from "@/modules/tenants/types";
import { ACCOUNTING_ASSISTANT_ROLES, BACK_OFFICE_ASSISTANT_PERMISSION } from "@/modules/ai-assistant/tools/back-office-access";
import { registerAccountingTools, ACCOUNTING_TOOL_NAMES } from "@/modules/ai-assistant/tools/accounting-tools";
import { registerCatalogTools, CATALOG_TOOL_NAMES } from "@/modules/ai-assistant/tools/catalog-tools";
import { registerQrTools, QR_TOOL_NAMES } from "@/modules/ai-assistant/tools/qr-tools";
import { registerStockTools, STOCK_TOOL_NAMES } from "@/modules/ai-assistant/tools/stock-tools";

describe("ด่านของผู้ช่วยหลังร้าน", () => {
  it("เจ้าของและผู้จัดการมีสิทธิ์นี้ — แคชเชียร์กับพนักงานไม่มี", () => {
    expect(ROLE_DEFAULT_PERMISSIONS.owner).toContain(BACK_OFFICE_ASSISTANT_PERMISSION);
    expect(ROLE_DEFAULT_PERMISSIONS.manager).toContain(BACK_OFFICE_ASSISTANT_PERMISSION);
    expect(ROLE_DEFAULT_PERMISSIONS.cashier).not.toContain(BACK_OFFICE_ASSISTANT_PERMISSION);
    expect(ROLE_DEFAULT_PERMISSIONS.staff).not.toContain(BACK_OFFICE_ASSISTANT_PERMISSION);
  });

  it("cashflow.record อย่างเดียวกั้นไม่ได้ — ทุกบทบาทมี", () => {
    // เหตุผลที่ tool บัญชีต้องมีด่านสองชั้น ไม่ใช่ชั้นเดียว
    for (const role of ["owner", "manager", "cashier", "staff"] as const) {
      expect(ROLE_DEFAULT_PERMISSIONS[role]).toContain("cashflow.record");
    }
  });

  it("แคชเชียร์ลงบัญชีได้ แต่พนักงานทั่วไปไม่ได้", () => {
    // สองบทบาทนี้ถือสิทธิ์เกือบชุดเดียวกัน จึงต้องแยกด้วยบทบาท ไม่ใช่สิทธิ์
    expect(ACCOUNTING_ASSISTANT_ROLES).toContain("cashier");
    expect(ACCOUNTING_ASSISTANT_ROLES).not.toContain("staff");
    expect(ACCOUNTING_ASSISTANT_ROLES).toContain("owner");
    expect(ACCOUNTING_ASSISTANT_ROLES).toContain("manager");
  });

  it("tool หลังร้านทุกตัวใส่ด่านไว้ครบ", () => {
    const registry = new ToolRegistry("test");
    const noop = async () => { throw new Error("not called"); };
    registerAccountingTools(registry, {
      listCategories: async () => [], listRecentTransactions: async () => [], createTransaction: noop as never,
    });
    registerCatalogTools(registry, {
      resolveProduct: async () => ({ status: "not_found" }), getProduct: async () => null,
      listCategories: async () => [], updateProduct: noop as never,
      createProduct: noop as never,
    });
    registerQrTools(registry, {
      listProducts: async () => [], listStations: async () => [], setProductQrVisibility: noop as never,
      assignProductStation: noop as never, getStoreQrEnabled: async () => false, setStoreQrEnabled: noop as never,
    });
    registerStockTools(registry, {
      findVariants: async () => [], getVariant: async () => null, setVariantStock: noop as never,
    });

    // tool ที่ไม่ใช่บัญชี = เจ้าของ/ผู้จัดการเท่านั้น (ด่านที่สิทธิ์)
    for (const name of [...CATALOG_TOOL_NAMES, ...QR_TOOL_NAMES, ...STOCK_TOOL_NAMES]) {
      const tool = registry.get(name);
      expect(tool, `ไม่พบ tool ${name}`).toBeDefined();
      expect(tool!.permissions, `tool ${name} ไม่ได้ใส่ด่านหลังร้าน`).toContain(BACK_OFFICE_ASSISTANT_PERMISSION);
    }
    // tool บัญชี = ด่านที่บทบาท เพราะสิทธิ์แยกแคชเชียร์ออกจากพนักงานไม่ได้
    for (const name of ACCOUNTING_TOOL_NAMES) {
      const tool = registry.get(name);
      expect(tool, `ไม่พบ tool ${name}`).toBeDefined();
      expect(tool!.roles, `tool ${name} ไม่ได้ใส่ด่านบทบาท`).toBeDefined();
      expect(tool!.roles).not.toContain("staff");
    }
  });

  it("พนักงานทั่วไปสั่งลงบัญชีไม่ได้จริงตอนวิ่งผ่าน dispatcher", async () => {
    const registry = new ToolRegistry("test");
    let wrote = false;
    registerAccountingTools(registry, {
      listCategories: async () => [],
      listRecentTransactions: async () => [],
      createTransaction: async () => { wrote = true; return { id: "x" }; },
    });
    const dispatchFor = (role: Role) => createDispatcher({
      registry, enabled: true, mutationsEnabled: true, environment: "test",
      audit: async () => {},
      proposals: { save: async () => {}, load: async () => null, consume: async () => false },
      resolveContext: async () => ({
        organizationId: "org-1", storeId: "store-1", userId: "user-1", sessionId: "sess-1", role,
        expiresAt: Date.now() + 60_000,
        allowedTools: [...ACCOUNTING_TOOL_NAMES],
        billing: { ...DEFAULT_BILLING_STATE, plan: "enterprise", status: "active" },
        can: () => true,
      }),
    });
    const command = { tool: "accounting.create_transaction", args: { type: "expense", amount: 50, note: "น้ำแข็ง" }, idempotencyKey: "k" };
    expect(await dispatchFor("staff")(command)).toEqual({ ok: false, code: "PERMISSION_DENIED" });
    expect(await dispatchFor("cashier")(command)).not.toEqual({ ok: false, code: "PERMISSION_DENIED" });
    expect(wrote).toBe(false);
  });
});
