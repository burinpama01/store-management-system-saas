// PR3-Live (fix) — คำปลุกของเครื่องต้องเปิด "โหมดเสียงสด" ได้ ไม่ใช่เปิดได้แค่ปุ่มเสียงเดิม
//
// เหตุผลที่มีไฟล์นี้: คำปลุกเข้ามาที่ VoiceCommandButton (แถบหัวของ POS) แต่ตัวคุมเซสชัน
// เสียงสดอยู่ในแผงผู้ช่วย (TextAssistantOverlay) — สองที่นี้ไม่รู้จักกันและไม่ควรรู้จักกัน
// จึงใช้ "สมุดจดปลายทางคำปลุก" ตัวกลางแบบเดียวกับ mic-ownership: ฝั่งเสียงสดมาลงทะเบียน
// ตัวเองเมื่อร้านเปิดใช้ ส่วนฝั่งคำปลุกแค่ถามว่ามีคนรับช่วงไหม
//
// กฎที่ล็กไว้:
//   - ไม่มีใครลงทะเบียน = "unavailable" → คำปลุกเดินเส้นทางเดิม (Voice POS) ทุกประการ
//   - เซสชันเสียงสดเปิดอยู่แล้ว = "busy" → กลืนคำปลุกนั้นทิ้ง ห้ามไปเปิดไมค์ซ้อน (ADR-008)
//   - เป็นสมุดจดในหน่วยความจำของแท็บเดียว ไม่มีผลข้ามแท็บ/อุปกรณ์
//   - ปลายทางต้องตอบ "ทันที" (ไม่ใช่ Promise) เพราะฝั่งคำปลุกต้องตัดสินใจคืนไมค์ให้ native
//     ภายในหน้าต่าง watchdog ของเครื่อง (StandbySession: รอบละไม่เกิน 20 วินาที)

/** ผลการส่งคำปลุกให้ปลายทางเสียงสด */
export type WakeRouteOutcome = "started" | "busy" | "unavailable";

/** ปลายทางคำปลุก — คืนผลทันที: เปิดเซสชันให้แล้ว หรือกำลังทำงานอยู่ */
export type WakeTarget = () => "started" | "busy";

let target: WakeTarget | null = null;

/** ลงทะเบียนปลายทาง (คืนฟังก์ชันถอน — ถอนได้เฉพาะของตัวเอง กันของใหม่ถูกถอนโดยของเก่า) */
export function registerWakeTarget(next: WakeTarget): () => void {
  target = next;
  return () => {
    if (target === next) target = null;
  };
}

/** ส่งคำปลุกให้ปลายทางเสียงสด — ไม่มีปลายทาง = "unavailable" (ผู้เรียกเดินเส้นทางเดิม) */
export function routeWakeToLive(): WakeRouteOutcome {
  const current = target;
  if (!current) return "unavailable";
  try {
    return current();
  } catch {
    // ปลายทางพังต้องไม่ทำให้คำปลุกทั้งระบบตาย — ถอยไปเส้นทางเดิม
    return "unavailable";
  }
}
