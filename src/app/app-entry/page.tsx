import { landingPathsForCurrentUser } from "@/modules/auth/guards";
import { DeviceAwareEntry } from "./DeviceAwareEntry";

export const dynamic = "force-dynamic";

/**
 * จุดเข้าของแอปมือถือ (Capacitor): middleware redirect มาที่นี่เมื่อเปิดแอปที่ /
 * พร้อม session — server resolve หน้าแรกตามสิทธิ์ต่ออุปกรณ์ (F0 · Task 4)
 * แล้วให้ client เลือกด้วย matchMedia ครั้งเดียว ไม่เดา viewport บน server
 */
export default async function AppEntryPage() {
  const paths = await landingPathsForCurrentUser();
  return <DeviceAwareEntry paths={paths} fallback={paths.desktop} />;
}
