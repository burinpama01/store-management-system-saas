import type { Metadata } from "next";
import { DeviceLoginQr } from "./DeviceLoginQr";

export const metadata: Metadata = { title: "เข้าใช้ด้วย QR — StoreOS" };

/** หน้าสาธารณะบนเครื่องร้าน: แสดง QR ให้พนักงานสแกนด้วยมือถือ (ไม่ต้องพิมพ์อีเมล/รหัสผ่านบนเครื่องร้าน) */
export default async function DeviceLoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  return (
    <main className="flex min-h-screen items-center justify-center bg-[var(--canvas,#f6f4f1)] p-4">
      <DeviceLoginQr initialError={error === "expired" ? "ตั๋วเข้าใช้หมดอายุ — สแกน QR ใหม่อีกครั้ง" : error === "failed" ? "เข้าใช้ไม่สำเร็จ ลองใหม่อีกครั้ง" : null} />
    </main>
  );
}
