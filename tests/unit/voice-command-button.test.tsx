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

    expect(screen.getByTestId("voice-mic")).toBeDisabled();
    expect(screen.getByText(/Ctrl\+K/)).toBeInTheDocument();
  });

  it("รองรับ → กดแล้วเข้าสถานะกำลังฟัง (push-to-talk)", () => {
    const fake = createFakeAdapter();
    render(<VoiceCommandButton adapter={fake.adapter} />);

    fireEvent.click(screen.getByTestId("voice-mic"));

    expect(fake.starts).toBe(1);
    const button = screen.getByTestId("voice-mic");
    expect(button).toHaveAttribute("aria-pressed", "true");
    expect(button).toHaveTextContent("กำลังฟัง");
  });

  it("ระหว่างฟังมี overlay เต็มจอ ที่ไม่บล็อกการใช้งานหน้าจอข้างหลัง", () => {
    const fake = createFakeAdapter();
    render(<VoiceCommandButton adapter={fake.adapter} />);

    expect(screen.queryByTestId("voice-overlay")).toBeNull();

    fireEvent.click(screen.getByTestId("voice-mic"));

    const overlay = screen.getByTestId("voice-overlay");
    expect(overlay).toHaveTextContent("กำลังฟัง");
    // แคชเชียร์ต้องกดปุ่มอื่นต่อได้ระหว่างสั่งงานด้วยเสียง — overlay เป็นภาพอย่างเดียว
    expect(overlay.className).toContain("pointer-events-none");
    expect(overlay).toHaveAttribute("aria-hidden", "true");
  });

  it("overlay โชว์คำพูดชั่วคราวตัวใหญ่ แล้วหายเมื่อจบการฟัง", () => {
    const fake = createFakeAdapter();
    render(<VoiceCommandButton adapter={fake.adapter} />);

    fireEvent.click(screen.getByTestId("voice-mic"));
    act(() => fake.emitInterim("เพิ่มลาเต้"));
    expect(screen.getByTestId("voice-overlay")).toHaveTextContent("เพิ่มลาเต้");

    act(() => fake.emitFinal("เพิ่มลาเต้ 2 แก้ว", 0.9));
    expect(screen.queryByTestId("voice-overlay")).toBeNull();
  });

  it("กดซ้ำระหว่างฟัง = ขอให้สรุปผล ไม่เปิด session ใหม่", () => {
    const fake = createFakeAdapter();
    render(<VoiceCommandButton adapter={fake.adapter} />);
    const button = screen.getByTestId("voice-mic");

    fireEvent.click(button);
    fireEvent.click(button);

    expect(fake.starts).toBe(1);
    expect(fake.stops).toBe(1);
  });

  it("final transcript → ส่งผล parse ให้ผู้เรียก และล้างข้อความชั่วคราวทันที", () => {
    const fake = createFakeAdapter();
    const results: VoiceParseResult[] = [];
    render(<VoiceCommandButton adapter={fake.adapter} onResult={(r) => {
          results.push(r);
        }} />);

    fireEvent.click(screen.getByTestId("voice-mic"));
    act(() => fake.emitInterim("เพิ่มลา"));
    // U14 — คำพูดชั่วคราวแสดงบนจอ แต่ไม่อยู่ใน live region (screen reader ไม่อ่าน)
    expect(screen.getByTestId("voice-transcript")).toHaveTextContent("เพิ่มลา");
    expect(screen.getByRole("status")).not.toHaveTextContent("เพิ่มลา");

    act(() => fake.emitFinal("เพิ่มลาเต้ 2 แก้ว", 0.9));

    expect(results).toHaveLength(1);
    expect(results[0].intent).toEqual({ type: "pos.add_item", productPhrase: "ลาเต้", quantity: 2 });
    expect(results[0].decision).toBe("execute");
    // transcript ต้องไม่ค้างบนหน้าจอหลัง parse
    expect(screen.queryByTestId("voice-transcript")).toBeNull();
    expect(screen.getByRole("status")).not.toHaveTextContent("ลาเต้");
    expect(screen.getByRole("status")).toHaveTextContent("รับคำสั่งแล้ว");
  });

  it("final ซ้ำจาก engine ในการกดเดียว → ส่งผลให้ผู้เรียกครั้งเดียว (U14 dedupe)", () => {
    const fake = createFakeAdapter();
    const results: VoiceParseResult[] = [];
    render(<VoiceCommandButton adapter={fake.adapter} onResult={(r) => {
          results.push(r);
        }} />);

    fireEvent.click(screen.getByTestId("voice-mic"));
    act(() => fake.emitFinal("เปิดครัว", 0.95));
    act(() => fake.emitFinal("เปิดครัว", 0.95));

    expect(results).toHaveLength(1);
  });

  it("ข้อความที่ผู้เรียกคืนมา ถูกประกาศแทนข้อความมาตรฐาน (live region เดียว)", () => {
    const fake = createFakeAdapter();
    render(<VoiceCommandButton adapter={fake.adapter} onResult={() => "เปิดแท็บครัวแล้ว"} />);

    fireEvent.click(screen.getByTestId("voice-mic"));
    act(() => fake.emitFinal("เปิดครัว", 0.95));

    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("status")).toHaveTextContent("เปิดแท็บครัวแล้ว");
  });

  it("คำสั่งต้องห้าม → แจ้งว่าต้องทำบนหน้าจอ และ decision ไม่ใช่ execute", () => {
    const fake = createFakeAdapter();
    const results: VoiceParseResult[] = [];
    render(<VoiceCommandButton adapter={fake.adapter} onResult={(r) => {
          results.push(r);
        }} />);

    fireEvent.click(screen.getByTestId("voice-mic"));
    act(() => fake.emitFinal("ชำระเงิน", 0.95));

    expect(results[0].decision).toBe("block");
    expect(screen.getByRole("status")).toHaveTextContent("ต้องทำบนหน้าจอ");
  });

  it("ไม่อนุญาตไมโครโฟน → ข้อความกู้คืนได้ และกดใหม่ได้", () => {
    const fake = createFakeAdapter();
    render(<VoiceCommandButton adapter={fake.adapter} />);

    fireEvent.click(screen.getByTestId("voice-mic"));
    act(() => fake.emitError("permission_denied"));

    expect(screen.getByRole("status")).toHaveTextContent("ไมโครโฟน");
    const button = screen.getByTestId("voice-mic");
    expect(button).not.toBeDisabled();
    fireEvent.click(button);
    expect(fake.starts).toBe(2);
  });

  it("telemetry ที่ส่งออกมีเฉพาะ enum — ไม่มีคำพูดของผู้ใช้", () => {
    const fake = createFakeAdapter();
    const events: VoiceTelemetryEvent[] = [];
    render(<VoiceCommandButton adapter={fake.adapter} onTelemetry={(e) => events.push(e)} />);

    fireEvent.click(screen.getByTestId("voice-mic"));
    act(() => fake.emitFinal("เพิ่มลาเต้ 2 แก้ว", 0.9));

    expect(events).toHaveLength(1);
    expect(JSON.stringify(events[0])).not.toContain("ลาเต้");
    expect(events[0]).toMatchObject({ intentType: "pos.add_item", resultCode: "matched", locale: "th-TH" });
  });

  it("unmount ระหว่างฟัง → ยกเลิก session ไม่ทิ้ง transcript ค้าง", () => {
    const fake = createFakeAdapter();
    const { unmount } = render(<VoiceCommandButton adapter={fake.adapter} />);

    fireEvent.click(screen.getByTestId("voice-mic"));
    act(() => fake.emitInterim("เพิ่มลา"));
    unmount();

    expect(fake.cancels).toBe(1);
  });

  it("disabled = ไม่เริ่มฟังเลย", () => {
    const fake = createFakeAdapter();
    render(<VoiceCommandButton adapter={fake.adapter} disabled />);

    const button = screen.getByTestId("voice-mic");
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(fake.starts).toBe(0);
  });

  it("ปุ่มมี touch target อย่างน้อย 44px ตามเกณฑ์เข้าถึงได้", () => {
    const fake = createFakeAdapter();
    render(<VoiceCommandButton adapter={fake.adapter} />);
    const button = screen.getByTestId("voice-mic");
    expect(button.className).toContain("min-h-11");
    expect(button.className).toContain("min-w-11");
  });

  it("ไม่ log transcript ออกทาง console", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fake = createFakeAdapter();
    render(<VoiceCommandButton adapter={fake.adapter} />);

    fireEvent.click(screen.getByTestId("voice-mic"));
    act(() => fake.emitFinal("เพิ่มลาเต้ 2 แก้ว", 0.9));

    expect(spy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    spy.mockRestore();
    errorSpy.mockRestore();
  });
});

// U23 — เสียงตอบรับของระบบ
describe("VoiceCommandButton — เสียงตอบรับ", () => {
  function createFakeFeedback() {
    const cues: string[] = [];
    const said: string[] = [];
    return {
      cues,
      said,
      feedback: {
        cue: (kind: string) => cues.push(kind),
        speak: (text: string) => said.push(text),
        stop: () => {},
      },
    };
  }

  it("กดปุ่ม → มีเสียงเตือนว่ากำลังฟัง", () => {
    const fake = createFakeAdapter();
    const audio = createFakeFeedback();
    render(<VoiceCommandButton adapter={fake.adapter} feedback={audio.feedback} />);

    fireEvent.click(screen.getByTestId("voice-mic"));

    expect(audio.cues).toEqual(["listening"]);
  });

  it("สั่งสำเร็จ → เสียงสำเร็จ + อ่านผลลัพธ์ที่ผู้เรียกคืนมา", () => {
    const fake = createFakeAdapter();
    const audio = createFakeFeedback();
    render(
      <VoiceCommandButton
        adapter={fake.adapter}
        feedback={audio.feedback}
        onResult={() => "เพิ่ม ลาเต้ 2 รายการแล้ว"}
      />,
    );

    fireEvent.click(screen.getByTestId("voice-mic"));
    act(() => fake.emitFinal("เพิ่มลาเต้ 2 แก้ว", 0.95));

    expect(audio.cues).toEqual(["listening", "success"]);
    expect(audio.said).toEqual(["เพิ่ม ลาเต้ 2 รายการแล้ว"]);
  });

  it("คำสั่งต้องห้าม → เสียงผิดพลาด และอ่านเหตุผล", () => {
    const fake = createFakeAdapter();
    const audio = createFakeFeedback();
    render(<VoiceCommandButton adapter={fake.adapter} feedback={audio.feedback} />);

    fireEvent.click(screen.getByTestId("voice-mic"));
    act(() => fake.emitFinal("ชำระเงิน", 0.95));

    expect(audio.cues).toEqual(["listening", "error"]);
    expect(audio.said).toEqual(["คำสั่งนี้ต้องทำบนหน้าจอ"]);
  });

  it("ไมโครโฟนถูกปฏิเสธ → เสียงผิดพลาด + อ่านวิธีแก้", () => {
    const fake = createFakeAdapter();
    const audio = createFakeFeedback();
    render(<VoiceCommandButton adapter={fake.adapter} feedback={audio.feedback} />);

    fireEvent.click(screen.getByTestId("voice-mic"));
    act(() => fake.emitError("permission_denied"));

    expect(audio.cues).toEqual(["listening", "error"]);
    expect(audio.said[0]).toContain("ไมโครโฟน");
  });

  it("ไม่อ่านคำพูดดิบของผู้ใช้ออกเสียง (อ่านเฉพาะข้อความของระบบ)", () => {
    const fake = createFakeAdapter();
    const audio = createFakeFeedback();
    render(<VoiceCommandButton adapter={fake.adapter} feedback={audio.feedback} />);

    fireEvent.click(screen.getByTestId("voice-mic"));
    act(() => fake.emitInterim("เพิ่มลาเต้สองแก้วครับ"));
    act(() => fake.emitFinal("เพิ่มลาเต้สองแก้วครับ", 0.95));

    expect(audio.said.join(" ")).not.toContain("ครับ");
  });

  it("มีปุ่มเปิด/ปิดเสียงตอบรับ และกดสลับได้", () => {
    const fake = createFakeAdapter();
    render(<VoiceCommandButton adapter={fake.adapter} />);

    const toggle = screen.getByRole("button", { name: /เสียงตอบรับ/ });
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: /เสียงตอบรับ/ })).toHaveAttribute("aria-pressed", "false");
  });
});
