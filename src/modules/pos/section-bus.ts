"use client";

/**
 * สะพานสั่งงานระหว่างแถบหัวของ POS รวม กับ PosTerminal.
 *
 * ทั้งสองตัวไม่มี parent ร่วมที่ถือ state ได้ (PosTerminal ถูกสร้างจาก server
 * component แล้วส่งเข้ามาเป็น prop `sell`) การยุบปุ่มโต๊ะ/ครัว/บิลให้เหลือปุ่มเดียว
 * จึงต้องให้ dialog ของ shell สั่งเปิด modal ที่เป็น state ภายในของ PosTerminal ได้
 * ผ่าน CustomEvent — เบากว่าและตรงกว่าการยก state ทั้งก้อนขึ้นไป
 */
export type PosCommand = "open-table" | "settle-table";

const EVENT_NAME = "storeos:pos-command";

export function emitPosCommand(command: PosCommand): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<PosCommand>(EVENT_NAME, { detail: command }));
}

/** คืนฟังก์ชันเลิกฟัง — ใช้ใน useEffect cleanup */
export function onPosCommand(handler: (command: PosCommand) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<PosCommand>).detail;
    if (detail === "open-table" || detail === "settle-table") handler(detail);
  };
  window.addEventListener(EVENT_NAME, listener);
  return () => window.removeEventListener(EVENT_NAME, listener);
}
