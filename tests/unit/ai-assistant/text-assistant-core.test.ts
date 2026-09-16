import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTextAssistantCore,
  type AssistantCartBridge,
  type TextCommandRequestBody,
  type TextCommandResponse,
} from "@/modules/ai-assistant/ui/text-assistant-core";
import type { Cart } from "@/modules/pos/types";
import type { Product } from "@/modules/catalog/types";
import type { VoiceProductAlias } from "@/modules/voice-pos/cart";

// PR2 — UI logic ระดับ module: bridge mock + applyVoiceCartIntent ตัวจริงของ Voice POS
// จุดที่ต้องพิสูจน์: fail closed เมื่อ bridge null, undo ปฏิเสธเมื่อตะกร้าถูกแก้ระหว่างทาง,
// และ follow-up ของ clarification เดินทางเดียวกับคำสั่งแรก (requestId ใหม่ + version ไต่ขึ้น)

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

const defaultProducts: readonly Product[] = [
  product({ id: "p-latte", name: "ลาเต้", basePrice: 55 }),
  product({ id: "p-greentea", name: "ชาเขียว", basePrice: 40 }),
  product({ id: "p-thaitea", name: "ชาไทย", basePrice: 45 }),
];

const EMPTY_CART: Cart = { storeId: "store", items: [], subtotal: 0, discount: 0, total: 0 };

function createBridge(options: { products?: readonly Product[]; aliases?: readonly VoiceProductAlias[] } = {}) {
  let cart: Cart = EMPTY_CART;
  let locked = false;
  const commits: Cart[] = [];
  const clearSearch = vi.fn();
  const openProduct = vi.fn(() => true);
  const api: AssistantCartBridge = {
    getSnapshot: () => ({ cart, products: options.products ?? defaultProducts, locked }),
    commit: (next) => {
      commits.push(next);
      cart = next;
    },
    clearSearch,
    openProduct,
  };
  return {
    api,
    commits,
    clearSearch,
    openProduct,
    get cart() {
      return cart;
    },
    setCart: (next: Cart) => {
      cart = next;
    },
    setLocked: (value: boolean) => {
      locked = value;
    },
  };
}

function createCore(options: {
  bridge: AssistantCartBridge | null;
  respond?: (body: TextCommandRequestBody) => Promise<TextCommandResponse> | TextCommandResponse;
  aliases?: readonly VoiceProductAlias[];
  cartId?: string;
  initialCartVersion?: number;
  now?: { value: number };
}) {
  const now = options.now ?? { value: 1_000_000 };
  const onFocusSell = vi.fn();
  const sendCommand = vi.fn(async (body: TextCommandRequestBody) =>
    options.respond ? await options.respond(body) : { ok: true as const, outcomes: [] },
  );
  const core = createTextAssistantCore({
    cartId: options.cartId,
    initialCartVersion: options.initialCartVersion,
    getCartApi: () => options.bridge,
    sendCommand,
    getProductAliases: () => options.aliases ?? [],
    onFocusSell,
    clock: () => now.value,
  });
  return { core, sendCommand, onFocusSell, now };
}

const applyOutcome = (intent: Record<string, unknown>, productName: string) => ({
  kind: "tool",
  ok: true,
  tool: "pos.add_item",
  result: { status: "apply", intent, productName },
});

const addIntent = (phrase: string, quantity: number) => ({ type: "pos.add_item", productPhrase: phrase, quantity });

beforeEach(() => vi.clearAllMocks());

describe("fail closed", () => {
  it("does not send anything when the POS bridge is unavailable", async () => {
    const { core, sendCommand } = createCore({ bridge: null });
    await core.send("เพิ่มลาเต้ 2 แก้ว");
    expect(sendCommand).not.toHaveBeenCalled();
    const entries = core.getState().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0].level).toBe("error");
    expect(entries[0].message).toContain("ยังไม่พร้อม");
  });

  it("ignores empty input and keeps the terminal cart id route-compatible", async () => {
    const bridge = createBridge();
    const { core, sendCommand } = createCore({ bridge: bridge.api });
    await core.send("   ");
    expect(sendCommand).not.toHaveBeenCalled();
    expect(core.cartId).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
    expect(core.getState().entries).toHaveLength(0);
  });

  it("reuses a supplied cart id so remounts keep the server binding (M4 review)", async () => {
    const bridge = createBridge();
    const { core, sendCommand } = createCore({ bridge: bridge.api, cartId: "cart-stored-12345678" });
    await core.send("เพิ่มลาเต้ 2 แก้ว");
    expect(sendCommand.mock.calls[0][0].activeCartId).toBe("cart-stored-12345678");
  });

  it("resumes from the stored cart version so reloads never send a lower one (M4 review)", async () => {
    const bridge = createBridge();
    // reload หลังใช้สำเร็จ 2 ครั้ง: server คง lastCartVersion=2 — core ใหม่ต้องเริ่มที่ 2 ไม่ใช่ 0
    const { core, sendCommand } = createCore({
      bridge: bridge.api,
      cartId: "cart-stored-12345678",
      initialCartVersion: 2,
      respond: () => ({ ok: true, outcomes: [applyOutcome(addIntent("ลาเต้", 2), "ลาเต้")] }),
    });
    expect(core.getState().cartVersion).toBe(2);
    await core.send("เพิ่มลาเต้ 2 แก้ว");
    expect(sendCommand.mock.calls[0][0].cartVersion).toBe(2);
    expect(core.getState().cartVersion).toBe(3); // apply สำเร็จแล้วไต่ขึ้น — ผู้เรียกจดกลับ storage ต่อ
  });

  it("falls back to a fresh id and version 0 when the stored ones are malformed", async () => {
    const bridge = createBridge();
    const { core, sendCommand } = createCore({ bridge: bridge.api, cartId: "bad id!!", initialCartVersion: -5 });
    await core.send("เพิ่มลาเต้");
    expect(core.cartId).not.toBe("bad id!!");
    expect(core.cartId).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
    expect(sendCommand.mock.calls[0][0].activeCartId).toBe(core.cartId);
    expect(sendCommand.mock.calls[0][0].cartVersion).toBe(0);
  });

  it("reports a network failure as a retryable message", async () => {
    const bridge = createBridge();
    const { core } = createCore({
      bridge: bridge.api,
      respond: async () => {
        throw new Error("boom");
      },
    });
    await core.send("เพิ่มลาเต้");
    expect(core.getState().entries.at(-1)?.level).toBe("error");
    expect(core.getState().entries.at(-1)?.message).toContain("เซิร์ฟเวอร์");
    expect(core.getState().busy).toBe(false);
  });
});

describe("approved commands reach the cart through the bridge", () => {
  it("applies the approved intent and creates an undo token", async () => {
    const bridge = createBridge();
    const { core, sendCommand, onFocusSell } = createCore({
      bridge: bridge.api,
      respond: () => ({ ok: true, outcomes: [applyOutcome(addIntent("ลาเต้", 2), "ลาเต้")] }),
    });
    await core.send("เพิ่มลาเต้ 2 แก้ว");

    expect(bridge.commits).toHaveLength(1);
    expect(bridge.cart.items).toHaveLength(1);
    expect(bridge.cart.items[0]).toMatchObject({ productId: "p-latte", quantity: 2 });
    expect(onFocusSell).toHaveBeenCalledTimes(1);

    const body = sendCommand.mock.calls[0][0];
    expect(body.activeCartId).toBe(core.cartId);
    expect(body.cartVersion).toBe(0);

    const entries = core.getState().entries;
    expect(entries.at(-1)?.level).toBe("assistant");
    expect(entries.at(-1)?.message).toContain("เพิ่ม ลาเต้ 2 รายการแล้ว");

    const undo = core.getState().undo;
    expect(undo).not.toBeNull();
    expect(undo?.label).toContain("ลาเต้");
  });

  it("sends a newer cartVersion on the follow-up command", async () => {
    const bridge = createBridge();
    let call = 0;
    const { core, sendCommand } = createCore({
      bridge: bridge.api,
      respond: () => {
        call += 1;
        return call === 1
          ? { ok: true, outcomes: [applyOutcome(addIntent("ลาเต้", 2), "ลาเต้")] }
          : { ok: true, outcomes: [{ kind: "tool", ok: true, result: { status: "clarification", reason: "needs_quantity", productName: "ชาเขียว" } }] };
      },
    });
    await core.send("เพิ่มลาเต้ 2 แก้ว");
    await core.send("เพิ่มชาเขียว");
    expect(sendCommand).toHaveBeenCalledTimes(2);
    const first = sendCommand.mock.calls[0][0];
    const second = sendCommand.mock.calls[1][0];
    expect(second.requestId).not.toBe(first.requestId);
    expect(second.cartVersion).toBe(first.cartVersion + 1);
  });

  it("chains several approved commands of one message onto each other", async () => {
    const bridge = createBridge();
    const { core } = createCore({
      bridge: bridge.api,
      respond: () => ({
        ok: true,
        outcomes: [applyOutcome(addIntent("ลาเต้", 2), "ลาเต้"), applyOutcome(addIntent("ชาเขียว", 1), "ชาเขียว")],
      }),
    });
    await core.send("เพิ่มลาเต้ 2 แก้วกับชาเขียวหนึ่งแก้ว");
    expect(bridge.commits).toHaveLength(2);
    expect(bridge.cart.items).toHaveLength(2);

    // undo ของคำสั่งเดียวครอบทั้งคำสั่ง — ย้อนกลับแล้วตะกร้าต้องว่างเหมือนก่อนพิมพ์
    core.undo();
    expect(bridge.commits).toHaveLength(3);
    expect(bridge.cart.items).toHaveLength(0);
    expect(core.getState().undo).toBeNull();
    expect(core.getState().entries.at(-1)?.message).toContain("ย้อนกลับแล้ว");
  });

  it("shows the resolver's blocked message without touching the cart when locked", async () => {
    const bridge = createBridge();
    bridge.setLocked(true);
    const { core } = createCore({
      bridge: bridge.api,
      respond: () => ({ ok: true, outcomes: [applyOutcome(addIntent("ลาเต้", 2), "ลาเต้")] }),
    });
    await core.send("เพิ่มลาเต้ 2 แก้ว");
    expect(bridge.commits).toHaveLength(0);
    expect(core.getState().undo).toBeNull();
    expect(core.getState().entries.at(-1)?.level).toBe("error");
    expect(core.getState().entries.at(-1)?.message).toContain("สร้างออร์เดอร์แล้ว");
  });
});

describe("undo 6 seconds", () => {
  it("restores the previous cart when the cart is untouched", async () => {
    const bridge = createBridge();
    const { core, now } = createCore({
      bridge: bridge.api,
      respond: () => ({ ok: true, outcomes: [applyOutcome(addIntent("ลาเต้", 2), "ลาเต้")] }),
    });
    await core.send("เพิ่มลาเต้ 2 แก้ว");
    now.value += 5_000;
    core.undo();
    expect(bridge.commits).toHaveLength(2);
    expect(bridge.cart.items).toHaveLength(0);
    expect(core.getState().undo).toBeNull();
  });

  it("rejects undo when the cart was edited by hand after the change", async () => {
    const bridge = createBridge();
    const { core } = createCore({
      bridge: bridge.api,
      respond: () => ({ ok: true, outcomes: [applyOutcome(addIntent("ลาเต้", 2), "ลาเต้")] }),
    });
    await core.send("เพิ่มลาเต้ 2 แก้ว");
    // จำลองการแก้ด้วยมือบนหน้าขายระหว่างที่ undo ยังเปิดอยู่
    bridge.setCart({
      ...bridge.cart,
      items: [...bridge.cart.items, { ...bridge.cart.items[0], key: "manual-line", quantity: 99 }],
    });
    core.undo();
    expect(bridge.commits).toHaveLength(1); // ไม่มี commit ใหม่ = ไม่ทับการแก้ด้วยมือ
    expect(core.getState().undo).toBeNull();
    expect(core.getState().entries.at(-1)?.level).toBe("error");
    expect(core.getState().entries.at(-1)?.message).toContain("ถูกแก้ไปแล้ว");
  });

  it("expires undo after the 6 second window", async () => {
    const bridge = createBridge();
    const { core, now } = createCore({
      bridge: bridge.api,
      respond: () => ({ ok: true, outcomes: [applyOutcome(addIntent("ลาเต้", 2), "ลาเต้")] }),
    });
    await core.send("เพิ่มลาเต้ 2 แก้ว");
    now.value += 6_001;
    core.undo();
    expect(bridge.commits).toHaveLength(1);
    expect(core.getState().entries.at(-1)?.message).toContain("หมดเวลา");
  });

  it("does not restore anything when the bridge disappears before undo", () => {
    const bridge = createBridge();
    const { core } = createCore({ bridge: bridge.api });
    // ไม่มี token = เงียบ (ปุ่ม undo ไม่ควรแสดงอยู่แล้ว)
    core.undo();
    expect(bridge.commits).toHaveLength(0);
  });
});

describe("clarification follow-up", () => {
  it("shows resolver candidates and forwards the follow-up as a normal command", async () => {
    const bridge = createBridge();
    const { core, sendCommand } = createCore({
      bridge: bridge.api,
      respond: () => ({
        ok: true,
        outcomes: [
          {
            kind: "tool",
            ok: true,
            result: {
              status: "clarification",
              reason: "ambiguous",
              candidates: [
                { id: "p-latte", name: "ลาเต้" },
                { id: "p-thaitea", name: "ชาไทย" },
              ],
            },
          },
        ],
      }),
    });
    await core.send("ลาเต");
    const entries = core.getState().entries;
    expect(entries.at(-1)?.level).toBe("error");
    expect(entries.at(-1)?.candidates).toEqual([
      { id: "p-latte", name: "ลาเต้" },
      { id: "p-thaitea", name: "ชาไทย" },
    ]);

    // follow-up = คำสั่งข้อความปกติ (server เก็บบริบทตะกร้าไว้เองตาม contract ของ M2)
    await core.send("ลาเต้");
    expect(sendCommand).toHaveBeenCalledTimes(2);
    expect(sendCommand.mock.calls[1][0].text).toBe("ลาเต้");
  });

  it("opens the product dialog for needs_option clarifications", async () => {
    const bridge = createBridge();
    const { core, onFocusSell } = createCore({
      bridge: bridge.api,
      respond: () => ({
        ok: true,
        outcomes: [
          {
            kind: "tool",
            ok: true,
            result: { status: "clarification", reason: "needs_option", productId: "p-black", productName: "กาแฟดำ", note: "ยังต้องเลือกตัวเลือกสินค้า" },
          },
        ],
      }),
    });
    await core.send("กาแฟดำ");
    expect(bridge.openProduct).toHaveBeenCalledWith("p-black");
    expect(onFocusSell).toHaveBeenCalledTimes(1);
    expect(core.getState().entries.at(-1)?.message).toContain("กาแฟดำ");
  });
});

describe("denials and client actions", () => {
  it("shows the mutation gate reason as-is when writes are locked", async () => {
    const bridge = createBridge();
    const { core } = createCore({
      bridge: bridge.api,
      respond: () => ({ ok: true, outcomes: [{ kind: "error", ok: false, code: "MUTATIONS_DISABLED" }] }),
    });
    await core.send("เพิ่มลาเต้ 2 แก้ว");
    expect(core.getState().entries.at(-1)?.level).toBe("error");
    expect(core.getState().entries.at(-1)?.message).toContain("ยังปิด");
    expect(bridge.commits).toHaveLength(0);
  });

  it("performs clear_search through the bridge when available", async () => {
    const bridge = createBridge();
    const { core } = createCore({
      bridge: bridge.api,
      respond: () => ({ ok: true, outcomes: [{ kind: "client_action", ok: true, action: "clear_search", note: "ล้างช่องค้นหาบนหน้าขายแล้ว" }] }),
    });
    await core.send("ล้างช่องค้นหา");
    expect(bridge.clearSearch).toHaveBeenCalledTimes(1);
    expect(core.getState().entries.at(-1)?.message).toContain("ล้างช่องค้นหา");
  });

  it("surfaces route-level rate limiting as its own message", async () => {
    const bridge = createBridge();
    const { core } = createCore({ bridge: bridge.api, respond: () => ({ ok: false, reason: "rate_limited" }) });
    await core.send("เพิ่มลาเต้");
    expect(core.getState().entries.at(-1)?.message).toContain("ถี่เกินไป");
  });

  it("prefers the server note for content failures", async () => {
    const bridge = createBridge();
    const { core } = createCore({
      bridge: bridge.api,
      respond: () => ({ ok: true, outcomes: [], failure: "ai_timeout", note: "แปลคำสั่งไม่ทัน — ลองพิมพ์ใหม่อีกครั้ง" }),
    });
    await core.send("ทำอะไรได้บ้าง");
    expect(core.getState().entries.at(-1)?.message).toBe("แปลคำสั่งไม่ทัน — ลองพิมพ์ใหม่อีกครั้ง");
  });

  it("keeps an empty deterministic response honest", async () => {
    const bridge = createBridge();
    const { core } = createCore({ bridge: bridge.api, respond: () => ({ ok: true, outcomes: [] }) });
    await core.send("สวัสดี");
    expect(core.getState().entries.at(-1)?.message).toContain("ไม่มีคำสั่งที่ทำได้");
  });
});

describe("send pacing", () => {
  it("ignores sends while a command is in flight", async () => {
    const bridge = createBridge();
    let release!: (value: TextCommandResponse) => void;
    const gate = new Promise<TextCommandResponse>((resolve) => {
      release = resolve;
    });
    const sendCommand = vi.fn(() => gate);
    const core = createTextAssistantCore({
      getCartApi: () => bridge.api,
      sendCommand,
      clock: () => 1_000_000,
    });
    const first = core.send("เพิ่มลาเต้ 2 แก้ว");
    expect(core.getState().busy).toBe(true);
    void core.send("ชาเขียว");
    expect(sendCommand).toHaveBeenCalledTimes(1);
    release({ ok: true, outcomes: [] });
    await first;
    expect(core.getState().busy).toBe(false);
  });
});
