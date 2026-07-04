import { redirect } from "next/navigation";
import { landingPathForCurrentUser } from "@/modules/auth/guards";

export const dynamic = "force-dynamic";

/**
 * จุดเข้าของแอปมือถือ (Capacitor): ส่งผู้ใช้ที่ล็อกอินแล้วไปหน้าแรกตามบทบาท
 * (/system สำหรับ super_admin, /dashboard หรือหน้าอื่นตามสิทธิ์) — middleware
 * เป็นคน redirect มาที่นี่เมื่อแอปเปิดที่ / พร้อม session
 */
export default async function AppEntryPage() {
  redirect(await landingPathForCurrentUser());
}
