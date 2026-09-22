/**
 * รุ่นล่าสุดของแอป Android ที่แจกอยู่จริง
 *
 * แอปไม่ได้อยู่บน Google Play (ดู decisions.md 2026-09-21) จึงไม่มี auto-update ของ Store
 * และตัวแอปเองก็อัปเดตตัวเองไม่ได้ — เว็บเป็นฝ่ายบอกผู้ใช้ว่ามีรุ่นใหม่ ซึ่งทำได้เพราะ
 * แอปเป็นเปลือกบาง (Capacitor `server.url`) ที่โหลดเว็บ production ทุกครั้งที่เปิด
 * ⇒ แบนเนอร์แจ้งเตือนไปถึงทุกเครื่องทันทีที่ deploy โดยไม่ต้องรอใครอัปเดต APK ก่อน
 *
 * ค่าพวกนี้ต้องตรงกับ `mobile/android/app/build.gradle` และไฟล์ APK ที่อัปโหลดไว้จริง
 * — `tests/unit/download-versions.test.ts` ล็อกไว้ ค่าผิดแปลว่าทุกเครื่องเห็นแบนเนอร์ผิดรุ่น
 */
export const ANDROID_VERSION_NAME = "1.0.4";

/** versionCode ของ Android — ตัวที่ใช้เทียบว่าใหม่กว่าจริงไหม (versionName เป็นแค่ข้อความ) */
export const ANDROID_VERSION_CODE = 5;

/** SHA-256 (hex ตัวเล็ก) ของ APK ที่อยู่บน Supabase storage `app/storeos-android.apk` */
export const ANDROID_SHA256 = "c517e118ee00ef16bb492be16a7bc1656ebefc5ec7de8d6ae0e49586b905e333";

/** ขนาดไฟล์ APK เป็นไบต์ */
export const ANDROID_SIZE_BYTES = 5_069_593;

/** ข้อความสั้น ๆ ของรุ่นนี้ (โชว์ในแบนเนอร์แจ้งอัปเดต) */
export const ANDROID_NOTES = "เก็บ log การแจ้งเตือนเพื่อแก้เสียงออเดอร์ไม่ดังวนตอนปิดจอ";

/** ลิงก์ดาวน์โหลดสาธารณะ — redirect ไป Supabase storage (path เดิมเสมอ) */
export const ANDROID_DOWNLOAD_PATH = "/download/android";

/**
 * อ่านเวอร์ชันแอปจาก User-Agent ที่ Capacitor ต่อท้ายไว้ (`StoreOSApp/1.0.2`)
 *
 * คืน `null` เมื่อไม่ใช่แอป และคืน `0` เมื่อเป็นแอปรุ่นเก่าที่ยังไม่ได้ต่อเลขเวอร์ชัน
 * (build ≤ 1.0.2 ส่งมาแค่ `StoreOSApp` เปล่า ๆ) — ศูนย์ทำให้เครื่องที่ลงไปแล้ว
 * เห็นแบนเนอร์ได้ทันทีโดยไม่ต้องรออัปเดตก่อน ซึ่งเป็นทั้งหมดของประเด็นนี้
 */
export function parseAppVersionName(userAgent: string): string | null {
  if (!userAgent.includes("StoreOSApp")) return null;
  return /StoreOSApp\/(\d+\.\d+\.\d+)/.exec(userAgent)?.[1] ?? "0";
}

/** เทียบเวอร์ชันแบบ semver ธรรมดา — คืน true เมื่อ `installed` เก่ากว่า `latest` */
export function isOutdated(installed: string, latest: string): boolean {
  const toParts = (value: string) => value.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const [a, b] = [toParts(installed), toParts(latest)];
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left < right;
  }
  return false;
}

/** แอป iOS ใช้ UA เดียวกัน แต่ห้ามชวนโหลด APK — แยกด้วยตัว UA ของระบบปฏิบัติการ */
export function isAndroidApp(userAgent: string): boolean {
  return userAgent.includes("StoreOSApp") && userAgent.includes("Android");
}
