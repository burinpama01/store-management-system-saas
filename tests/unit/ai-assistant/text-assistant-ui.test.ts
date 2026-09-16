import { describe, expect, it } from "vitest";
import {
  MUTATION_CLOSED_CODES,
  TEXT_COMMAND_MAX_LENGTH,
  cartFingerprint,
  createAssistantCartId,
  createAssistantRequestId,
  describeClarification,
  describeDenialCode,
  describeFailureReason,
  parseAssistantToolResult,
  planAssistantTurn,
  type ParsedAssistantToolResult,
} from "@/modules/ai-assistant/ui/text-assistant-ui";
import type { Cart } from "@/modules/pos/types";

// PR2 — ส่วน pure ของ overlay ข้อความ: parse ผลจาก route ต้อง fail closed เสมอ
// (รูปทรงไม่รู้จัก = ข้อความ "ใช้หน้าจอแทน" ไม่ใช่การเดา) และ id ที่สร้างต้องตรง schema ของ route

const CART: Cart = { storeId: "store", items: [], subtotal: 0, discount: 0, total: 0 };

describe("parseAssistantToolResult", () => {
  it("parses an approved apply instruction", () => {
    const parsed = parseAssistantToolResult({
      status: "apply",
      intent: { type: "pos.add_item", productPhrase: "ลาเต้", quantity: 2 },
      productName: "ลาเต้",
    });
    expect(parsed).toEqual({
      kind: "apply",
      intent: { type: "pos.add_item", productPhrase: "ลาเต้", quantity: 2 },
      productName: "ลาเต้",
    });
  });

  it("rejects an apply without a usable intent", () => {
    expect(parseAssistantToolResult({ status: "apply", productName: "ลาเต้" })).toBeNull();
    expect(parseAssistantToolResult({ status: "apply", intent: { quantity: 2 }, productName: "ลาเต้" })).toBeNull();
  });

  it("parses clarification with candidates and drops malformed ones", () => {
    const parsed = parseAssistantToolResult({
      status: "clarification",
      reason: "ambiguous",
      candidates: [
        { id: "p-latte", name: "ลาเต้" },
        { id: "", name: "ไม่มีไอดี" },
        { id: "p-no-name" },
        "ขยะ",
      ],
    }) as Extract<ParsedAssistantToolResult, { kind: "clarification" }>;
    expect(parsed?.reason).toBe("ambiguous");
    expect(parsed?.candidates).toEqual([{ id: "p-latte", name: "ลาเต้" }]);
  });

  it("parses search and order results", () => {
    expect(parseAssistantToolResult({ status: "matched", product: { id: "p", name: "ลาเต้" }, price: 55, outOfStock: false, note: null }))
      .toMatchObject({ kind: "matched", productName: "ลาเต้", price: 55 });
    expect(parseAssistantToolResult({ status: "ambiguous", candidates: [{ id: "a", name: "A" }] }))
      .toMatchObject({ kind: "ambiguous", candidates: [{ id: "a", name: "A" }] });
    expect(parseAssistantToolResult({ status: "not_found", note: "ไม่พบสินค้าที่ค้นหา" }))
      .toMatchObject({ kind: "not_found" });
    expect(
      parseAssistantToolResult({
        activeCartId: "cart-12345678",
        cartVersion: 2,
        itemCount: 2,
        total: 110,
        locked: false,
        announcement: "ตะกร้าปัจจุบัน 2 รายการ ยอดรวม 110",
      }),
    ).toMatchObject({ kind: "current_order", itemCount: 2, total: 110 });
  });

  it("returns null for unknown shapes (fail closed)", () => {
    expect(parseAssistantToolResult(null)).toBeNull();
    expect(parseAssistantToolResult("ข้อความ")).toBeNull();
    expect(parseAssistantToolResult({ status: "mysterious" })).toBeNull();
    expect(parseAssistantToolResult({})).toBeNull();
  });
});

describe("denial and failure messages", () => {
  it("explains that cart writes are still locked in this phase", () => {
    expect(MUTATION_CLOSED_CODES.has("MUTATIONS_DISABLED")).toBe(true);
    expect(MUTATION_CLOSED_CODES.has("DURABLE_STORAGE_REQUIRED")).toBe(true);
    for (const code of MUTATION_CLOSED_CODES) {
      expect(describeDenialCode(code)).toContain("ยังปิด");
    }
  });

  it("maps known denial codes and falls back for unknown ones", () => {
    expect(describeDenialCode("RATE_LIMITED")).toContain("ถี่เกินไป");
    expect(describeDenialCode("PERMISSION_DENIED")).toContain("สิทธิ์");
    expect(describeDenialCode("CONTEXT_UNAVAILABLE")).toContain("ผูกตะกร้า");
    expect(describeDenialCode("SOMETHING_NEW")).toContain("หน้าจอ");
  });

  it("prefers the server note for route failures and maps the rest", () => {
    expect(describeFailureReason("ai_timeout", "แปลคำสั่งไม่ทัน — ลองพิมพ์ใหม่อีกครั้ง")).toBe(
      "แปลคำสั่งไม่ทัน — ลองพิมพ์ใหม่อีกครั้ง",
    );
    expect(describeFailureReason("rate_limited")).toContain("ถี่เกินไป");
    expect(describeFailureReason("assistant_disabled")).toContain("ปิดใช้งาน");
    expect(describeFailureReason("ai_not_in_plan")).toContain("แพ็กเกจ");
    expect(describeFailureReason("network_error")).toContain("เซิร์ฟเวอร์");
    expect(describeFailureReason("brand_new_reason")).toContain("หน้าจอ");
  });
});

describe("ids and fingerprint", () => {
  it("creates ids that match the route body schema", () => {
    const cartId = createAssistantCartId();
    const requestId = createAssistantRequestId(7);
    expect(cartId).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
    expect(requestId).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  });

  it("creates distinct request ids per sequence", () => {
    expect(createAssistantRequestId(1)).not.toBe(createAssistantRequestId(2));
  });

  it("fingerprints the cart so any change is detectable", () => {
    expect(cartFingerprint(CART)).toBe(cartFingerprint(CART));
    const edited: Cart = { ...CART, total: 999 };
    expect(cartFingerprint(edited)).not.toBe(cartFingerprint(CART));
  });

  it("keeps the text length cap in sync with the route limit", () => {
    expect(TEXT_COMMAND_MAX_LENGTH).toBe(500);
  });
});

describe("clarification wording", () => {
  it("asks for a quantity without guessing one", () => {
    const parsed = parseAssistantToolResult({ status: "clarification", reason: "needs_quantity", productName: "ลาเต้" });
    expect(parsed && parsed.kind === "clarification" ? describeClarification(parsed) : "").toContain("ลาเต้");
    expect(parsed && parsed.kind === "clarification" ? describeClarification(parsed) : "").toContain("จำนวน");
  });
});

describe("planAssistantTurn", () => {
  it("keeps the original command order and maps each kind", () => {
    const steps = planAssistantTurn([
      {
        kind: "tool",
        ok: true,
        tool: "pos.add_item",
        result: { status: "apply", intent: { type: "pos.add_item", productPhrase: "ลาเต้", quantity: 2 }, productName: "ลาเต้" },
      },
      { kind: "error", ok: false, code: "MUTATIONS_DISABLED" },
      { kind: "client_action", ok: true, action: "clear_search", note: "ล้างช่องค้นหาบนหน้าขายแล้ว" },
    ]);
    expect(steps).toHaveLength(3);
    expect(steps[0]).toMatchObject({ kind: "apply", productName: "ลาเต้" });
    expect(steps[1]).toMatchObject({ kind: "message", level: "error" });
    if (steps[1].kind === "message") expect(steps[1].message).toContain("ยังปิด");
    expect(steps[2]).toMatchObject({ kind: "clear_search", note: "ล้างช่องค้นหาบนหน้าขายแล้ว" });
  });

  it("turns needs_option with a product id into message + open dialog step", () => {
    const steps = planAssistantTurn([
      {
        kind: "tool",
        ok: true,
        result: {
          status: "clarification",
          reason: "needs_option",
          productId: "p-black",
          productName: "กาแฟดำ",
          note: "ยังต้องเลือกตัวเลือกสินค้า",
        },
      },
    ]);
    expect(steps).toHaveLength(2);
    expect(steps[0]).toMatchObject({ kind: "message", level: "error" });
    expect(steps[1]).toEqual({ kind: "open_product", productId: "p-black" });
  });

  it("turns ambiguous clarification into a message with candidate chips", () => {
    const steps = planAssistantTurn([
      {
        kind: "tool",
        ok: true,
        result: { status: "clarification", reason: "ambiguous", candidates: [{ id: "p-latte", name: "ลาเต้" }] },
      },
    ]);
    expect(steps).toHaveLength(1);
    if (steps[0].kind === "message") {
      expect(steps[0].candidates).toEqual([{ id: "p-latte", name: "ลาเต้" }]);
    } else {
      expect.unreachable("expected a message step");
    }
  });

  it("describes search matches with price and stock state", () => {
    const matched = planAssistantTurn([
      { kind: "tool", ok: true, result: { status: "matched", product: { id: "p", name: "ลาเต้" }, price: 55, outOfStock: false, note: null } },
    ]);
    if (matched[0].kind === "message") {
      expect(matched[0].level).toBe("assistant");
      expect(matched[0].message).toContain("ลาเต้");
      expect(matched[0].message).toContain("55");
    } else {
      expect.unreachable("expected a message step");
    }

    const outOfStock = planAssistantTurn([
      { kind: "tool", ok: true, result: { status: "matched", product: { id: "p", name: "โกโก้" }, price: 60, outOfStock: true, note: "สินค้านี้ของหมดอยู่ในขณะนี้" } },
    ]);
    if (outOfStock[0].kind === "message") {
      expect(outOfStock[0].level).toBe("error");
      expect(outOfStock[0].message).toContain("ของหมด");
    } else {
      expect.unreachable("expected a message step");
    }
  });

  it("maps the current order echo and skipped commands", () => {
    const steps = planAssistantTurn([
      {
        kind: "tool",
        ok: true,
        result: { activeCartId: "cart-12345678", cartVersion: 2, itemCount: 2, total: 110, locked: false, announcement: "ตะกร้าปัจจุบัน 2 รายการ ยอดรวม 110" },
      },
      { kind: "skipped", ok: false, note: "คำสั่งนี้ยังไม่รองรับในโหมดข้อความ" },
    ]);
    expect(steps).toHaveLength(2);
    if (steps[0].kind === "message") expect(steps[0].message).toContain("2 รายการ");
    if (steps[1].kind === "message") expect(steps[1].level).toBe("error");
  });

  it("falls back to a fail-closed message for unknown outcomes and results", () => {
    const steps = planAssistantTurn([{ kind: "mystery" }, { kind: "tool", ok: true, result: { status: "mysterious" } }, "ขยะ"]);
    expect(steps).toHaveLength(3);
    for (const step of steps) {
      expect(step.kind).toBe("message");
      if (step.kind === "message") expect(step.level).toBe("error");
    }
  });

  it("prefers the outcome note when the result is unparseable", () => {
    const steps = planAssistantTurn([{ kind: "tool", ok: true, result: { status: "mysterious" }, note: "อธิบายจาก server" }]);
    if (steps[0].kind === "message") expect(steps[0].message).toBe("อธิบายจาก server");
  });
});
