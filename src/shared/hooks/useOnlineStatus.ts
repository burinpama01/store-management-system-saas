"use client";

import { useEffect, useState } from "react";

/**
 * สถานะการเชื่อมต่อจริงของเบราว์เซอร์.
 *
 * เดิมหน้า POS และแดชบอร์ดโชว์ป้าย "เชื่อมต่อปกติ" เป็นข้อความตายตัว — เน็ตหลุด
 * ป้ายก็ยังเขียวอยู่ ซึ่งอันตรายกว่าไม่มีป้ายเลย เพราะแคชเชียร์เชื่อป้ายแล้วกดขาย
 * ต่อทั้งที่บันทึกไม่ได้.
 *
 * เริ่มต้นที่ true เสมอเพื่อให้ผลบนเซิร์ฟเวอร์กับตอน hydrate ตรงกัน แล้วค่อยอ่านค่า
 * จริงหลัง mount (navigator.onLine อ่านบนเซิร์ฟเวอร์ไม่ได้).
 *
 * ข้อจำกัดที่ต้องรู้: navigator.onLine บอกได้แค่ว่า "เครื่องต่อเน็ตอยู่ไหม" ไม่ได้
 * แปลว่าเซิร์ฟเวอร์ StoreOS ตอบอยู่ — ต่อ Wi-Fi ที่เน็ตเสียก็ยังรายงานว่า online
 * ป้ายนี้จึงบอกได้แน่นอนแค่ฝั่ง "ออฟไลน์" เท่านั้น
 */
export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(true);

  useEffect(() => {
    const sync = () => setOnline(navigator.onLine);
    sync();
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    return () => {
      window.removeEventListener("online", sync);
      window.removeEventListener("offline", sync);
    };
  }, []);

  return online;
}
