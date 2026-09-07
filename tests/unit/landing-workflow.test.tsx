// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LandingWorkflow } from "@/shared/components/marketing/LandingWorkflow";
import { WorkflowDemo3D } from "@/shared/components/marketing/WorkflowDemo3D";

let onIntersection: IntersectionObserverCallback;
let onMotionChange: () => void;
let reduced = false;
let hidden = false;
const disconnect = vi.fn();
beforeEach(() => {
  reduced = false;
  hidden = false;
  disconnect.mockClear();
  vi.stubGlobal("React", React);
  vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  vi.stubGlobal("matchMedia", () => ({
    get matches() { return reduced; },
    addEventListener: (_: string, callback: () => void) => { onMotionChange = callback; },
    removeEventListener: vi.fn(),
  }));
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: IntersectionObserverCallback) { onIntersection = callback; }
    observe() {}
    disconnect() { disconnect(); }
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function visibility(isIntersecting: boolean) {
  act(() => onIntersection([{ isIntersecting } as IntersectionObserverEntry], {} as IntersectionObserver));
}

describe("workflow CSS 3D", () => {
  it("switches all six demos and preserves the selected copy without raster images or extra canvases", () => {
    const steps = ["POS", "QR Ordering", "สต็อกสินค้า", "ลงเวลา", "รายงาน", "หลายสาขา"].map(title => ({title,detail:`รายละเอียด ${title}`,bullets:[`ข้อดี ${title}`]}));
    const { container } = render(<LandingWorkflow steps={steps} />);
    const labels = new Set<string | null>();
    const buttons = container.querySelectorAll(".reference-step-line button");
    for (let index = 0; index < steps.length; index++) {
      fireEvent.click(buttons[index]);
      expect(buttons[index].getAttribute("aria-pressed")).toBe("true");
      expect(screen.getByRole("heading", { name: steps[index].title })).toBeTruthy();
      expect(container.querySelector(".reference-feature-panel")?.getAttribute("data-step")).toBe(String(index + 1));
      labels.add(container.querySelector(".workflow-demo")!.getAttribute("aria-label"));
      expect(screen.getByText("UI จำลอง · ข้อมูลตัวอย่าง")).toBeTruthy();
    }
    expect(labels.size).toBe(6);
    expect(container.querySelectorAll("img, canvas")).toHaveLength(0);
  });

  it("animates only while visible and respects user pause, tab hiding and reduced motion", () => {
    const { container, unmount } = render(<WorkflowDemo3D step={0} />);
    const demo = container.querySelector(".workflow-demo")!;
    expect(demo.getAttribute("data-running")).toBe("false");
    visibility(true);
    expect(demo.getAttribute("data-running")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "หยุดอนิเมชัน" }));
    visibility(true);
    expect(demo.getAttribute("data-running")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "เล่นอนิเมชันต่อ" }));
    visibility(true);
    expect(demo.getAttribute("data-running")).toBe("true");
    act(() => { hidden = true; document.dispatchEvent(new Event("visibilitychange")); });
    expect(demo.getAttribute("data-running")).toBe("false");
    act(() => { hidden = false; document.dispatchEvent(new Event("visibilitychange")); });
    expect(demo.getAttribute("data-running")).toBe("true");
    act(() => { reduced = true; onMotionChange(); });
    expect(demo.getAttribute("data-running")).toBe("false");
    act(() => { reduced = false; onMotionChange(); });
    visibility(false);
    expect(demo.getAttribute("data-running")).toBe("false");
    unmount();
    expect(disconnect).toHaveBeenCalled();
  });
});
