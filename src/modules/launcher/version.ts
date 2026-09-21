/**
 * เวอร์ชันของ StoreOS Launcher (Windows) ที่ลิงก์ดาวน์โหลดบนเว็บกำลังแจกอยู่
 *
 * ต้องตรงกับ <Version> ใน windows/StoreOS.Launcher/StoreOS.Launcher.csproj เสมอ
 * (มีเทสต์บังคับไว้) — ตัวไฟล์ zip อยู่บน GitHub Releases tag `launcher-v<เวอร์ชัน>`
 * เลขนี้จึงเป็นทางเดียวที่หน้าเว็บจะบอกได้ว่าไฟล์ที่กำลังจะโหลดเป็นรุ่นไหน
 *
 * ตั้งแต่ 0.5.0 Launcher อัปเดตตัวเองจาก /api/launcher/latest ซึ่งอ่านค่าชุดนี้:
 * ปล่อยรุ่นใหม่ = สร้าง release + ใส่ SHA-256/ขนาดของ zip ที่อัปโหลดจริงให้ตรงทุกไบต์
 * (Launcher ทิ้งไฟล์ที่ hash ไม่ตรง — ค่าผิดแปลว่าทุกร้านอัปเดตไม่ได้ ไม่ใช่ติดตั้งของผิด)
 */
export const LAUNCHER_VERSION = "0.6.0";

/** SHA-256 (hex ตัวเล็ก) ของ storeos-launcher-<LAUNCHER_VERSION>.zip ที่อยู่บน release จริง */
export const LAUNCHER_SHA256 = "5ec7de72f3956a69e6eec0fb97c92aa34e93b915404351466e4f48064fe86668";

/** ขนาดไฟล์ zip เป็นไบต์ (Launcher ตรวจซ้ำระหว่างดาวน์โหลด) */
export const LAUNCHER_SIZE_BYTES = 120_392_990;

/** ข้อความสั้น ๆ ของรุ่นนี้ (โชว์ในแถบอัปเดตของ Launcher/หน้าเว็บ) */
export const LAUNCHER_NOTES = "อัปเดต Print Hub ที่เครื่องร้านให้อัตโนมัติ";

export const LAUNCHER_RELEASE_BASE =
  "https://github.com/burinpama01/store-management-system-saas/releases/download";

export function launcherDownloadUrl(version: string = LAUNCHER_VERSION): string {
  return `${LAUNCHER_RELEASE_BASE}/launcher-v${version}/storeos-launcher-${version}.zip`;
}
