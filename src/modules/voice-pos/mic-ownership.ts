// PR3-Live (M5) — เจ้าของไมค์คนเดียวต่อหน้าจอ (ADR-008: One mic owner at a time)
//
// เหตุผลที่มีไฟล์นี้: จุดจับไมค์ของ Voice POS คือ VoiceSpeechAdapter.start() ภายใน
// VoiceCommandButton และจุดจับไมค์ของโหมดเสียงสด (AI Live) คือ getUserMedia ของ WebRTC —
// สองท่อนี้ไม่รู้จักกัน จึงต้องมีสมุดจด "ใครถือไมค์อยู่" ตัวกลาง เพื่อให้ฝั่งที่จะเริ่มจับ
// ต้อง claim ให้ได้ก่อนเสมอ ใคร claim ไม่ได้ = งดจับและบอกผู้ใช้ (fail closed ไม่แย่งไมค์)
//
// ขอบเขตที่ล็กไว้:
//   - คือสมุดจดในหน่วยความจำของแท็บเดียว (เพจนี้) ไม่มีผลข้ามแท็บ/อุปกรณ์
//   - claim ซ้ำโดยเจ้าของเดิม = สำเร็จ (idempotent) กันเส้นทาง auto-listen chain ของเสียงเดิมพัง
//   - release โดยคนที่ไม่ได้ถือ = ไม่มีผล (กัน release ของ session เก่าทับของใหม่)
//   - ไม่มี timeout/evict ในตัว — ผู้ถือรับผิดชอบ release ทุกเส้นทางจบของตัวเอง

export type MicOwnerId = "voice-pos" | "ai-live";

const listeners = new Set<() => void>();
let holder: MicOwnerId | null = null;

function emit(): void {
  for (const listener of [...listeners]) listener();
}

/** ใครถือไมค์อยู่ (null = ว่าง) — ใช้กับ useSyncExternalStore ได้ */
export function readMicOwnership(): MicOwnerId | null {
  return holder;
}

export function subscribeMicOwnership(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** ขอถือไมค์ — มีเจ้าของอื่นอยู่ = false (ผู้เรียกต้องงดจับและบอกผู้ใช้) */
export function claimMicOwnership(owner: MicOwnerId): boolean {
  if (holder !== null && holder !== owner) return false;
  if (holder !== owner) {
    holder = owner;
    emit();
  }
  return true;
}

/** คืนไมค์ — ปลอดภัยต่อการเรียกซ้ำ เรียกโดยคนที่ไม่ได้ถือ = ไม่มีผล */
export function releaseMicOwnership(owner: MicOwnerId): void {
  if (holder !== owner) return;
  holder = null;
  emit();
}
