import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RECEIPT_MESSAGE_MAX_LENGTH } from "@/modules/settings/receipt-limits";

const STORE_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";

const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn(),
  getCurrentUser: vi.fn(),
  getUserStores: vi.fn(),
  resolveCurrentStore: vi.fn(),
  upsertReceiptSettings: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: mocks.revalidatePath,
}));

vi.mock("@/modules/auth/guards", () => ({
  requirePermission: mocks.requirePermission,
}));

vi.mock("@/modules/auth/session", () => ({
  getCurrentUser: mocks.getCurrentUser,
  getUserStores: mocks.getUserStores,
  resolveCurrentStore: mocks.resolveCurrentStore,
}));

vi.mock("@/modules/settings/repository", () => ({
  upsertReceiptSettings: mocks.upsertReceiptSettings,
}));

function fd(values: Record<string, string>) {
  const formData = new FormData();
  for (const [key, value] of Object.entries(values)) formData.set(key, value);
  return formData;
}

describe("receipt settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requirePermission.mockResolvedValue(undefined);
    mocks.getCurrentUser.mockResolvedValue({ id: "user-1", email: "owner@example.com" });
    mocks.getUserStores.mockResolvedValue({ organizations: [], stores: [], memberships: [] });
    mocks.resolveCurrentStore.mockResolvedValue({
      storeId: STORE_ID,
      organizationId: ORG_ID,
      storeName: "Long Copy Cafe",
    });
    mocks.upsertReceiptSettings.mockResolvedValue({ ok: true, error: null });
  });

  it("accepts long receipt header and footer copy", async () => {
    const { upsertReceiptSettingsAction } = await import("@/app/(dashboard)/settings/receipt/actions");
    const headerText = "H".repeat(1000);
    const footerText = "F".repeat(1000);

    const result = await upsertReceiptSettingsAction(
      { error: null },
      fd({
        storeName: "Long Copy Cafe",
        headerText,
        footerText,
        paperWidth: "80mm",
        printCopies: "1",
      }),
    );

    expect(result.error).toBeNull();
    expect(mocks.upsertReceiptSettings).toHaveBeenCalledWith(
      STORE_ID,
      ORG_ID,
      expect.objectContaining({ headerText, footerText }),
    );
  });

  it("rejects receipt header or footer copy above the shared limit", async () => {
    const { upsertReceiptSettingsAction } = await import("@/app/(dashboard)/settings/receipt/actions");

    const result = await upsertReceiptSettingsAction(
      { error: null },
      fd({
        storeName: "Long Copy Cafe",
        headerText: "H".repeat(RECEIPT_MESSAGE_MAX_LENGTH + 1),
        footerText: "F".repeat(RECEIPT_MESSAGE_MAX_LENGTH),
        paperWidth: "80mm",
        printCopies: "1",
      }),
    );

    expect(result.error).toContain(`${RECEIPT_MESSAGE_MAX_LENGTH}`);
    expect(mocks.upsertReceiptSettings).not.toHaveBeenCalled();
  });

  it("requires a PromptPay ID when QR payment is enabled", async () => {
    const { upsertReceiptSettingsAction } = await import("@/app/(dashboard)/settings/receipt/actions");

    const result = await upsertReceiptSettingsAction(
      { error: null },
      fd({
        storeName: "Long Copy Cafe",
        showQrPayment: "1",
        paperWidth: "80mm",
        printCopies: "1",
      }),
    );

    expect(result.error).toContain("PromptPay");
    expect(mocks.upsertReceiptSettings).not.toHaveBeenCalled();
  });

  it("uses the shared expanded receipt copy limit in the form", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "src/app/(dashboard)/settings/receipt/ReceiptSettingsForm.tsx"),
      "utf8",
    );
    const sharedMaxLengthUses = source.match(/maxLength=\{RECEIPT_MESSAGE_MAX_LENGTH\}/g) ?? [];

    expect(source).toContain("RECEIPT_MESSAGE_MAX_LENGTH");
    expect(sharedMaxLengthUses).toHaveLength(2);
    expect(source).not.toContain("maxLength={200}");
  });

  it("keeps the PromptPay input visible while the checkbox controls receipt QR display", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "src/app/(dashboard)/settings/receipt/ReceiptSettingsForm.tsx"),
      "utf8",
    );

    expect(source).toContain("checked={showQrPayment}");
    expect(source).toContain('name="promptpayId"');
    expect(source).not.toContain("{showQrPayment && (");
  });
});
