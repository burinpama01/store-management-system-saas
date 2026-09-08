// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "../setup/react";
import { CashSessionPanel } from "@/app/pos/CashSessionPanel";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  signOut: vi.fn(),
  open: vi.fn(),
  close: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push, refresh: mocks.refresh }),
}));
vi.mock("@/app/(dashboard)/actions", () => ({ signOut: mocks.signOut }));
vi.mock("@/app/pos/cash-actions", () => ({
  openCashSessionAction: mocks.open,
  closeCashSessionAction: mocks.close,
}));

function panel(exitHref: string | null = "/dashboard", forceOpenPrompt = true) {
  return render(
    <CashSessionPanel
      session={null}
      cashSalesPreview={0}
      cashMovementPreview={0}
      currency="THB"
      forceOpenPrompt={forceOpenPrompt}
      exitHref={exitHref}
    />,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.open.mockResolvedValue({ error: null });
  mocks.signOut.mockResolvedValue(undefined);
});

describe("CashSessionPanel exit from forced opening prompt", () => {
  it.each(["/dashboard", "/attendance"])("returns to the permitted route %s without opening a session", (href) => {
    panel(href);
    fireEvent.click(screen.getByRole("button", { name: "กลับจาก POS" }));
    expect(mocks.push).toHaveBeenCalledWith(href);
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.close).not.toHaveBeenCalled();
    expect(mocks.signOut).not.toHaveBeenCalled();
    // Navigation leaves the guard intact until the destination mounts.
    expect(screen.getByRole("heading", { name: "เปิดรอบเงินสด" })).toBeVisible();
  });

  it("offers the existing sign-out action when there is no permitted exit route", async () => {
    panel(null);
    expect(screen.queryByRole("button", { name: "กลับจาก POS" })).not.toBeInTheDocument();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "ออกจากระบบ" })));
    expect(mocks.signOut).toHaveBeenCalledTimes(1);
    expect(mocks.push).not.toHaveBeenCalled();
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it.each(["/dashboard", null])("blocks exit while opening a session with exit route %s", async (href) => {
    let finish!: (value: { error: string }) => void;
    mocks.open.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    panel(href);
    fireEvent.change(screen.getByRole("spinbutton", { name: "เงินเปิดร้าน" }), { target: { value: "100" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "เปิดรอบ" })));
    const exit = screen.getByRole("button", { name: href ? "กลับจาก POS" : "ออกจากระบบ" });
    expect(exit).toBeDisabled();
    fireEvent.click(exit);
    expect(mocks.push).not.toHaveBeenCalled();
    expect(mocks.signOut).not.toHaveBeenCalled();
    await act(async () => finish({ error: "เปิดรอบไม่สำเร็จ" }));
    expect(exit).toBeEnabled();
    expect(screen.getByText("เปิดรอบไม่สำเร็จ")).toBeVisible();
  });

  it("keeps ordinary cancellation local to an optional opening prompt", () => {
    panel("/dashboard", false);
    fireEvent.click(screen.getByRole("button", { name: "เปิดรอบเงินสด" }));
    fireEvent.click(screen.getByRole("button", { name: "ยกเลิก" }));
    expect(screen.queryByRole("heading", { name: "เปิดรอบเงินสด" })).not.toBeInTheDocument();
    expect(mocks.push).not.toHaveBeenCalled();
    expect(mocks.signOut).not.toHaveBeenCalled();
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it("still opens a valid cash session and refreshes after success", async () => {
    panel();
    fireEvent.change(screen.getByRole("spinbutton", { name: "เงินเปิดร้าน" }), { target: { value: "100" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "เปิดรอบ" })));
    expect(mocks.open).toHaveBeenCalledWith(100, "");
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(mocks.push).not.toHaveBeenCalled();
    expect(screen.queryByRole("heading", { name: "เปิดรอบเงินสด" })).not.toBeInTheDocument();
  });
});
