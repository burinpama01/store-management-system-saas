// P5 — tool สต็อก
//
// สิ่งที่ต้องพิสูจน์: ตัวเลขคงเหลือที่โชว์ในการ์ดต้องเป็น "ที่ขายได้จริง" และจำนวนเดิม
// ต้องอยู่ใน before เสมอ — ถ้าระหว่างที่ผู้ใช้ดูการ์ดมีคนขายของไป การยืนยันต้องล้ม
// ไม่ใช่ทับด้วยตัวเลขที่คิดจากภาพเก่า

import { describe, it, expect, beforeEach } from "vitest";
import { createDispatcher, ToolRegistry, type Result, type TrustedContext } from "@/modules/ai-assistant/foundation";
import { registerStockTools, type StockToolDeps, type StockVariantRef } from "@/modules/ai-assistant/tools/stock-tools";
import type { ProposalRecord, ProposalStore } from "@/modules/ai-assistant/proposal";
import { DEFAULT_BILLING_STATE } from "@/modules/billing/types";

const variant = (
  variantId: string, productName: string, variantName: string,
  available: number | undefined, trackStock = true,
): StockVariantRef => ({ variantId, productId: `p-${variantId}`, productName, variantName, available, trackStock });

const ctx = (): TrustedContext => ({
  organizationId: "org-1", storeId: "store-1", userId: "user-1", sessionId: "sess-1", role: "owner",
  expiresAt: Date.now() + 30 * 60 * 1000,
  allowedTools: ["stock.check", "stock.adjust"],
  billing: { ...DEFAULT_BILLING_STATE, plan: "enterprise", status: "active" },
  can: () => true,
});

function memoryProposals(): ProposalStore {
  const rows = new Map<string, ProposalRecord & { used: boolean }>();
  return {
    save: async (record) => { rows.set(record.id, { ...record, used: false }); },
    load: async (id) => { const row = rows.get(id); return row && !row.used ? row : null; },
    consume: async (id) => { const row = rows.get(id); if (!row || row.used) return false; row.used = true; return true; },
  };
}

describe("tool สต็อก", () => {
  let matches: StockVariantRef[];
  let writes: { variantId: string; quantity: number }[];
  let proposalSeq: number;
  let dispatch: (request: unknown) => Promise<Result>;

  beforeEach(() => {
    matches = [variant("v1", "ข้าวผัด", "ปกติ", 15)];
    writes = [];
    proposalSeq = 0;
    const deps: StockToolDeps = {
      findVariants: async () => matches,
      getVariant: async (_storeId, variantId) => matches.find((item) => item.variantId === variantId) ?? null,
      setVariantStock: async (variantId, _storeId, quantity) => { writes.push({ variantId, quantity }); },
    };
    const registry = new ToolRegistry("test");
    registerStockTools(registry, deps);
    dispatch = createDispatcher({
      registry, enabled: true, mutationsEnabled: true, environment: "test",
      resolveContext: async () => ctx(), audit: async () => {}, proposals: memoryProposals(),
      newProposalId: () => `prop-${++proposalSeq}`,
    });
  });

  const adjust = (extra: Record<string, unknown> = {}) => ({
    tool: "stock.adjust",
    args: { product: "ข้าวผัด", quantity: 25 },
    idempotencyKey: "k1",
    ...extra,
  });

  it("การ์ดโชว์จำนวนเดิมเป็น before", async () => {
    const result = await dispatch(adjust());
    const proposal = (result as unknown as { proposal: { changes: { before: string; after: string }[] } }).proposal;
    expect(proposal.changes[0]).toMatchObject({ before: "15", after: "25" });
    expect(writes).toEqual([]);
  });

  it("มีคนขายของระหว่างที่การ์ดค้าง = ล้ม ไม่ใช่ทับด้วยภาพเก่า", async () => {
    await dispatch(adjust());
    matches = [variant("v1", "ข้าวผัด", "ปกติ", 12)];
    const result = await dispatch(adjust({ idempotencyKey: "k2", confirm: { proposalId: "prop-1" } }));
    expect(result).toEqual({ ok: false, code: "PROPOSAL_STALE" });
    expect(writes).toEqual([]);
  });

  it("ยืนยันแล้วตั้งจำนวนจริง", async () => {
    await dispatch(adjust());
    const result = await dispatch(adjust({ idempotencyKey: "k2", confirm: { proposalId: "prop-1" } }));
    expect(result).toMatchObject({ ok: true });
    expect(writes).toEqual([{ variantId: "v1", quantity: 25 }]);
  });

  it("ตัวเลือกกำกวม = ให้เลือก พร้อมบอกคงเหลือของแต่ละตัว", async () => {
    matches = [variant("v-hot", "ลาเต้", "ร้อน", 5), variant("v-ice", "ลาเต้", "เย็น", 8)];
    const result = await dispatch(adjust({ args: { product: "ลาเต้", quantity: 25 } }));
    const proposal = (result as unknown as { proposal: { prerequisites: { kind: string; options: { id: string; label: string }[] }[] } }).proposal;
    expect(proposal.prerequisites[0].kind).toBe("choose");
    expect(proposal.prerequisites[0].options[0].label).toContain("คงเหลือ 5");
    expect(proposal.prerequisites[0].options.map((option) => option.id)).toEqual(["v-hot", "v-ice"]);
  });

  it("ยังไม่เปิดนับสต็อก = เตือนว่ากำลังเปลี่ยนพฤติกรรมการขาย", async () => {
    matches = [variant("v1", "ข้าวผัด", "ปกติ", undefined, false)];
    const result = await dispatch(adjust());
    const proposal = (result as unknown as { proposal: { changes: { before: string }[]; warnings: string[] } }).proposal;
    expect(proposal.changes[0].before).toBe("ไม่ได้นับสต็อก");
    expect(proposal.warnings.some((warning) => warning.includes("เริ่มตัดสต็อก"))).toBe(true);
  });

  it("ตั้งเป็น 0 = เตือนว่าขายต่อไม่ได้", async () => {
    const result = await dispatch(adjust({ args: { product: "ข้าวผัด", quantity: 0 } }));
    const proposal = (result as unknown as { proposal: { warnings: string[] } }).proposal;
    expect(proposal.warnings.some((warning) => warning.includes("ขายต่อไม่ได้"))).toBe(true);
  });

  it("ไม่พบสินค้า = เสนอสร้าง ไม่ใช่ตอบว่าทำไม่ได้", async () => {
    matches = [];
    const result = await dispatch(adjust({ args: { product: "โกโก้มิ้นท์", quantity: 5 } }));
    const proposal = (result as unknown as { proposal: { prerequisites: { kind: string }[] } }).proposal;
    expect(proposal.prerequisites[0].kind).toBe("create");
  });

  it("stock.check เป็น read จึงตอบทันที และคืนคงเหลือที่ขายได้จริง", async () => {
    matches = [variant("v1", "ข้าวผัด", "ปกติ", 15), variant("v2", "ข้าวผัด", "พิเศษ", undefined, false)];
    const result = await dispatch({ tool: "stock.check", args: { product: "ข้าวผัด" }, idempotencyKey: "c1" });
    const data = (result as { data: { variants: { available: number | null; trackStock: boolean }[] } }).data;
    expect(data.variants[0]).toMatchObject({ available: 15, trackStock: true });
    expect(data.variants[1]).toMatchObject({ available: null, trackStock: false });
  });
});
