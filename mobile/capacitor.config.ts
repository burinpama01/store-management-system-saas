import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.storeos.app",
  appName: "StoreOS",
  // middleware ฝั่งเว็บใช้ marker นี้แยกทราฟฟิกจากแอป (เช่น redirect / → เข้าระบบทันที)
  appendUserAgent: "StoreOSApp",
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
