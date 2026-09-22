// ปุ่มสั่งด้วยเสียงของผู้ช่วยหลังร้าน
//
// เสียงเป็นทางหลัก ไม่ใช่ของแถม — ถ้าเป็นกล่องพิมพ์ ผู้ช่วยก็ไม่ต่างจากฟอร์มเดิมที่มีอยู่
// เทสชุดนี้จึงเน้นเรื่องเดียว: ความล้มเหลวแบบไหนควร "ลองพูดใหม่" และแบบไหนควรสลับไป
// พิมพ์ให้เลย เพราะเด้งผิดทางทั้งสองแบบทำให้คนหน้าร้านติดอยู่กับที่

import { describe, it, expect } from "vitest";
import {
  describeListeningState,
  shouldFallBackToTyping,
  VOICE_ERROR_TEXT,
} from "@/modules/ai-assistant/ui/voice-command";
import type { VoiceErrorCode } from "@/modules/voice-pos/types";

describe("ปุ่มสั่งด้วยเสียง", () => {
  const allCodes: VoiceErrorCode[] = [
    "unsupported_browser", "permission_denied", "no_speech",
    "network", "aborted", "timeout", "service_error",
  ];

  it("ทุกรหัสความล้มเหลวมีข้อความภาษาคน ไม่มีรหัสดิบหลุดถึงหน้าร้าน", () => {
    for (const code of allCodes) {
      expect(VOICE_ERROR_TEXT[code], `ขาดข้อความของ ${code}`).toBeTruthy();
      expect(VOICE_ERROR_TEXT[code]).not.toContain("_");
    }
  });

  it("ล้มเหลวแบบที่พูดใหม่ไม่ช่วย = สลับไปพิมพ์ให้เลย", () => {
    expect(shouldFallBackToTyping("unsupported_browser")).toBe(true);
    expect(shouldFallBackToTyping("permission_denied")).toBe(true);
    expect(shouldFallBackToTyping("network")).toBe(true);
    expect(shouldFallBackToTyping("service_error")).toBe(true);
  });

  it("ล้มเหลวแบบที่พูดใหม่ช่วยได้ = อยู่โหมดเสียงต่อ", () => {
    // เด้งไปโหมดพิมพ์ทุกครั้งที่พูดไม่ทันจะกวนกว่าช่วย
    expect(shouldFallBackToTyping("no_speech")).toBe(false);
    expect(shouldFallBackToTyping("timeout")).toBe(false);
    expect(shouldFallBackToTyping("aborted")).toBe(false);
  });

  it("สถานะระหว่างฟังบอกผู้ใช้ว่าต้องทำอะไรต่อ", () => {
    expect(describeListeningState("requesting")).toContain("ไมโครโฟน");
    expect(describeListeningState("listening")).toContain("พูดได้เลย");
    expect(describeListeningState("resolving")).toContain("ถอดเสียง");
    expect(describeListeningState("idle")).toBe("");
  });
});
