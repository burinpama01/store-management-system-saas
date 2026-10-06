import { describe, expect, it } from "vitest";
import { posPaymentLabel } from "@/modules/pos/payment-label";

describe("POS payment labels", () => {
  it("identifies settled Beam and TrueMoney references without relabeling cash", () => {
    expect(posPaymentLabel({ method: "other", reference: "BEAM:payment-id" })).toBe("Beam QR");
    expect(posPaymentLabel({ method: "other", reference: "TM:payment-id" })).toBe("TrueMoney");
    expect(posPaymentLabel({ method: "cash", reference: "BEAM:payment-id" })).toBe("เงินสด");
  });
  it("preserves unknown other payments and ordinary PromptPay labels", () => {
    expect(posPaymentLabel({ method: "other", reference: "BEAM:" })).toBe("other");
    expect(posPaymentLabel({ method: "other" })).toBe("other");
    expect(posPaymentLabel({ method: "qr_promptpay" })).toBe("QR พร้อมเพย์");
  });
});
