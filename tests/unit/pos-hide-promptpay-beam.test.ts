import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

describe("hide PromptPay QR when Beam is the store's only QR", () => {
  it("only hides PromptPay while Beam is actually usable", () => {
    const service = read("src/modules/payments/beam-service.ts");
    expect(service).toContain("hidePromptPayQr: beamEnabled && Boolean(config?.hidePromptPayQr)");
    const pos = read("src/app/pos/PosTerminal.tsx");
    expect(pos).toContain('...(hidePromptPayQr && beamEnabled ? [] : (["qr_promptpay"] as const)),');
  });

  it("is stored with the Beam config and edited from the Beam card", () => {
    expect(read("src/modules/payments/beam-service.ts")).toContain("hidePromptPayQr: Boolean(input.hidePromptPayQr),");
    expect(read("src/app/(dashboard)/settings/payments/actions.ts")).toContain('hidePromptPayQr: formData.get("hidePromptPayQr") === "1"');
    expect(read("src/app/(dashboard)/settings/payments/BeamIntegrationCard.tsx")).toContain('name="hidePromptPayQr"');
    expect(read("src/app/pos/page.tsx")).toContain("hidePromptPayQr={hidePromptPayQr}");
  });
});
