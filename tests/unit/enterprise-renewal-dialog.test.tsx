// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "../setup/react";
import type { BillingOrderView } from "@/modules/billing/beam-billing-types";

const m = vi.hoisted(() => ({ create: vi.fn(), refresh: vi.fn(), pending: vi.fn(), routerRefresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: m.routerRefresh }) }));
vi.mock("@/shared/components/ui", () => ({ QrCode: ({ value }: { value: string }) => <div aria-label="QR">{value}</div> }));
vi.mock("@/app/(dashboard)/settings/billing/beam-actions", () => ({ createBeamPackageAction: m.create, refreshBeamPackageAction: m.refresh, pendingBeamPackageAction: m.pending }));
import { EnterpriseRenewalDialog } from "@/app/(dashboard)/settings/billing/EnterpriseRenewalDialog";

const order: BillingOrderView = { id: "order-1", plan: "enterprise", duration: "custom", amount: 4500, method: "beam", environment: "live", qr_payload: "beam-qr", qr_image: null, status: "pending", expires_at: new Date(Date.now() + 600_000).toISOString(), new_expiry: null };
const props = { amount: 4500, summary: "จ่าย ฿4,500 · ต่ออีก 365 วัน", fallbackEnabled: false, onChangePackage: vi.fn(), onClose: vi.fn() };
beforeEach(() => vi.clearAllMocks());

describe("ไดอาล็อกต่ออายุ Enterprise", () => {
  it("ถามสองทางพร้อมราคา และยังไม่สร้างรายการจนกว่าจะกดต่ออายุ", () => {
    render(<EnterpriseRenewalDialog {...props} initialOrder={null} />);
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("แพ็กเกจหมดอายุ")).toBeTruthy();
    expect(screen.getByRole("button", { name: /ต่ออายุ 4,500 บาท/ })).toBeTruthy();
    expect(m.create).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "เปลี่ยนแพ็กเกจ" }));
    expect(props.onChangePackage).toHaveBeenCalled();
  });

  it("กดต่ออายุแล้วสร้างรายการ enterprise และแสดง QR ของ Beam ในไดอาล็อก", async () => {
    m.create.mockResolvedValue(order);
    render(<EnterpriseRenewalDialog {...props} initialOrder={null} />);
    fireEvent.click(screen.getByRole("button", { name: /ต่ออายุ 4,500 บาท/ }));
    await waitFor(() => expect(screen.getByLabelText("QR").textContent).toBe("beam-qr"));
    expect(m.create).toHaveBeenCalledTimes(1);
    expect(m.create.mock.calls[0][0]).toMatchObject({ plan: "enterprise" });
    expect(m.create.mock.calls[0][0].discountCode).toBeUndefined();
  });

  it("มีรายการค้างอยู่แล้ว ข้ามไปหน้าจ่ายทันทีโดยไม่สร้างซ้ำ", () => {
    render(<EnterpriseRenewalDialog {...props} initialOrder={order} />);
    expect(screen.getByLabelText("QR")).toBeTruthy();
    expect(m.create).not.toHaveBeenCalled();
  });

  it("รายการค้างของแพ็กเกจอื่น ไม่แสดง QR และไม่สร้าง/ตรวจรายการ", () => {
    render(<EnterpriseRenewalDialog {...props} initialOrder={{ ...order, plan: "starter", duration: "30d", amount: 690 }} />);
    expect(screen.queryByLabelText("QR")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("แพ็กเกจอื่นค้างอยู่");
    expect(m.create).not.toHaveBeenCalled();
  });

  it("ปุ่มปิดเป็นการปิดเฉย ๆ ไม่พาไปเปลี่ยนแพ็กเกจ", () => {
    render(<EnterpriseRenewalDialog {...props} initialOrder={null} />);
    fireEvent.click(screen.getByRole("button", { name: "ปิด dialog" }));
    expect(props.onClose).toHaveBeenCalled();
    expect(props.onChangePackage).not.toHaveBeenCalled();
  });

  it("จ่ายสำเร็จแล้วเปลี่ยนเป็นหน้าสำเร็จพร้อมปุ่มเริ่มใช้งานต่อ", () => {
    render(<EnterpriseRenewalDialog {...props} initialOrder={{ ...order, status: "paid", new_expiry: "2027-10-04T00:00:00Z" }} />);
    expect(screen.getByText("ต่ออายุสำเร็จ")).toBeTruthy();
    expect(screen.getByRole("link", { name: "เริ่มใช้งานต่อ" })).toBeTruthy();
  });
});

describe("หน้าแพ็กเกจเปิดไดอาล็อกเมื่อหมดอายุและมีข้อเสนอ", () => {
  const source = readFileSync(join(process.cwd(), "src/app/(dashboard)/settings/billing/BillingManager.tsx"), "utf8");
  it("เปิดเฉพาะร้านที่หมดอายุ มีสิทธิ์จ่าย มีข้อเสนอ และใช้ Beam", () => {
    expect(source).toContain("canManage && !isActive && !isEnterpriseContract && Boolean(enterpriseOffer) && beamEnabled");
  });
  it("ร้าน Enterprise ที่หมดอายุไม่ถูกตั้งค่าเริ่มต้นเป็น Starter", () => {
    expect(source).toContain('plan === "enterprise" && enterpriseOffer');
  });
});
