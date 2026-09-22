// P4 — "เปิด QR ทุกเมนู": ที่ที่หลักการ "ไม่มีให้เพิ่ม ไม่ใช่ข้าม" ถูกทดสอบจริง
//
// เทสสำคัญที่สุดสองข้อคือข้อที่พิสูจน์ว่า **ไม่มีเส้นทางไหนเปิดครึ่ง ๆ แล้วเดินต่อเงียบ ๆ**
// ทั้งตอนเสนอ (ต้องรวบเมนูที่ขาดมาให้เลือกครบ) และตอนเขียน (ขาดแม้ตัวเดียวต้องล้มทั้งชุด)

import { describe, it, expect, beforeEach } from "vitest";
import { createDispatcher, ToolRegistry, type Result, type TrustedContext } from "@/modules/ai-assistant/foundation";
import { registerQrTools, type QrToolDeps } from "@/modules/ai-assistant/tools/qr-tools";
import type { ProposalRecord, ProposalStore } from "@/modules/ai-assistant/proposal";
import type { Product } from "@/modules/catalog/types";
import { DEFAULT_BILLING_STATE } from "@/modules/billing/types";

const product = (id: string, name: string, extra: Partial<Product> = {}): Product => ({
  id, storeId: "store-1", organizationId: "org-1", categoryId: "cat-1", name, basePrice: 50,
  isActive: true, availableForPos: true, availableForQr: false, outOfStock: false,
  sortOrder: 0, variants: [], modifierGroups: [], createdAt: "", updatedAt: "",
  ...extra,
} as Product);

const ctx = (): TrustedContext => ({
  organizationId: "org-1", storeId: "store-1", userId: "user-1", sessionId: "sess-1",
  expiresAt: Date.now() + 30 * 60 * 1000,
  allowedTools: ["qr.bulk_set_visibility"],
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

describe("เปิด-ปิด QR แบบทั้งร้าน", () => {
  let products: Product[];
  let stations: { id: string; name: string }[];
  let storeEnabled: boolean;
  let visibilityWrites: { id: string; visible: boolean }[];
  let stationWrites: { id: string; stationId: string }[];
  let storeSwitchWrites: boolean[];
  let proposalSeq: number;
  let dispatch: (request: unknown) => Promise<Result>;

  beforeEach(() => {
    products = [
      product("p1", "อเมริกาโน่เย็น", { kitchenStationId: "st-bar" }),
      product("p2", "ลาเต้ร้อน"),
      product("p3", "ข้าวกะเพรา"),
      product("p4", "เมนูที่ซ่อนอยู่", { isActive: false }),
    ];
    stations = [{ id: "st-bar", name: "บาร์" }, { id: "st-hot", name: "ครัวร้อน" }];
    storeEnabled = false;
    visibilityWrites = [];
    stationWrites = [];
    storeSwitchWrites = [];
    proposalSeq = 0;
    const deps: QrToolDeps = {
      listProducts: async () => products,
      listStations: async () => stations,
      getStoreQrEnabled: async () => storeEnabled,
      setStoreQrEnabled: async (_storeId, enabled) => { storeSwitchWrites.push(enabled); },
      setProductQrVisibility: async (id, _storeId, visible) => { visibilityWrites.push({ id, visible }); },
      assignProductStation: async (id, _storeId, stationId) => { stationWrites.push({ id, stationId }); },
    };
    const registry = new ToolRegistry("test");
    registerQrTools(registry, deps);
    dispatch = createDispatcher({
      registry, enabled: true, mutationsEnabled: true, environment: "test",
      resolveContext: async () => ctx(), audit: async () => {}, proposals: memoryProposals(),
      newProposalId: () => `prop-${++proposalSeq}`,
    });
  });

  const openAll = (extra: Record<string, unknown> = {}) => ({
    tool: "qr.bulk_set_visibility",
    args: { scope: "all", visible: true },
    idempotencyKey: "k1",
    ...extra,
  });

  it("เมนูที่ยังไม่ผูกสถานีขึ้นครบทุกตัวในจอเดียว — ไม่ข้าม ไม่ทยอยถาม", async () => {
    const result = await dispatch(openAll());
    const proposal = (result as unknown as { proposal: { prerequisites: { kind: string; subjects: { id: string }[]; options: { id: string }[] }[]; affectedCount: number } }).proposal;
    expect(proposal.prerequisites).toHaveLength(1);
    expect(proposal.prerequisites[0].kind).toBe("choose");
    expect(proposal.prerequisites[0].subjects.map((subject) => subject.id)).toEqual(["p2", "p3"]);
    expect(proposal.prerequisites[0].options.map((option) => option.id)).toEqual(["st-bar", "st-hot"]);
    // เมนูที่ซ่อนอยู่ไม่ถูกลากมาเปิดโดยไม่ได้ตั้งใจ
    expect(proposal.affectedCount).toBe(3);
    expect(visibilityWrites).toEqual([]);
  });

  it("ตอบสถานีไม่ครบ = ไม่เขียนอะไรเลย ไม่ใช่เปิดเท่าที่ทำได้", async () => {
    await dispatch(openAll());
    const result = await dispatch(openAll({ idempotencyKey: "k2", confirm: { proposalId: "prop-1", answers: { p2: "st-bar" } } }));
    expect(result).toEqual({ ok: false, code: "PREREQUISITE_REQUIRED" });
    expect(visibilityWrites).toEqual([]);
    expect(stationWrites).toEqual([]);
  });

  it("ตอบครบ = ผูกสถานีให้ก่อน แล้วเปิด QR และเปิดสวิตช์ร้านให้ด้วย", async () => {
    await dispatch(openAll());
    const answers = { p2: "st-bar", p3: "st-hot" };
    const refined = await dispatch(openAll({ idempotencyKey: "k2", confirm: { proposalId: "prop-1", answers } }));
    // ตอบแล้ว prerequisite หาย แต่ affectedCount/before เท่าเดิม จึงยืนยันได้เลย
    expect(refined).toMatchObject({ ok: true });
    expect(stationWrites).toEqual([{ id: "p2", stationId: "st-bar" }, { id: "p3", stationId: "st-hot" }]);
    expect(visibilityWrites.map((write) => write.id)).toEqual(["p1", "p2", "p3"]);
    expect(storeSwitchWrites).toEqual([true]);
  });

  it("ร้านยังไม่มีสถานีเลย = เสนอสร้าง ไม่ใช่ให้เลือกจากรายการว่าง", async () => {
    stations = [];
    const result = await dispatch(openAll());
    const proposal = (result as unknown as { proposal: { prerequisites: { kind: string; createTool: string; reason: string }[] } }).proposal;
    expect(proposal.prerequisites[0].kind).toBe("create");
    expect(proposal.prerequisites[0].createTool).toBe("kitchen.create_station");
    expect(proposal.prerequisites[0].reason).toContain("2 เมนู");
  });

  it("การ์ดบอกจำนวนที่กระทบและสถานะเดิมเสมอ", async () => {
    const result = await dispatch(openAll());
    const proposal = (result as unknown as { proposal: { changes: { label: string; before: string; after: string }[]; summary: string } }).proposal;
    expect(proposal.summary).toContain("3 เมนู");
    expect(proposal.changes[0].before).toBe("0 เมนู");
    expect(proposal.changes.some((change) => change.label === "สวิตช์ QR ของร้าน")).toBe(true);
  });

  it("สวิตช์ร้านเปิดอยู่แล้ว ไม่ต้องโชว์ว่าจะเปลี่ยน", async () => {
    storeEnabled = true;
    const result = await dispatch(openAll());
    const proposal = (result as unknown as { proposal: { changes: { label: string }[] } }).proposal;
    expect(proposal.changes.some((change) => change.label === "สวิตช์ QR ของร้าน")).toBe(false);
  });

  it("ปิด QR ไม่ต้องมีสถานี (เงื่อนไขสถานีเป็นของการเปิดเท่านั้น)", async () => {
    products = products.map((item) => ({ ...item, availableForQr: true }));
    const result = await dispatch({ tool: "qr.bulk_set_visibility", args: { scope: "all", visible: false }, idempotencyKey: "c1" });
    const proposal = (result as unknown as { proposal: { prerequisites: unknown[] } }).proposal;
    expect(proposal.prerequisites).toEqual([]);
  });

  it("เปิดเฉพาะหมวด = แตะเฉพาะเมนูในหมวดนั้น", async () => {
    products = [
      product("p1", "กาแฟ", { categoryId: "cat-drink", kitchenStationId: "st-bar" }),
      product("p2", "ข้าว", { categoryId: "cat-food", kitchenStationId: "st-hot" }),
    ];
    const result = await dispatch({
      tool: "qr.bulk_set_visibility",
      args: { scope: "category", categoryId: "cat-drink", visible: true },
      idempotencyKey: "s1",
    });
    expect((result as unknown as { proposal: { affectedCount: number } }).proposal.affectedCount).toBe(1);
  });

  it("ไม่มีอะไรต้องเปลี่ยน = เตือนให้รู้ตัว", async () => {
    products = [product("p1", "กาแฟ", { availableForQr: true, kitchenStationId: "st-bar" })];
    const result = await dispatch(openAll());
    const proposal = (result as unknown as { proposal: { warnings: string[]; affectedCount: number } }).proposal;
    expect(proposal.affectedCount).toBe(0);
    expect(proposal.warnings[0]).toContain("ไม่มีเมนูที่ต้องเปลี่ยน");
  });
});
