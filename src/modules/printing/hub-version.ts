/**
 * เวอร์ชันของชุดติดตั้ง StoreOS Print Hub ที่ปุ่มดาวน์โหลดบนเว็บกำลังแจกอยู่
 *
 * ต้องตรงกับ AGENT_VERSION ใน scripts/print-hub.mjs เสมอ (มีเทสต์บังคับไว้) — ค่านี้
 * ถูกใช้ทั้งแสดงข้างปุ่มดาวน์โหลดและใส่ในชื่อไฟล์ zip ที่ผู้ใช้ได้ ร้านจึงบอกได้ว่า
 * เครื่องแคชเชียร์ลงตัวเก่าหรือตัวใหม่ โดยไม่ต้องเปิดไฟล์ดู
 *
 * ตั้งแต่ 1.4.0 Launcher เป็นคนอัปเดต Print Hub ให้ (ตัว agent ยังอัปเดตตัวเองไม่ได้)
 * โดยอ่าน manifest จาก /api/print/hub/agent-latest ซึ่งประกาศค่าชุดนี้
 *
 * ปล่อยรุ่นใหม่ = ขยับ PRINT_HUB_VERSION + AGENT_VERSION พร้อมกัน แล้วรัน
 * `npm run build:print-hub-zip` จากนั้นเอา SHA-256/ขนาดของ zip ที่ได้มาใส่ด้านล่าง
 * ให้ตรงทุกไบต์ — Launcher ทิ้งไฟล์ที่ hash ไม่ตรง ค่าผิดแปลว่าทุกร้านอัปเดตไม่ได้
 * (มีเทสต์ตรวจว่าค่าในไฟล์นี้ตรงกับ zip จริงใน public/downloads)
 */
export const PRINT_HUB_VERSION = "1.4.0";

/** SHA-256 (hex ตัวเล็ก) ของ public/downloads/storeos-print-hub.zip */
export const PRINT_HUB_SHA256 = "4a56ee25cc341a4a8515dfe8385c1e802b5193a718a02855d5ecc438ed29f6cb";

/** ขนาดไฟล์ zip เป็นไบต์ (Launcher ตรวจซ้ำระหว่างดาวน์โหลด) */
export const PRINT_HUB_SIZE_BYTES = 98_747;

/** ข้อความสั้น ๆ ของรุ่นนี้ (โชว์ในแถบอัปเดตของ Launcher) */
export const PRINT_HUB_NOTES = "ลดภาระเซิร์ฟเวอร์ด้วย long-poll และรายงานเวลาว่างให้เซิร์ฟเวอร์จัดจังหวะ";

/** ที่อยู่ไฟล์ติดตั้งบนเว็บ (ไฟล์เดียวกับปุ่มดาวน์โหลดในหน้าตั้งค่า Print Hub) */
export const PRINT_HUB_DOWNLOAD_PATH = "/downloads/storeos-print-hub.zip";
