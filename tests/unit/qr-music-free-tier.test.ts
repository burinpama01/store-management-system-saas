import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");

describe("music zero-price tier = free (store's choice)", () => {
  it("repository verifies a 0-amount donation at creation (no slip step)", () => {
    const repo = read("src/modules/music-requests/repository.ts");
    expect(repo).toContain("const isFree = input.donationAmount <= 0");
    expect(repo).toContain('donation_status: isFree ? "verified" : "pending"');
    expect(repo).toContain('...(isFree ? { status: "approved", decided_at: now } : {})');
  });

  it("donation action skips PromptPay entirely on the free path", () => {
    const action = read("src/app/qr/[storeSlug]/[tableId]/music-actions.ts");
    expect(action).toContain("const isFree = amount <= 0");
    // PromptPay config is only required for paid donations.
    expect(action).toContain("if (!isFree) {");
    expect(action).toContain("free: true");
  });

  it("customer buttons submit directly (no pay panel) when a tier is priced 0", () => {
    const tab = read("src/app/qr/[storeSlug]/[tableId]/MusicTab.tsx");
    expect(tab).toContain('startDonation("now", 0)');
    expect(tab).toContain('startDonation("queue", 0)');
    expect(tab).toContain("res.free && res.requestId");
  });
});
