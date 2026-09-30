// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SaveImageButton } from "@/app/payslip/SaveImageButton";

const { toBlob } = vi.hoisted(() => ({ toBlob: vi.fn() }));
vi.mock("html-to-image", () => ({ toBlob }));

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(document, "fonts", { configurable: true, value: { ready: Promise.resolve() } });
  vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:fixture"), revokeObjectURL: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function setup() {
  return render(<><div id="payslip-image-content">สลิปทดสอบ ฿2,566.67</div>
    <SaveImageButton fileName="payslip_2026-09-20_2026-09-30.png" /></>);
}

describe("payslip image download", () => {
  it("downloads only slip content with the selected period filename", async () => {
    toBlob.mockResolvedValue(new Blob(["png"], { type: "image/png" }));
    const clicked: { filename?: string; href?: string } = {};
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicked.filename = this.download; clicked.href = this.href;
    });
    setup();
    fireEvent.click(screen.getByRole("button", { name: "บันทึกเป็นภาพ" }));
    await waitFor(() => expect(clicked.filename).toBe("payslip_2026-09-20_2026-09-30.png"));
    expect(clicked.href).toBe("blob:fixture");
    expect(toBlob.mock.calls[0][0]).toBe(document.getElementById("payslip-image-content"));
    expect(toBlob.mock.calls[0][1]).toMatchObject({ backgroundColor: "#ffffff", pixelRatio: 2 });
    expect(document.querySelector("a[download]")).toBeNull();
  });
  it("prevents another export while rendering and permits retry after a failure", async () => {
    let reject!: (error: Error) => void;
    toBlob.mockReturnValue(new Promise((_, fail) => { reject = fail; }));
    setup();
    fireEvent.click(screen.getByRole("button", { name: "บันทึกเป็นภาพ" }));
    await waitFor(() => expect(toBlob).toHaveBeenCalledTimes(1));
    const busy = screen.getByRole("button", { name: "กำลังบันทึกภาพ…" }) as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    fireEvent.click(busy);
    expect(toBlob).toHaveBeenCalledTimes(1);
    reject(new Error("render failed"));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "บันทึกภาพไม่สำเร็จ กรุณาลองอีกครั้ง");
    toBlob.mockResolvedValue(new Blob(["png"], { type: "image/png" }));
    fireEvent.click(screen.getByRole("button", { name: "บันทึกเป็นภาพ" }));
    await waitFor(() => expect(toBlob).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });
  it("does not download a blank image when rendering returns no blob", async () => {
    toBlob.mockResolvedValue(null);
    setup();
    fireEvent.click(screen.getByRole("button", { name: "บันทึกเป็นภาพ" }));
    await screen.findByRole("alert");
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
  it("captures overflow content instead of clipping to the mobile viewport", async () => {
    toBlob.mockResolvedValue(new Blob(["png"], { type: "image/png" }));
    setup();
    const content = document.getElementById("payslip-image-content")!;
    Object.defineProperties(content, { clientWidth: { value: 272 }, scrollWidth: { value: 760 } });
    fireEvent.click(screen.getByRole("button", { name: "บันทึกเป็นภาพ" }));
    await waitFor(() => expect(toBlob).toHaveBeenCalled());
    expect(toBlob.mock.calls[0][1].width).toBe(760);
  });
});
