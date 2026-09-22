// P3 — tool เมนู: ชุดแรกที่ค่า before มีความหมายจริง
//
// บัญชีสร้างของใหม่ (ไม่มีสถานะเดิม) แต่เมนูคือการ "ทับของเดิม" — เทสชุดนี้จึงเน้น
// สิ่งที่บัญชีพิสูจน์ไม่ได้: คนอื่นแก้ราคาระหว่างที่การ์ดค้างอยู่ ต้องล้ม ไม่ใช่ทับ

import { describe, it, expect, beforeEach } from "vitest";
import { createDispatcher, ToolRegistry, type Result, type TrustedContext } from "@/modules/ai-assistant/foundation";
import { registerCatalogTools, type CatalogToolDeps } from "@/modules/ai-assistant/tools/catalog-tools";
import type { ProposalRecord, ProposalStore } from "@/modules/ai-assistant/proposal";
import type { Product } from "@/modules/catalog/types";
import { DEFAULT_BILLING_STATE } from "@/modules/billing/types";

const product = (id: string, name: string, basePrice: number, extra: Partial<Product> = {}): Product => ({
  id, storeId: "store-1", organizationId: "org-1", categoryId: "cat-1", name, basePrice,
  isActive: true, availableForPos: true, availableForQr: false, outOfStock: false,
  sortOrder: 0, variants: [], modifierGroups: [], createdAt: "", updatedAt: "",
  ...extra,
} as Product);

const ctx = (): TrustedContext => ({
  organizationId: "org-1", storeId: "store-1", userId: "user-1", sessionId: "sess-1", role: "owner",
  expiresAt: Date.now() + 30 * 60 * 1000,
  allowedTools: ["catalog.get_product", "catalog.update_price", "catalog.set_availability"],
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

describe("tool เมนู", () => {
  let products: Product[];
  let ambiguous: { id: string; name: string }[] | null;
  let updates: { id: string; patch: Record<string, unknown> }[];
  let proposalSeq: number;
  let dispatch: (request: unknown) => Promise<Result>;

  beforeEach(() => {
    products = [product("p-ame", "อเมริกาโน่เย็น", 55)];
    ambiguous = null;
    updates = [];
    proposalSeq = 0;
    const deps: CatalogToolDeps = {
      resolveProduct: async (_storeId, query) => {
        if (ambiguous) return { status: "ambiguous", candidates: ambiguous };
        const found = products.find((item) => item.name.includes(query));
        return found ? { status: "found", product: found } : { status: "not_found" };
      },
      getProduct: async (productId) => products.find((item) => item.id === productId) ?? null,
      listCategories: async () => [{ id: "cat-1", name: "เครื่องดื่ม" }],
      updateProduct: async (id, _storeId, patch) => { updates.push({ id, patch }); },
      createProduct: async () => ({ id: "new-1" }),
    };
    const registry = new ToolRegistry("test");
    registerCatalogTools(registry, deps);
    dispatch = createDispatcher({
      registry, enabled: true, mutationsEnabled: true, environment: "test",
      resolveContext: async () => ctx(), audit: async () => {}, proposals: memoryProposals(),
      newProposalId: () => `prop-${++proposalSeq}`,
    });
  });

  const repriceCommand = (extra: Record<string, unknown> = {}) => ({
    tool: "catalog.update_price",
    args: { product: "อเมริกาโน่เย็น", price: 60 },
    idempotencyKey: "k1",
    ...extra,
  });

  it("การ์ดโชว์ราคาเดิมเป็น before เสมอ", async () => {
    const result = await dispatch(repriceCommand());
    const proposal = (result as unknown as { proposal: { changes: { label: string; before: string; after: string }[] } }).proposal;
    expect(proposal.changes[0]).toMatchObject({ label: "ราคา", before: "55 บาท", after: "60 บาท" });
    expect(updates).toEqual([]);
  });

  it("คนอื่นแก้ราคาระหว่างที่การ์ดค้าง = ล้ม ไม่ใช่ทับ", async () => {
    await dispatch(repriceCommand());
    // ระหว่างที่ผู้ใช้อ่านการ์ด มีคนแก้ราคาเป็น 70
    products = [product("p-ame", "อเมริกาโน่เย็น", 70)];
    const result = await dispatch(repriceCommand({ idempotencyKey: "k2", confirm: { proposalId: "prop-1" } }));
    expect(result).toEqual({ ok: false, code: "PROPOSAL_STALE" });
    expect(updates).toEqual([]);
  });

  it("ยืนยันแล้วแก้ราคาจริง", async () => {
    await dispatch(repriceCommand());
    const result = await dispatch(repriceCommand({ idempotencyKey: "k2", confirm: { proposalId: "prop-1" } }));
    expect(result).toMatchObject({ ok: true });
    expect(updates).toEqual([{ id: "p-ame", patch: { basePrice: 60 } }]);
  });

  it("ราคาต่างจากเดิมมาก = เตือน (ฟังเลขผิดเป็นเรื่องปกติ)", async () => {
    const result = await dispatch(repriceCommand({ args: { product: "อเมริกาโน่เย็น", price: 600 } }));
    const proposal = (result as unknown as { proposal: { warnings: string[] } }).proposal;
    expect(proposal.warnings.some((warning) => warning.includes("ต่างจากเดิมมาก"))).toBe(true);
  });

  it("เมนูที่เปิดขายบน QR ต้องเตือนว่าลูกค้าเห็นทันที", async () => {
    products = [product("p-ame", "อเมริกาโน่เย็น", 55, { availableForQr: true })];
    const result = await dispatch(repriceCommand());
    const proposal = (result as unknown as { proposal: { warnings: string[] } }).proposal;
    expect(proposal.warnings.some((warning) => warning.includes("QR"))).toBe(true);
  });

  it("ชื่อกำกวม = ให้เลือก ไม่ใช่ error", async () => {
    ambiguous = [{ id: "p-hot", name: "ลาเต้ร้อน" }, { id: "p-ice", name: "ลาเต้เย็น" }];
    const result = await dispatch(repriceCommand({ args: { product: "ลาเต้", price: 60 } }));
    const proposal = (result as unknown as { proposal: { prerequisites: { kind: string; options: { id: string }[] }[] } }).proposal;
    expect(proposal.prerequisites[0].kind).toBe("choose");
    expect(proposal.prerequisites[0].options.map((option) => option.id)).toEqual(["p-hot", "p-ice"]);
  });

  it("ตอบชื่อเมนูที่กำกวมแล้ว ได้การ์ดใบใหม่ที่มีราคาเดิม ก่อนจะเขียนจริง", async () => {
    // ตอนกำกวมเรายังไม่รู้ว่าเมนูไหน จึงยังไม่รู้ราคาเดิม — ผู้ใช้ต้องได้เห็นก่อนเขียน
    products = [product("p-hot", "ลาเต้ร้อน", 50), product("p-ice", "ลาเต้เย็น", 55)];
    ambiguous = [{ id: "p-hot", name: "ลาเต้ร้อน" }, { id: "p-ice", name: "ลาเต้เย็น" }];
    await dispatch(repriceCommand({ args: { product: "ลาเต้", price: 60 } }));

    const refined = await dispatch(repriceCommand({
      args: { product: "ลาเต้", price: 60 },
      idempotencyKey: "k2",
      confirm: { proposalId: "prop-1", answers: { product: "p-ice" } },
    }));
    expect(refined).toMatchObject({ ok: true, kind: "proposal" });
    const card = (refined as unknown as { proposal: { id: string; changes: { before: string; after: string }[] } }).proposal;
    expect(card.changes[0]).toMatchObject({ before: "55 บาท", after: "60 บาท" });
    expect(updates).toEqual([]);

    const done = await dispatch(repriceCommand({
      args: { product: "ลาเต้", price: 60 },
      idempotencyKey: "k3",
      confirm: { proposalId: card.id, answers: { product: "p-ice" } },
    }));
    expect(done).toMatchObject({ ok: true });
    expect(updates).toEqual([{ id: "p-ice", patch: { basePrice: 60 } }]);
  });

  it("การ์ดใบเก่าถูกปิดทันทีที่ออกใบใหม่ (ห้ามเหลือใบค้างที่กดได้อีก)", async () => {
    products = [product("p-hot", "ลาเต้ร้อน", 50), product("p-ice", "ลาเต้เย็น", 55)];
    ambiguous = [{ id: "p-hot", name: "ลาเต้ร้อน" }, { id: "p-ice", name: "ลาเต้เย็น" }];
    await dispatch(repriceCommand({ args: { product: "ลาเต้", price: 60 } }));
    await dispatch(repriceCommand({
      args: { product: "ลาเต้", price: 60 }, idempotencyKey: "k2",
      confirm: { proposalId: "prop-1", answers: { product: "p-ice" } },
    }));
    const reused = await dispatch(repriceCommand({
      args: { product: "ลาเต้", price: 60 }, idempotencyKey: "k3",
      confirm: { proposalId: "prop-1", answers: { product: "p-hot" } },
    }));
    expect(reused).toEqual({ ok: false, code: "PROPOSAL_NOT_FOUND" });
    expect(updates).toEqual([]);
  });

  it("ไม่พบเมนู = เสนอสร้าง ไม่ใช่ตอบว่าทำไม่ได้", async () => {
    const result = await dispatch(repriceCommand({ args: { product: "โกโก้มิ้นท์", price: 60 } }));
    const proposal = (result as unknown as { proposal: { prerequisites: { kind: string; reason: string }[] } }).proposal;
    expect(proposal.prerequisites[0].kind).toBe("create");
    expect(proposal.prerequisites[0].reason).toContain("โกโก้มิ้นท์");
  });

  it("ของหมดวันนี้กับซ่อนออกจากเมนู เป็นคนละเรื่องในการ์ด", async () => {
    const outOfStock = await dispatch({
      tool: "catalog.set_availability",
      args: { product: "อเมริกาโน่เย็น", state: "out_of_stock" },
      idempotencyKey: "a1",
    });
    expect((outOfStock as unknown as { proposal: { changes: { label: string }[] } }).proposal.changes[0].label).toBe("ของหมดวันนี้");

    const hidden = await dispatch({
      tool: "catalog.set_availability",
      args: { product: "อเมริกาโน่เย็น", state: "hide" },
      idempotencyKey: "a2",
    });
    expect((hidden as unknown as { proposal: { changes: { label: string }[] } }).proposal.changes[0].label).toBe("แสดงในเมนู");
  });

  it("สั่งสถานะที่เป็นอยู่แล้ว = เตือน แต่ยังทำได้", async () => {
    const result = await dispatch({
      tool: "catalog.set_availability",
      args: { product: "อเมริกาโน่เย็น", state: "back_in_stock" },
      idempotencyKey: "a3",
    });
    const proposal = (result as unknown as { proposal: { warnings: string[] } }).proposal;
    expect(proposal.warnings).toContain("สถานะนี้เป็นค่าปัจจุบันอยู่แล้ว");
  });

  it("get_product เป็น read จึงตอบทันทีไม่ต้องยืนยัน", async () => {
    const result = await dispatch({ tool: "catalog.get_product", args: { product: "อเมริกาโน่เย็น" }, idempotencyKey: "g1" });
    expect((result as { data: { product: { basePrice: number } } }).data.product.basePrice).toBe(55);
  });

  it("get_product คืนตัวเลือกเมื่อกำกวม", async () => {
    ambiguous = [{ id: "p-hot", name: "ลาเต้ร้อน" }, { id: "p-ice", name: "ลาเต้เย็น" }];
    const result = await dispatch({ tool: "catalog.get_product", args: { product: "ลาเต้" }, idempotencyKey: "g2" });
    const data = (result as { data: { product: unknown; candidates: unknown[] } }).data;
    expect(data.product).toBeNull();
    expect(data.candidates).toHaveLength(2);
  });
});

describe("เพิ่มเมนูใหม่เข้าระบบ", () => {
  // "เพิ่มเมนู X" ในแผงหลังร้าน = เพิ่มรายการเข้าระบบ ไม่ใช่เพิ่มลงตะกร้า
  let categories: { id: string; name: string }[];
  let created: unknown[];
  let found: Product[];
  let dispatch: (request: unknown) => Promise<Result>;

  beforeEach(() => {
    categories = [{ id: "cat-1", name: "เครื่องดื่ม" }, { id: "cat-2", name: "อาหาร" }];
    created = [];
    found = [];
    const registry = new ToolRegistry("test");
    registerCatalogTools(registry, {
      resolveProduct: async (_storeId, query) => {
        const hit = found.find((item) => item.name.includes(query));
        return hit ? { status: "found", product: hit } : { status: "not_found" };
      },
      getProduct: async () => null,
      listCategories: async () => categories,
      updateProduct: async () => {},
      createProduct: async (input) => { created.push(input); return { id: "new-1" }; },
    });
    dispatch = createDispatcher({
      registry, enabled: true, mutationsEnabled: true, environment: "test",
      resolveContext: async () => ({ ...ctx(), allowedTools: ["catalog.create_product"] }),
      audit: async () => {}, proposals: memoryProposals(), newProposalId: () => "prop-1",
    });
  });

  const create = (extra: Record<string, unknown> = {}) => ({
    tool: "catalog.create_product",
    args: { name: "อาหารต้ม" },
    idempotencyKey: "c1",
    ...extra,
  });

  it("ไม่ได้บอกหมวด = ให้เลือกก่อน ไม่เดาให้", async () => {
    const result = await dispatch(create());
    const proposal = (result as unknown as { proposal: { prerequisites: { kind: string; options: { id: string }[] }[] } }).proposal;
    expect(proposal.prerequisites[0].kind).toBe("choose");
    expect(proposal.prerequisites[0].options.map((option) => option.id)).toEqual(["cat-1", "cat-2"]);
    expect(created).toEqual([]);
  });

  it("เลือกหมวดแล้วสร้างจริง และสร้างเป็นเมนูหน้าร้านก่อน", async () => {
    await dispatch(create());
    const refined = await dispatch(create({ idempotencyKey: "c2", confirm: { proposalId: "prop-1", answers: { category: "cat-2" } } }));
    // ตอบหมวดแล้ว "หมวด" ใน changes เปลี่ยน แต่ before ยังเป็น null ทุกช่อง จึงยืนยันได้เลย
    expect(refined).toMatchObject({ ok: true });
    expect(created[0]).toMatchObject({ categoryId: "cat-2", name: "อาหารต้ม", basePrice: 0 });
  });

  it("ร้านยังไม่มีหมวดเลย = เสนอสร้างหมวดก่อน", async () => {
    categories = [];
    const result = await dispatch(create());
    const proposal = (result as unknown as { proposal: { prerequisites: { kind: string; createTool: string }[] } }).proposal;
    expect(proposal.prerequisites[0].kind).toBe("create");
    expect(proposal.prerequisites[0].createTool).toBe("catalog.create_category");
  });

  it("ชื่อชนของเดิม = เตือนว่าจะได้สองรายการ", async () => {
    found = [product("p-old", "อาหารต้ม", 50)];
    const result = await dispatch(create());
    const proposal = (result as unknown as { proposal: { warnings: string[] } }).proposal;
    expect(proposal.warnings.some((warning) => warning.includes("อยู่แล้ว"))).toBe(true);
  });

  it("ไม่บอกราคา = เตือนว่าจะเป็น 0 บาท แต่ไม่บล็อก", async () => {
    const result = await dispatch(create());
    const proposal = (result as unknown as { proposal: { warnings: string[]; changes: { label: string; after: string }[] } }).proposal;
    expect(proposal.warnings.some((warning) => warning.includes("0 บาท"))).toBe(true);
    expect(proposal.changes.find((change) => change.label === "ราคา")?.after).toBe("0 บาท");
  });
});
