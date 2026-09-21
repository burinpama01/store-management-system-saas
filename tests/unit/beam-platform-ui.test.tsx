// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "../setup/react";
import type { BillingOrderView } from "@/modules/billing/beam-billing-types";

const m = vi.hoisted(() => ({ create: vi.fn(), refresh: vi.fn(), pending: vi.fn(), routerRefresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: m.routerRefresh }) }));
vi.mock("@/shared/components/ui", () => ({ QrCode: ({ value }: { value: string }) => <div aria-label="QR">{value}</div> }));
vi.mock("@/app/(dashboard)/settings/billing/beam-actions", () => ({ createBeamPackageAction: m.create, refreshBeamPackageAction: m.refresh, pendingBeamPackageAction: m.pending }));
import { BeamPackagePayment } from "@/app/(dashboard)/settings/billing/BeamPackagePayment";

const order: BillingOrderView = { id: "order-1", plan: "starter", duration: "30d", amount: 690, method: "beam", environment: "live", qr_payload: "qr-fixture", qr_image: null, status: "pending", expires_at: new Date(Date.now() + 600_000).toISOString(), new_expiry: null };
beforeEach(() => vi.clearAllMocks());
describe("Beam package interaction", () => {
  it("keeps an existing order authoritative even when form choices change", () => {
    const { rerender } = render(<BeamPackagePayment plan="starter" duration="30d" fallbackEnabled initialOrder={order} />);
    rerender(<BeamPackagePayment plan="premium" duration="1y" fallbackEnabled initialOrder={order} />);
    expect(screen.queryByRole("button", { name: "ชำระแพ็กเกจ" })).toBeNull();
    expect(screen.queryByRole("button", { name: /ช่องทางสำรอง/ })).toBeNull();
    expect(screen.getByText(/690 บาท/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "ตรวจสถานะอีกครั้ง" })).toBeTruthy();
  });
  it("allows a new checkout after success without losing the success notice first", async () => {
    render(<BeamPackagePayment plan="premium" duration="1y" fallbackEnabled initialOrder={{ ...order, status: "paid", new_expiry: "2027-01-01T00:00:00Z" }} />);
    expect(screen.getByText(/ชำระสำเร็จ/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "เริ่มรายการชำระใหม่" }));
    m.create.mockResolvedValue({ ...order, plan: "premium", duration: "1y" });
    fireEvent.click(screen.getByRole("button", { name: "ชำระแพ็กเกจ" }));
    await waitFor(() => expect(m.create).toHaveBeenCalledWith(expect.objectContaining({ plan: "premium", duration: "1y" })));
    expect(m.create.mock.calls[0][0]).not.toHaveProperty("method");
  });
  it("shows a recoverable error and reloads the uncertain order", async () => {
    m.create.mockRejectedValue(new Error("Beam ยังไม่ยืนยันผล")); m.pending.mockResolvedValue({ ...order, status: "creating", qr_payload: null });
    render(<BeamPackagePayment plan="starter" duration="30d" fallbackEnabled initialOrder={null} />);
    fireEvent.click(screen.getByRole("button", { name: "ชำระแพ็กเกจ" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Beam ยังไม่ยืนยันผล"));
    await waitFor(() => expect(screen.queryByRole("button", { name: /ช่องทางสำรอง/ })).toBeNull());
  });
  it("shows automatic PromptPay after preflight fails without a fallback choice", async () => {
    m.create.mockResolvedValue({ ...order, method: "slip" });
    render(<BeamPackagePayment plan="starter" duration="30d" fallbackEnabled initialOrder={null} />);
    expect(screen.queryByRole("button", { name: /ช่องทางสำรอง/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "ชำระแพ็กเกจ" }));
    await waitFor(() => expect(screen.getByLabelText("อัปโหลดสลิปเพื่อยืนยัน")).toBeTruthy());
    expect(screen.getByText(/Beam ไม่พร้อมตอนตรวจระบบก่อนเริ่มรายการ/)).toBeTruthy();
    expect(m.create.mock.calls[0][0]).not.toHaveProperty("method");
  });
});
