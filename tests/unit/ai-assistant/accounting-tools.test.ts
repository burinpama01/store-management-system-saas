// P2 — tool บัญชี: tool ชุดแรกที่เดินผ่านชั้นยืนยันจริง
//
// สิ่งที่ต้องพิสูจน์:
//   1. plan() ไม่เขียนอะไรเลย แม้ในเส้นทางที่เดาหมวดได้
//   2. เดาหมวดจาก "ประวัติของร้านนี้" ไม่ใช่ความรู้ทั่วไป
//   3. เดาไม่ได้ = ให้เลือก · ไม่มีหมวดเลย = เสนอสร้าง (ไม่ใช่ตอบว่าลงไม่ได้)
//   4. ยอดผิดปกติ = เตือน แต่ไม่บล็อก

import { describe, it, expect, beforeEach } from "vitest";
import { createDispatcher, ToolRegistry, type Result, type TrustedContext } from "@/modules/ai-assistant/foundation";
import {
  registerAccountingTools,
  suggestCategoryFromHistory,
  type AccountingToolDeps,
} from "@/modules/ai-assistant/tools/accounting-tools";
import type { ProposalRecord, ProposalStore } from "@/modules/ai-assistant/proposal";
import type { AccountingCategory, Transaction } from "@/modules/accounting/types";
import { DEFAULT_BILLING_STATE } from "@/modules/billing/types";

const category = (id: string, name: string, type: "income" | "expense"): AccountingCategory => ({
  id, storeId: "store-1", organizationId: "org-1", name, type,
  isDefault: false, sortOrder: 0, createdAt: "", updatedAt: "",
});

const txn = (categoryId: string, categoryName: string, note: string, amount: number, date: string): Transaction => ({
  id: `t-${note}-${amount}`, storeId: "store-1", organizationId: "org-1", type: "expense",
  categoryId, categoryName, amount, paymentMethod: "cash", note, date,
  createdByUserId: "user-1", createdAt: date, updatedAt: date,
});

const ctx = (): TrustedContext => ({
  organizationId: "org-1", storeId: "store-1", userId: "user-1", sessionId: "sess-1", role: "owner",
  expiresAt: Date.now() + 30 * 60 * 1000,
  allowedTools: ["accounting.create_transaction", "accounting.suggest_category", "accounting.list_categories"],
  billing: { ...DEFAULT_BILLING_STATE, plan: "enterprise", status: "active" },
  can: () => true,
});

function memoryProposals(): ProposalStore & { rows: Map<string, ProposalRecord & { used: boolean }> } {
  const rows = new Map<string, ProposalRecord & { used: boolean }>();
  return {
    rows,
    save: async (record) => { rows.set(record.id, { ...record, used: false }); },
    load: async (id) => { const row = rows.get(id); return row && !row.used ? row : null; },
    consume: async (id) => { const row = rows.get(id); if (!row || row.used) return false; row.used = true; return true; },
  };
}

describe("tool บัญชี", () => {
  let categories: AccountingCategory[];
  let history: Transaction[];
  let created: unknown[];
  let dispatch: (request: unknown) => Promise<Result>;
  let proposals: ReturnType<typeof memoryProposals>;

  beforeEach(() => {
    categories = [category("c-mat", "วัตถุดิบ", "expense"), category("c-util", "ค่าสาธารณูปโภค", "expense")];
    history = [
      txn("c-mat", "วัตถุดิบ", "น้ำแข็ง", 450, "2026-09-18"),
      txn("c-mat", "วัตถุดิบ", "น้ำแข็ง", 400, "2026-09-19"),
      txn("c-mat", "วัตถุดิบ", "ค่าน้ำแข็ง", 480, "2026-09-20"),
      txn("c-util", "ค่าสาธารณูปโภค", "ค่าไฟ", 3200, "2026-09-05"),
    ];
    created = [];
    const deps: AccountingToolDeps = {
      listCategories: async () => categories,
      listRecentTransactions: async () => history,
      createTransaction: async (input) => { created.push(input); return { id: "txn-1" }; },
    };
    const registry = new ToolRegistry("test");
    registerAccountingTools(registry, deps);
    proposals = memoryProposals();
    dispatch = createDispatcher({
      registry, enabled: true, mutationsEnabled: true, environment: "test",
      resolveContext: async () => ctx(), audit: async () => {}, proposals,
      newProposalId: () => "prop-1",
    });
  });

  const spend = (extra: Record<string, unknown> = {}) => ({
    tool: "accounting.create_transaction",
    args: { type: "expense", amount: 450, note: "น้ำแข็ง", date: "2026-09-22" },
    idempotencyKey: "k1",
    ...extra,
  });

  it("เสนอการ์ดพร้อมหมวดที่เดาจากประวัติ และยังไม่เขียนอะไร", async () => {
    const result = await dispatch(spend());
    expect(result).toMatchObject({ ok: true, kind: "proposal" });
    const proposal = (result as unknown as { proposal: { summary: string; changes: { label: string; after: string }[]; prerequisites: unknown[] } }).proposal;
    expect(proposal.summary).toContain("หมวดเลือกจากประวัติ 3 ครั้ง");
    expect(proposal.changes.find((change) => change.label === "หมวด")?.after).toBe("วัตถุดิบ");
    expect(proposal.prerequisites).toEqual([]);
    expect(created).toEqual([]);
  });

  it("ยืนยันแล้วจึงบันทึกจริง ด้วยหมวดที่เดาไว้", async () => {
    await dispatch(spend());
    const result = await dispatch(spend({ idempotencyKey: "k2", confirm: { proposalId: "prop-1" } }));
    expect(result).toMatchObject({ ok: true });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ categoryId: "c-mat", categoryName: "วัตถุดิบ", amount: 450, note: "น้ำแข็ง", type: "expense" });
  });

  it("เดาหมวดไม่ได้ = ให้เลือก ไม่ใช่เดามั่ว", async () => {
    const result = await dispatch(spend({ args: { type: "expense", amount: 90, note: "ค่าจอดรถ" } }));
    const proposal = (result as unknown as { proposal: { prerequisites: { kind: string; options: { id: string }[] }[] } }).proposal;
    expect(proposal.prerequisites).toHaveLength(1);
    expect(proposal.prerequisites[0].kind).toBe("choose");
    expect(proposal.prerequisites[0].options.map((option) => option.id)).toEqual(["c-mat", "c-util"]);
    expect(created).toEqual([]);
  });

  it("เลือกหมวดแล้วยืนยันผ่าน และใช้หมวดที่เลือก", async () => {
    await dispatch(spend({ args: { type: "expense", amount: 90, note: "ค่าจอดรถ" } }));
    const result = await dispatch(spend({
      args: { type: "expense", amount: 90, note: "ค่าจอดรถ" },
      idempotencyKey: "k2",
      confirm: { proposalId: "prop-1", answers: { category: "c-util" } },
    }));
    expect(result).toMatchObject({ ok: true });
    expect(created[0]).toMatchObject({ categoryId: "c-util", categoryName: "ค่าสาธารณูปโภค" });
  });

  it("ร้านยังไม่มีหมวดเลย = เสนอสร้าง ไม่ใช่ตอบว่าลงไม่ได้", async () => {
    categories = [];
    const result = await dispatch(spend());
    const proposal = (result as unknown as { proposal: { prerequisites: { kind: string; createTool: string }[] } }).proposal;
    expect(proposal.prerequisites[0].kind).toBe("create");
    expect(proposal.prerequisites[0].createTool).toBe("accounting.create_category");
  });

  it("ยังเหลือสิ่งที่ขาด = ยืนยันไม่ได้ และไม่มีอะไรถูกบันทึก", async () => {
    categories = [];
    await dispatch(spend());
    const result = await dispatch(spend({ idempotencyKey: "k2", confirm: { proposalId: "prop-1" } }));
    expect(result).toEqual({ ok: false, code: "PREREQUISITE_REQUIRED" });
    expect(created).toEqual([]);
  });

  it("ยอดผิดปกติ = เตือน แต่ยังยืนยันได้", async () => {
    const result = await dispatch(spend({ args: { type: "expense", amount: 4500, note: "น้ำแข็ง" } }));
    const proposal = (result as unknown as { proposal: { warnings: string[] } }).proposal;
    expect(proposal.warnings).toHaveLength(1);
    expect(proposal.warnings[0]).toContain("ต่างจากที่ร้านเคยลง");
    const confirmed = await dispatch(spend({
      args: { type: "expense", amount: 4500, note: "น้ำแข็ง" },
      idempotencyKey: "k2",
      confirm: { proposalId: "prop-1" },
    }));
    expect(confirmed).toMatchObject({ ok: true });
  });

  it("เดาหมวดจากประวัติของร้านนี้ ไม่ใช่ความรู้ทั่วไป", () => {
    // ร้านนี้ลงค่าน้ำแข็งเป็น "ของใช้สิ้นเปลือง" — ต้องได้ตามที่ร้านเคยทำ
    const ownHistory = [
      txn("c-supply", "ของใช้สิ้นเปลือง", "น้ำแข็ง", 300, "2026-09-10"),
      txn("c-supply", "ของใช้สิ้นเปลือง", "น้ำแข็ง", 320, "2026-09-11"),
      txn("c-mat", "วัตถุดิบ", "นมสด", 900, "2026-09-12"),
    ];
    expect(suggestCategoryFromHistory(ownHistory, "expense", "น้ำแข็ง")).toMatchObject({
      categoryId: "c-supply", timesUsed: 2,
    });
  });

  it("ประวัติคนละประเภทไม่ถูกเอามาเดา", () => {
    const incomeOnly = [{ ...txn("c-x", "ขายของ", "น้ำแข็ง", 100, "2026-09-10"), type: "income" as const }];
    expect(suggestCategoryFromHistory(incomeOnly, "expense", "น้ำแข็ง")).toBeNull();
  });

  it("list_categories กรองตามประเภทและเป็น read จึงไม่ต้องยืนยัน", async () => {
    const result = await dispatch({ tool: "accounting.list_categories", args: { type: "expense" }, idempotencyKey: "k9" });
    expect(result).toMatchObject({ ok: true });
    expect((result as { data: { categories: unknown[] } }).data.categories).toHaveLength(2);
  });

  it("suggest_category คืนจำนวนครั้งให้คนตัดสินใจได้", async () => {
    const result = await dispatch({
      tool: "accounting.suggest_category",
      args: { type: "expense", note: "น้ำแข็ง" },
      idempotencyKey: "k10",
    });
    expect((result as { data: { suggestion: { categoryName: string; timesUsed: number } } }).data.suggestion)
      .toMatchObject({ categoryName: "วัตถุดิบ", timesUsed: 3 });
  });
});
