/**
 * เวอร์ชันของโปรแกรม StoreOS POS (Windows, พิมพ์ตรง IP) ที่ลิงก์ดาวน์โหลดบนเว็บแจกอยู่
 *
 * ต้องตรงกับ <Version> ใน windows/StoreOS.PosLauncher/StoreOS.PosLauncher.csproj (มีเทสต์บังคับ)
 * ไฟล์ zip อยู่บน GitHub Releases tag `pos-launcher-v<เวอร์ชัน>` (ไฟล์ 66MB เกินเพดาน Supabase storage)
 * ปล่อยรุ่นใหม่ = build zip → สร้าง release ให้เสร็จก่อน → ขยับค่าชุดนี้ → deploy เว็บ
 */
export const POS_LAUNCHER_VERSION = "1.2.0";

/** SHA-256 (hex) ของ storeos-pos-launcher-<เวอร์ชัน>.zip บน release จริง — ให้ร้าน/ซัพพอร์ตตรวจไฟล์ได้ */
export const POS_LAUNCHER_SHA256 = "1b8dc190e82845044c4d35086142c0baa1e404b1fa326a0110810480217b2c54";

export const POS_LAUNCHER_SIZE_BYTES = 66_394_646;

export const POS_LAUNCHER_RELEASE_BASE =
  "https://github.com/burinpama01/store-management-system-saas/releases/download";

export function posLauncherDownloadUrl(version: string = POS_LAUNCHER_VERSION): string {
  return `${POS_LAUNCHER_RELEASE_BASE}/pos-launcher-v${version}/storeos-pos-launcher-${version}.zip`;
}
