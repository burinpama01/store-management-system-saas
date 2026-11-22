import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1"],
  experimental: {
    // รูปหลักฐาน (บิลซื้อ/เช็กลิสต์) ส่งผ่าน server action — ค่าเริ่มต้น 1MB เล็กไป · Vercel รับ body ได้ ~4.5MB
    serverActions: { bodySizeLimit: "4mb" },
  },
};

export default nextConfig;
