// @vitest-environment jsdom
// จำลองสถานะจริงของ proud.cafe 2026-10-06: Enterprise หมดอายุ + ข้อเสนอ ฿199 + รายการ Beam ฿199 ค้าง pending ที่ QR หมดเวลาแล้ว
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "../setup/react";
import type { BillingOrderView } from "@/modules/billing/beam-billing-types";
import { BUSINESS_DEFAULT_PRICES } from "@/modules/billing/business-plan";

const m = vi.hoisted(() => ({ create: vi.fn(), refresh: vi.fn(), pending: vi.fn(), routerRefresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: m.routerRefresh }),
  useSearchParams: () => new URLSearchParams("expired=1"),
}));
vi.mock("@/app/(dashboard)/settings/billing/beam-actions", () => ({ createBeamPackageAction: m.create, refreshBeamPackageAction: m.refresh, pendingBeamPackageAction: m.pending }));
vi.mock("@/app/(dashboard)/settings/billing/actions", () => ({ claimFreeTrialAction: vi.fn(), getPaymentQrAction: vi.fn() }));
import { BillingManager } from "@/app/(dashboard)/settings/billing/BillingManager";

const stalePending: BillingOrderView = {
  id: "ed4e5d56", plan: "enterprise", duration: "custom", amount: 199, method: "beam", environment: "live",
  qr_payload: "old-qr", qr_image: null, status: "pending",
  expires_at: new Date(Date.now() - 86_400_000).toISOString(), new_expiry: null,
};
const base = {
  orgName: "proud.cafe", plan: "enterprise" as const, currentPeriodEnd: "2026-10-04T17:00:00.000Z", isActive: false,
  prices: { starter: { "30d": 99, "1y": 990 }, standard: { "30d": 299, "1y": 2990 }, premium: { "30d": 599, "1y": 5990 } },
  businessPrices: BUSINESS_DEFAULT_PRICES, canManage: true, paymentConfigured: true, recipientName: null,
  slipVerificationReady: true, freeTrialAvailable: false, expires: true, beamEnabled: true,
  enterpriseOffer: { amount: 199, summary: "จ่าย ฿199 · ต่ออีก 30 วัน", note: null },
};
beforeEach(() => { vi.clearAllMocks(); m.refresh.mockResolvedValue(stalePending); });

describe("ไดอาล็อกต่ออายุเปิดเองเมื่อหมดอายุ", () => {
  it("ไม่มีรายการค้าง", () => {
    render(<BillingManager {...base} beamOrder={null} />);
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
  it("มีรายการ enterprise ค้าง pending ที่ QR หมดเวลาแล้ว (สถานะ proud.cafe)", () => {
    render(<BillingManager {...base} beamOrder={stalePending} />);
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
  it("แตะพื้นหลังไม่ปิดไดอาล็อก (กันปิดพลาดตอนเลื่อนจอมือถือ)", () => {
    const { container } = render(<BillingManager {...base} beamOrder={null} />);
    const backdrop = container.ownerDocument.querySelector('[role="dialog"] > [aria-hidden="true"]');
    fireEvent.click(backdrop!);
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
  it("ปิดไดอาล็อกแล้วมีปุ่มต่ออายุพร้อมราคาให้เปิดกลับ และไม่โชว์การ์ดขอใช้งาน Enterprise", () => {
    render(<BillingManager {...base} beamOrder={null} />);
    fireEvent.click(screen.getByRole("button", { name: "ปิด dialog" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText("คำขอใช้งาน Enterprise")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "ต่ออายุ Enterprise 199 บาท" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});
