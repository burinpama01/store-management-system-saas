"use client";

import { useOnlineStatus } from "@/shared/hooks/useOnlineStatus";

/**
 * ป้ายสถานะการเชื่อมต่อที่บอกความจริง — เดิมเป็นข้อความ "เชื่อมต่อปกติ" ตายตัว
 * เน็ตหลุดก็ยังเขียว ซึ่งหลอกแคชเชียร์ให้ขายต่อทั้งที่บันทึกไม่ได้
 */
export function ConnectionBadge({ className = "" }: { className?: string }) {
  const online = useOnlineStatus();
  return (
    <span
      role="status"
      aria-live="polite"
      /* className ของผู้เรียกมักซ่อนป้ายบนจอเล็ก (hidden sm:inline-flex) ซึ่งโอเค
         ตอนออนไลน์ แต่ตอนออฟไลน์ต้องเห็นเสมอ — ไม่งั้นแคชเชียร์บนมือถือกดขายต่อ
         ทั้งที่บันทึกไม่ได้ */
      className={`badge ${online ? `badge-success ${className}` : "badge-danger"}`.trim()}
    >
      {online ? "เชื่อมต่อปกติ" : "ออฟไลน์ — บันทึกไม่ได้"}
    </span>
  );
}
