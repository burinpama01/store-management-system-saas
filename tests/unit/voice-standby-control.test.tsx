// @vitest-environment jsdom
// W7 — แถบสถานะและปุ่มพักคำปลุก (Design System v1)
// ⚠️ ต้องมี header jsdom ทุกครั้ง — static-import @testing-library/* บน node env คือ hang จน timeout
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "../setup/react";

import { VoiceStandbyControl } from "@/shared/components/VoiceStandbyControl";

describe("VoiceStandbyControl", () => {
  it("ไม่มี Launcher = ไม่จองพื้นที่บนแถบหัวเลย", () => {
    const { container } = render(<VoiceStandbyControl state="unavailable" onToggle={vi.fn()} />);

    expect(container.firstChild).toBeNull();
  });

  it.each([
    ["standby", "พร้อมรับคำปลุก"],
    ["off", "สแตนด์บายปิด"],
    ["listening", "กำลังฟังคำสั่ง"],
    ["degraded", "สแตนด์บายไม่พร้อม"],
  ] as const)("สถานะ %s บอกด้วยข้อความ ไม่ใช่สีอย่างเดียว", (state, label) => {
    render(<VoiceStandbyControl state={state} />);

    expect(screen.getByTestId("voice-standby-status").textContent).toContain(label);
  });

  it("สถานะอ่านออกได้ด้วย screen reader และแยกจากคำพูดของผู้ใช้", () => {
    render(<VoiceStandbyControl state="standby" />);
    const status = screen.getByTestId("voice-standby-status");

    expect(status.getAttribute("role")).toBe("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
  });

  it("กดพักแล้วแจ้งผู้เรียก", () => {
    const onToggle = vi.fn();
    render(<VoiceStandbyControl state="standby" onToggle={onToggle} />);

    fireEvent.click(screen.getByTestId("voice-standby-toggle"));

    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("ปุ่มบอกสถานะปัจจุบันให้ screen reader ด้วย aria-pressed", () => {
    const { rerender } = render(<VoiceStandbyControl state="standby" onToggle={vi.fn()} />);
    expect(screen.getByTestId("voice-standby-toggle").getAttribute("aria-pressed")).toBe("true");

    rerender(<VoiceStandbyControl state="off" onToggle={vi.fn()} />);
    expect(screen.getByTestId("voice-standby-toggle").getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByTestId("voice-standby-toggle").getAttribute("aria-label")).toBe("เปิดสแตนด์บาย");
  });

  it("ไม่ส่ง onToggle มา = แสดงสถานะอย่างเดียว ไม่มีปุ่มลอย", () => {
    render(<VoiceStandbyControl state="standby" />);

    expect(screen.queryByTestId("voice-standby-toggle")).toBeNull();
  });

  it("ปุ่มใหญ่พอสำหรับนิ้วเดียวตาม accessibility contract", () => {
    render(<VoiceStandbyControl state="standby" onToggle={vi.fn()} />);

    const className = screen.getByTestId("voice-standby-toggle").className;
    expect(className).toContain("min-h-11");
    expect(className).toContain("min-w-11");
  });
});
