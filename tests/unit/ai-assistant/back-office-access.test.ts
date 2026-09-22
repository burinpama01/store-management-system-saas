// ผู้ช่วยหลังร้านใช้ได้เฉพาะเจ้าของหรือผู้จัดการ
//
// เทสนี้ล็อกไว้สองชั้น: (1) ตารางสิทธิ์ยังแมปตรงกับสองบทบาทนั้นจริง (2) tool ทุกตัวของ
// ฟีเจอร์นี้ใส่ด่านไว้ครบ — ข้อหลังสำคัญเพราะ tool บัญชีใช้ cashflow.record ซึ่ง
// **พนักงานหน้าร้านทุกคนมี** ถ้าลืมใส่ด่านเพิ่ม staff จะสั่งผู้ช่วยลงบัญชีได้เลย

import { describe, it, expect } from "vitest";
import { ROLE_DEFAULT_PERMISSIONS } from "@/modules/tenants/types";
import { ToolRegistry } from "@/modules/ai-assistant/foundation";
import { BACK_OFFICE_ASSISTANT_PERMISSION } from "@/modules/ai-assistant/tools/back-office-access";
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

  it("tool หลังร้านทุกตัวใส่ด่านไว้ครบ", () => {
    const registry = new ToolRegistry("test");
    const noop = async () => { throw new Error("not called"); };
    registerAccountingTools(registry, {
      listCategories: async () => [], listRecentTransactions: async () => [], createTransaction: noop as never,
    });
    registerCatalogTools(registry, {
      resolveProduct: async () => ({ status: "not_found" }), getProduct: async () => null,
      listCategories: async () => [], updateProduct: noop as never,
    });
    registerQrTools(registry, {
      listProducts: async () => [], listStations: async () => [], setProductQrVisibility: noop as never,
      assignProductStation: noop as never, getStoreQrEnabled: async () => false, setStoreQrEnabled: noop as never,
    });
    registerStockTools(registry, {
      findVariants: async () => [], getVariant: async () => null, setVariantStock: noop as never,
    });

    const names = [...ACCOUNTING_TOOL_NAMES, ...CATALOG_TOOL_NAMES, ...QR_TOOL_NAMES, ...STOCK_TOOL_NAMES];
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const tool = registry.get(name);
      expect(tool, `ไม่พบ tool ${name}`).toBeDefined();
      expect(tool!.permissions, `tool ${name} ไม่ได้ใส่ด่านหลังร้าน`).toContain(BACK_OFFICE_ASSISTANT_PERMISSION);
    }
  });
});
