import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_BILLING_STATE } from "@/modules/billing/types";
import { createDispatcher, ToolRegistry, type CartBinding, type TrustedContext } from "@/modules/ai-assistant/foundation";
import { MVP_TOOL_NAMES, registerPosTools } from "@/modules/ai-assistant/tools/pos-tools";
import type { Product } from "@/modules/catalog/types";
import type { VoiceProductAlias } from "@/modules/voice-pos/cart";

// PR2 — MVP tools ต้องผ่าน resolver เดิมของ Voice POS เป็นทางเดียว (ADR-009):
// คลุมเครือ/ต้องเลือกตัวเลือก/ของหมด = clarification จาก resolver ไม่ใช่การเดา และไม่มี id จากโมเดล

const CART = "cart-12345678";

function product(overrides: Partial<Product> & { id: string; name: string }): Product {
  return {
    storeId: "store",
    organizationId: "org",
    categoryId: "cat",
    basePrice: 50,
    isActive: true,
    availableForPos: true,
    availableForQr: true,
    sortOrder: 0,
    variants: [],
    modifierGroups: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

const variant = (id: string, productId: string, name: string) => ({ id, productId, name, priceAdjustment: 0, trackStock: false, isActive: true, sortOrder: 0 });

const defaultProducts: readonly Product[] = [
  product({ id: "p-latte", name: "ลาเต้", basePrice: 55 }),
  product({ id: "p-greentea", name: "ชาเขียว", basePrice: 40 }),
  product({ id: "p-thaitea", name: "ชาไทย", basePrice: 45 }),
  product({
    id: "p-black",
    name: "กาแฟดำ",
    basePrice: 45,
    variants: [variant("v-hot", "p-black", "ร้อน"), variant("v-iced", "p-black", "เย็น")],
  }),
  product({ id: "p-cocoa", name: "โกโก้", basePrice: 60, outOfStock: true }),
];

function setup(options: { products?: readonly Product[]; aliases?: readonly VoiceProductAlias[]; environment?: "test" | "production"; mutations?: boolean; binding?: CartBinding | null } = {}) {
  const ctx: TrustedContext = {
    organizationId: "org",
    storeId: "store",
    userId: "user",
    sessionId: "session",
    expiresAt: Date.now() + 60000,
    allowedTools: [...MVP_TOOL_NAMES],
    billing: { ...DEFAULT_BILLING_STATE, plan: "enterprise", status: "active" },
    can: () => true,
  };
  const loadCatalog = vi.fn(async () => ({ products: options.products ?? defaultProducts, aliases: options.aliases ?? [] }));
  const registry = new ToolRegistry(options.environment ?? "test");
  registerPosTools(registry, { loadCatalog });
  const audit = vi.fn(async () => {});
  const binding: CartBinding = { activeCartId: CART, cartVersion: 3 };
  const dispatch = createDispatcher({
    registry,
    enabled: true,
    environment: options.environment ?? "test",
    mutationsEnabled: options.mutations ?? true,
    resolveContext: async () => ctx,
    audit,
    resolveCartBinding: vi.fn(async (): Promise<CartBinding | null> => ("binding" in options ? options.binding ?? null : binding)),
  });
  return { ctx, loadCatalog, audit, dispatch };
}

const cartArgs = { activeCartId: CART, cartVersion: 3 };
const addArgs = { ...cartArgs, productPhrase: "ลาเต้", quantity: 2, optionPhrases: [] };

beforeEach(() => vi.clearAllMocks());

describe("pos search tools through the shared resolver", () => {
  it("registers exactly the MVP tool set", () => {
    const { loadCatalog } = setup();
    expect(loadCatalog).not.toHaveBeenCalled();
  });

  it("searches with the voice resolver and returns matched product + price", async () => {
    const s = setup();
    expect(await s.dispatch({ tool: "pos.search_product", args: { query: "ลาเต้" }, idempotencyKey: "s1" })).toEqual({
      ok: true,
      data: { status: "matched", product: { id: "p-latte", name: "ลาเต้" }, price: 55, outOfStock: false, note: null },
    });
  });

  it("resolves store-approved aliases through the shared resolver", async () => {
    const s = setup({ aliases: [{ aliasText: "มัจฉะ", productId: "p-latte" }] });
    expect(await s.dispatch({ tool: "pos.search_product", args: { query: "มัจฉะ" }, idempotencyKey: "s2" })).toEqual({
      ok: true,
      data: { status: "matched", product: { id: "p-latte", name: "ลาเต้" }, price: 55, outOfStock: false, note: null },
    });
  });

  it("returns resolver candidates on ambiguity instead of guessing", async () => {
    const s = setup();
    expect(await s.dispatch({ tool: "catalog.search", args: { query: "ชา" }, idempotencyKey: "s3" })).toEqual({
      ok: true,
      data: { status: "ambiguous", candidates: [{ id: "p-greentea", name: "ชาเขียว" }, { id: "p-thaitea", name: "ชาไทย" }] },
    });
  });

  it("reports not_found without inventing ids", async () => {
    const s = setup();
    expect(await s.dispatch({ tool: "pos.search_product", args: { query: "น้ำมะพร้าว" }, idempotencyKey: "s4" })).toEqual({
      ok: true,
      data: { status: "not_found", note: "ไม่พบสินค้าที่ค้นหา" },
    });
  });
});

describe("cart mutation tools through the shared resolver", () => {
  it("approves add_item and returns the intent for the client bridge", async () => {
    const s = setup();
    expect(await s.dispatch({ tool: "pos.add_item", args: addArgs, idempotencyKey: "a1" })).toEqual({
      ok: true,
      data: { status: "apply", intent: { type: "pos.add_item", productPhrase: "ลาเต้", quantity: 2 }, productName: "ลาเต้" },
    });
    expect(s.loadCatalog).toHaveBeenCalledTimes(1);
  });

  it("maps ambiguity to clarification with the resolver candidates", async () => {
    const s = setup();
    const result = await s.dispatch({ tool: "pos.add_item", args: { ...addArgs, productPhrase: "ชา" }, idempotencyKey: "a2" });
    expect(result).toEqual({
      ok: true,
      data: { status: "clarification", reason: "ambiguous", candidates: [{ id: "p-greentea", name: "ชาเขียว" }, { id: "p-thaitea", name: "ชาไทย" }] },
    });
  });

  it("maps missing variant to needs_option clarification", async () => {
    const s = setup();
    expect(await s.dispatch({ tool: "pos.add_item", args: { ...addArgs, productPhrase: "กาแฟดำ" }, idempotencyKey: "a3" })).toEqual({
      ok: true,
      data: { status: "clarification", reason: "needs_option", productId: "p-black", productName: "กาแฟดำ", note: "ยังต้องเลือกตัวเลือกสินค้า" },
    });
  });

  it("maps out-of-stock products to unavailable clarification", async () => {
    const s = setup();
    expect(await s.dispatch({ tool: "pos.add_item", args: { ...addArgs, productPhrase: "โกโก้" }, idempotencyKey: "a4" })).toEqual({
      ok: true,
      data: { status: "clarification", reason: "unavailable", productName: "โกโก้" },
    });
  });

  it("does not apply add_item when a spoken option is unknown to the store", async () => {
    const s = setup();
    expect(await s.dispatch({ tool: "pos.add_item", args: { ...addArgs, productPhrase: "ลาเต้", optionPhrases: ["สีม่วง"] }, idempotencyKey: "a5" })).toEqual({
      ok: true,
      data: { status: "clarification", reason: "needs_option", productId: "p-latte", productName: "ลาเต้", note: "ยังต้องเลือกตัวเลือกสินค้า" },
    });
  });

  it.each([
    ["set", "pos.set_quantity", { quantity: 5 } as const],
    ["increase", "pos.increase_item", { delta: 2 } as const],
    ["decrease", "pos.decrease_item", { delta: 1 } as const],
  ])("routes change_quantity %s to the voice intent of the same meaning", async (mode, intentType, extra) => {
    const s = setup();
    const result = await s.dispatch({ tool: "pos.change_quantity", args: { ...cartArgs, productPhrase: "ลาเต้", mode, quantity: mode === "set" ? 5 : mode === "increase" ? 2 : 1 }, idempotencyKey: `q-${mode}` });
    expect(result).toEqual({ ok: true, data: { status: "apply", intent: { type: intentType, productPhrase: "ลาเต้", ...extra }, productName: "ลาเต้" } });
  });

  it("approves remove_item through the shared resolver", async () => {
    const s = setup();
    expect(await s.dispatch({ tool: "pos.remove_item", args: { ...cartArgs, productPhrase: "ลาเต้" }, idempotencyKey: "r1" })).toEqual({
      ok: true,
      data: { status: "apply", intent: { type: "pos.remove_item", productPhrase: "ลาเต้" }, productName: "ลาเต้" },
    });
  });
});

describe("current order tool with server-validated binding", () => {
  it("confirms the bound cart and echoes the validated summary", async () => {
    const s = setup();
    expect(await s.dispatch({ tool: "pos.get_current_order", args: { ...cartArgs, summary: { itemCount: 3, total: 240, locked: false } }, idempotencyKey: "o1" })).toEqual({
      ok: true,
      data: { activeCartId: CART, cartVersion: 3, itemCount: 3, total: 240, locked: false, announcement: "ตะกร้าปัจจุบัน 3 รายการ ยอดรวม 240" },
    });
  });

  it("denies cart tools without a validated binding", async () => {
    const s = setup({ binding: null });
    expect(await s.dispatch({ tool: "pos.get_current_order", args: { ...cartArgs, summary: { itemCount: 0, total: 0, locked: false } }, idempotencyKey: "o2" })).toEqual({ ok: false, code: "CONTEXT_UNAVAILABLE" });
    expect(s.loadCatalog).not.toHaveBeenCalled();
  });
});

describe("policy and idempotency through the real dispatcher", () => {
  it("denies mutations while the production mutation gate stays closed", async () => {
    const production = setup({ environment: "production", mutations: false });
    expect(await production.dispatch({ tool: "pos.add_item", args: addArgs, idempotencyKey: "p1" })).toEqual({ ok: false, code: "DURABLE_STORAGE_REQUIRED" });
    const dev = setup({ mutations: false });
    expect(await dev.dispatch({ tool: "pos.add_item", args: addArgs, idempotencyKey: "p2" })).toEqual({ ok: false, code: "MUTATIONS_DISABLED" });
  });

  it("deduplicates replays without reloading the catalog", async () => {
    const s = setup();
    expect((await s.dispatch({ tool: "pos.add_item", args: addArgs, idempotencyKey: "replay" })).ok).toBe(true);
    expect((await s.dispatch({ tool: "pos.add_item", args: addArgs, idempotencyKey: "replay" })).ok).toBe(true);
    expect(s.loadCatalog).toHaveBeenCalledTimes(1);
  });

  it("isolates replays across users so another user never hits the cached result", async () => {
    const s = setup();
    expect((await s.dispatch({ tool: "pos.add_item", args: addArgs, idempotencyKey: "scope" })).ok).toBe(true);
    s.ctx.userId = "user-2";
    expect((await s.dispatch({ tool: "pos.add_item", args: addArgs, idempotencyKey: "scope" })).ok).toBe(true);
    expect(s.loadCatalog).toHaveBeenCalledTimes(2);
  });

  it("rejects args that smuggle ids from the model", async () => {
    const s = setup();
    expect(await s.dispatch({ tool: "pos.add_item", args: { ...addArgs, productId: "p-latte" }, idempotencyKey: "x1" })).toEqual({ ok: false, code: "INVALID_ARGS" });
    expect(await s.dispatch({ tool: "pos.search_product", args: { query: "ลาเต้", productId: "p-latte" }, idempotencyKey: "x2" })).toEqual({ ok: false, code: "INVALID_ARGS" });
    expect(s.loadCatalog).not.toHaveBeenCalled();
  });

  it("denies tools the session does not allow or the user lacks permission for", async () => {
    const s = setup();
    s.ctx.allowedTools = ["pos.search_product"];
    expect(await s.dispatch({ tool: "pos.add_item", args: addArgs, idempotencyKey: "d1" })).toEqual({ ok: false, code: "PERMISSION_DENIED" });
    s.ctx.allowedTools = [...MVP_TOOL_NAMES];
    s.ctx.can = () => false;
    expect(await s.dispatch({ tool: "pos.search_product", args: { query: "ลาเต้" }, idempotencyKey: "d2" })).toEqual({ ok: false, code: "PERMISSION_DENIED" });
    expect(s.loadCatalog).not.toHaveBeenCalled();
  });
});
