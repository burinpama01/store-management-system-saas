// U23 — ตัวเลือก "เปิด/ปิดเสียงตอบรับ" ต่ออุปกรณ์
//
// เก็บเฉพาะค่า boolean ต่อเครื่อง (เครื่องในครัวอาจอยากปิด แต่เครื่องแคชเชียร์อยากเปิด)
// ⚠️ ห้ามเก็บอย่างอื่นในคีย์นี้เด็ดขาด — ไม่มีเสียง ไม่มีคำพูด ไม่มีข้อมูลผู้ใช้
// (มีเทสสแกน tests/unit/voice-pos-privacy.test.ts บังคับกติกานี้ไว้)

export const VOICE_FEEDBACK_STORAGE_KEY = "storeos.voice.feedback";

/** ค่าเริ่มต้น: เปิดเสียง — พนักงานมือไม่ว่างต้องรู้ผลโดยไม่ต้องมองจอ */
export const VOICE_FEEDBACK_DEFAULT = true;

export function readVoiceFeedbackPreference(): boolean {
  try {
    const raw = globalThis.localStorage?.getItem(VOICE_FEEDBACK_STORAGE_KEY);
    if (raw === "1") return true;
    if (raw === "0") return false;
    return VOICE_FEEDBACK_DEFAULT;
  } catch {
    // เบราว์เซอร์บล็อก storage (โหมดส่วนตัว) → ใช้ค่าเริ่มต้น
    return VOICE_FEEDBACK_DEFAULT;
  }
}

/** ผู้ฟังการเปลี่ยนค่า — ให้ UI ใช้กับ useSyncExternalStore ได้โดยไม่ต้อง setState ใน effect */
const listeners = new Set<() => void>();

export function subscribeVoiceFeedbackPreference(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function writeVoiceFeedbackPreference(enabled: boolean): void {
  try {
    globalThis.localStorage?.setItem(VOICE_FEEDBACK_STORAGE_KEY, enabled ? "1" : "0");
  } catch {
    // จำค่าไม่ได้ก็ไม่เป็นไร — รอบนี้ยังใช้งานได้ตามที่กด
  }
  for (const listener of listeners) listener();
}
