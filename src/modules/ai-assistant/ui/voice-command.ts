// ตัวช่วยของปุ่มสั่งด้วยเสียง — แยกออกจาก component เพื่อให้ทดสอบได้โดยไม่ต้องมี DOM
//
// ทำไมผู้ช่วยหลังร้านต้องเป็นเสียงเป็นหลัก: ถ้าเป็นกล่องพิมพ์ มันก็เท่ากับกรอกฟอร์มเดิม
// ที่มีอยู่แล้ว — คุณค่าทั้งหมดอยู่ที่ "พูดประโยคเดียวแล้วจบ" โดยไม่ต้องเปิดหน้า หาเมนู
// เลือกหมวด กรอกช่อง แล้วกดบันทึก

import type { VoiceErrorCode } from "@/modules/voice-pos/types";

/** ข้อความที่บอกทั้ง "เกิดอะไร" และ "ทำอะไรต่อได้" — ไม่ใช่รหัสดิบให้คนหน้าร้านเดาเอง */
export const VOICE_ERROR_TEXT: Record<VoiceErrorCode, string> = {
  unsupported_browser: "เบราว์เซอร์นี้สั่งด้วยเสียงไม่ได้ — พิมพ์แทนได้เลย",
  permission_denied: "ยังไม่ได้อนุญาตให้ใช้ไมโครโฟน — เปิดสิทธิ์ในเบราว์เซอร์ หรือพิมพ์แทน",
  no_speech: "ไม่ได้ยินเสียง ลองพูดใหม่อีกครั้ง",
  network: "เชื่อมต่อบริการถอดเสียงไม่ได้ ลองใหม่หรือพิมพ์แทน",
  aborted: "ยกเลิกการฟังแล้ว",
  timeout: "ฟังนานเกินไปโดยไม่ได้ยินคำสั่ง ลองพูดใหม่",
  service_error: "บริการถอดเสียงมีปัญหา ลองใหม่หรือพิมพ์แทน",
};

/**
 * ความล้มเหลวที่ "ลองพูดใหม่" ไม่ช่วย → ต้องสลับไปโหมดพิมพ์ให้เอง
 *
 * ไม่รวม no_speech/timeout/aborted เพราะสามอย่างนั้นแก้ได้ด้วยการกดพูดใหม่ การเด้งไป
 * โหมดพิมพ์ทุกครั้งที่พูดไม่ทันจะกวนกว่าช่วย
 */
export function shouldFallBackToTyping(code: VoiceErrorCode): boolean {
  return code === "unsupported_browser" || code === "permission_denied"
    || code === "network" || code === "service_error";
}

/** ป้ายบนปุ่ม/แถบสถานะตามสถานะของการฟัง */
export function describeListeningState(state: string): string {
  if (state === "requesting") return "กำลังขอสิทธิ์ไมโครโฟน…";
  if (state === "listening") return "กำลังฟัง… พูดได้เลย (แตะอีกครั้งเมื่อพูดจบ)";
  if (state === "resolving") return "กำลังถอดเสียง…";
  return "";
}
