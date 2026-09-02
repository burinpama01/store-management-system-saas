// @vitest-environment jsdom
// U13 — ปุ่ม push-to-talk: สถานะกู้คืนได้ + transcript อยู่ในหน่วยความจำชั่วคราวเท่านั้น
// ⚠️ ต้องมี header jsdom ทุกครั้ง — static-import @testing-library/* บน node env คือ hang จน timeout
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "../setup/react";
import { VoiceCommandButton } from "@/shared/components/VoiceCommandButton";
import type {
  VoiceSpeechAdapter,
  VoiceSpeechHandlers,
  VoiceSpeechSession,
} from "@/modules/voice-pos/speech-adapter";
import type { VoiceParseResult, VoiceTelemetryEvent } from "@/modules/voice-pos/types";

/** adapter ปลอมที่ควบคุมได้จากเทสต์ (แทน Web Speech จริง) */
function createFakeAdapter(supported = true) {
  let handlers: VoiceSpeechHandlers | null = null;
  let active = false;
  let starts = 0;
  let cancels = 0;
  let stops = 0;

  const session: VoiceSpeechSession = {
    isActive: () => active,
    stop: () => {
      stops += 1;
    },
    cancel: () => {
      cancels += 1;
      active = false;
    },
  };

  const adapter: VoiceSpeechAdapter = {
    isSupported: () => supported,
    start: (h) => {
      starts += 1;
      handlers = h;
      if (!supported) {
        h.onError("unsupported_browser");
        return { isActive: () => false, stop: () => {}, cancel: () => {} };
      }
      active = true;
      h.onState?.("requesting");
      h.onState?.("listening");
      return session;
    },
  };

  return {
    adapter,
    get starts() {
      return starts;
    },
    get cancels() {
      return cancels;
    },
    get stops() {
      return stops;
    },
    emitFinal(transcript: string, confidence: number | null) {
      active = false;
      handlers?.onState?.("resolving");
      handlers?.onFinal(transcript, confidence);
      handlers?.onState?.("idle");
    },
    emitInterim(text: string) {
      handlers?.onInterim?.(text);
    },
    emitError(code: Parameters<VoiceSpeechHandlers["onError"]>[0]) {
      active = false;
      handlers?.onError(code);
      handlers?.onState?.("idle");
    },
  };
}

describe("VoiceCommandButton", () => {
  it("เบราว์เซอร์ไม่รองรับ → ปุ่ม disabled พร้อมทางสำรอง Ctrl+K", () => {
    const fake = createFakeAdapter(false);
    render(<VoiceCommandButton adapter={fake.adapter} />);

    expect(screen.getByRole("button")).toBeDisabled();
    expect(screen.getByText(/Ctrl\+K/)).toBeInTheDocument();
  });

  it("รองรับ → กดแล้วเข้าสถานะกำลังฟัง (push-to-talk)", () => {
    const fake = createFakeAdapter();
    render(<VoiceCommandButton adapter={fake.adapter} />);

    fireEvent.click(screen.getByRole("button"));

    expect(fake.starts).toBe(1);
    const button = screen.getByRole("button");
    expect(button).toHaveAttribute("aria-pressed", "true");
    expect(button).toHaveTextContent("กำลังฟัง");
  });

  it("กดซ้ำระหว่างฟัง = ขอให้สรุปผล ไม่เปิด session ใหม่", () => {
    const fake = createFakeAdapter();
    render(<VoiceCommandButton adapter={fake.adapter} />);
    const button = screen.getByRole("button");

    fireEvent.click(button);
    fireEvent.click(button);

    expect(fake.starts).toBe(1);
    expect(fake.stops).toBe(1);
  });

  it("final transcript → ส่งผล parse ให้ผู้เรียก และล้างข้อความชั่วคราวทันที", () => {
    const fake = createFakeAdapter();
    const results: VoiceParseResult[] = [];
    render(<VoiceCommandButton adapter={fake.adapter} onResult={(r) => results.push(r)} />);

    fireEvent.click(screen.getByRole("button"));
    act(() => fake.emitInterim("เพิ่มลา"));
    expect(screen.getByRole("status")).toHaveTextContent("เพิ่มลา");

    act(() => fake.emitFinal("เพิ่มลาเต้ 2 แก้ว", 0.9));

    expect(results).toHaveLength(1);
    expect(results[0].intent).toEqual({ type: "pos.add_item", productPhrase: "ลาเต้", quantity: 2 });
    expect(results[0].decision).toBe("execute");
    // transcript ต้องไม่ค้างบนหน้าจอหลัง parse
    expect(screen.getByRole("status")).not.toHaveTextContent("ลาเต้");
    expect(screen.getByRole("status")).toHaveTextContent("รับคำสั่งแล้ว");
  });

  it("คำสั่งต้องห้าม → แจ้งว่าต้องทำบนหน้าจอ และ decision ไม่ใช่ execute", () => {
    const fake = createFakeAdapter();
    const results: VoiceParseResult[] = [];
    render(<VoiceCommandButton adapter={fake.adapter} onResult={(r) => results.push(r)} />);

    fireEvent.click(screen.getByRole("button"));
    act(() => fake.emitFinal("ชำระเงิน", 0.95));

    expect(results[0].decision).toBe("block");
    expect(screen.getByRole("status")).toHaveTextContent("ต้องทำบนหน้าจอ");
  });

  it("ไม่อนุญาตไมโครโฟน → ข้อความกู้คืนได้ และกดใหม่ได้", () => {
    const fake = createFakeAdapter();
    render(<VoiceCommandButton adapter={fake.adapter} />);

    fireEvent.click(screen.getByRole("button"));
    act(() => fake.emitError("permission_denied"));

    expect(screen.getByRole("status")).toHaveTextContent("ไมโครโฟน");
    const button = screen.getByRole("button");
    expect(button).not.toBeDisabled();
    fireEvent.click(button);
    expect(fake.starts).toBe(2);
  });

  it("telemetry ที่ส่งออกมีเฉพาะ enum — ไม่มีคำพูดของผู้ใช้", () => {
    const fake = createFakeAdapter();
    const events: VoiceTelemetryEvent[] = [];
    render(<VoiceCommandButton adapter={fake.adapter} onTelemetry={(e) => events.push(e)} />);

    fireEvent.click(screen.getByRole("button"));
    act(() => fake.emitFinal("เพิ่มลาเต้ 2 แก้ว", 0.9));

    expect(events).toHaveLength(1);
    expect(JSON.stringify(events[0])).not.toContain("ลาเต้");
    expect(events[0]).toMatchObject({ intentType: "pos.add_item", resultCode: "matched", locale: "th-TH" });
  });

  it("unmount ระหว่างฟัง → ยกเลิก session ไม่ทิ้ง transcript ค้าง", () => {
    const fake = createFakeAdapter();
    const { unmount } = render(<VoiceCommandButton adapter={fake.adapter} />);

    fireEvent.click(screen.getByRole("button"));
    act(() => fake.emitInterim("เพิ่มลา"));
    unmount();

    expect(fake.cancels).toBe(1);
  });

  it("disabled = ไม่เริ่มฟังเลย", () => {
    const fake = createFakeAdapter();
    render(<VoiceCommandButton adapter={fake.adapter} disabled />);

    const button = screen.getByRole("button");
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(fake.starts).toBe(0);
  });

  it("ปุ่มมี touch target อย่างน้อย 44px ตามเกณฑ์เข้าถึงได้", () => {
    const fake = createFakeAdapter();
    render(<VoiceCommandButton adapter={fake.adapter} />);
    const button = screen.getByRole("button");
    expect(button.className).toContain("min-h-11");
    expect(button.className).toContain("min-w-11");
  });

  it("ไม่ log transcript ออกทาง console", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fake = createFakeAdapter();
    render(<VoiceCommandButton adapter={fake.adapter} />);

    fireEvent.click(screen.getByRole("button"));
    act(() => fake.emitFinal("เพิ่มลาเต้ 2 แก้ว", 0.9));

    expect(spy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    spy.mockRestore();
    errorSpy.mockRestore();
  });
});
