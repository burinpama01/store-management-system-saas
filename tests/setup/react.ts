import { afterEach } from "vitest";

// U0.5 — setup สำหรับ component test ที่รันบน jsdom (ประกาศ // @vitest-environment jsdom
// ที่หัวไฟล์ หรือ wire ผ่าน setupFiles ในงานถัดไป)
// ข้อบังคับ: ต้อง import-safe เมื่อถูกโหลดใน node environment ด้วย — เมื่อไม่มี document
// จะไม่โหลด @testing-library/react และ jest-dom เลย (โหลดเฉพาะเมื่อมี DOM)
// ⚠️ ห้าม static-import @testing-library/* ใน test ที่รันบน node environment —
// พฤติกรรมที่วัดได้คือ hang จน timeout (ไม่ throw) ให้ใส่ // @vitest-environment jsdom ทุกครั้ง

let cleanup: (() => void) | undefined;

if (typeof document !== "undefined") {
  const react = await import("@testing-library/react");
  // fail-fast: ถ้า RTL เปลี่ยน export ให้พังตรงนี้ ไม่ใช่ cleanup หายเงียบๆ
  if (typeof react.cleanup !== "function") {
    throw new Error(
      "tests/setup/react: @testing-library/react ไม่มี export cleanup เป็น function — ตรวจเวอร์ชัน RTL"
    );
  }
  cleanup = react.cleanup;
  await import("@testing-library/jest-dom/vitest");
}

if (cleanup) {
  afterEach(() => cleanup!());
}
