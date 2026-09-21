import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.storeos.app",
  appName: "StoreOS",
  // middleware ฝั่งเว็บใช้ marker นี้แยกทราฟฟิกจากแอป (เช่น redirect / → เข้าระบบทันที)
  // เลขเวอร์ชันต่อท้ายเพื่อให้เว็บรู้ว่าเครื่องนี้ลงรุ่นอะไร แล้วเตือนเมื่อมีรุ่นใหม่ —
  // แอปไม่ได้อยู่บน Play Store จึงไม่มี auto-update และอัปเดตตัวเองไม่ได้
  // ต้องขึ้นเลขนี้พร้อม versionName ใน android/app/build.gradle ทุกครั้ง
  appendUserAgent: "StoreOSApp/1.0.2",
  // Stub fallback page only; the app loads the production web app below.
  webDir: "www",
  server: {
    url: "https://store-os-manage.vercel.app",
    androidScheme: "https",
  },
  ios: {
    contentInset: "always",
  },
  android: {
    allowMixedContent: false,
  },
};

export default config;
