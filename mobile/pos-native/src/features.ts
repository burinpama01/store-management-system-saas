// Build-time feature set. Never read these from the server or OTA: App Review treats
// remotely unlocked functionality as hidden features (guidelines 2.3.1 / 2.5.2).
// Enabling a feature means shipping a new build through review.
export const FEATURES = {
  ai: false,
  delivery: false,
  bluetoothPrinter: false,
  lanPrinter: true,
  demoMode: false,
  serverOverride: false,
} as const;

export const LEGAL_LINKS = [
  ['นโยบายความเป็นส่วนตัว', 'https://www.store-os.online/privacy-policy'],
  ['ข้อกำหนดการใช้งาน', 'https://www.store-os.online/terms-of-service'],
  ['ขอลบบัญชีและข้อมูล', 'https://www.store-os.online/account-deletion'],
] as const;
