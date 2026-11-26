import type { Metadata } from "next";
import { headers } from "next/headers";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { getDeviceLoginRequest, hashClientIp, maskEmail } from "@/modules/auth/device-login";
import { ApproveDeviceForm } from "./ApproveDeviceForm";

export const metadata: Metadata = { title: "อนุญาตให้เครื่องเข้าใช้ — StoreOS" };
export const dynamic = "force-dynamic";

/**
 * หน้าบนมือถือพนักงาน (ต้องล็อกอิน — middleware พาไป /login แล้วกลับมาที่นี่)
 * แสดงเครื่องที่ขอ + รหัสบนจอให้เทียบ + เตือนถ้าอยู่คนละเครือข่าย แล้วให้กรอกรหัสพนักงานเพื่ออนุมัติ
 */
export default async function ApproveDevicePage({ searchParams }: { searchParams: Promise<{ r?: string; c?: string }> }) {
  const { r, c } = await searchParams;
  const { user, ctx } = await getResolvedCurrentPermissions();
  const h = await headers();
  const request = r ? await getDeviceLoginRequest(r, hashClientIp(h.get("x-forwarded-for"), h.get("x-real-ip"))) : null;

  return (
    <main className="flex min-h-screen items-start justify-center bg-[var(--canvas,#f6f4f1)] p-4 pt-10">
      <section className="w-full max-w-sm rounded-2xl border border-[var(--border,#e6dfd8)] bg-white p-5 shadow-sm">
        <h1 className="text-lg font-bold text-gray-900">อนุญาตให้เครื่องนี้เข้าใช้?</h1>
        {!request ? (
          <p className="mt-3 text-sm text-red-600">ไม่พบคำขอ — สแกน QR จากเครื่องร้านอีกครั้ง</p>
        ) : request.status !== "pending" ? (
          <p className="mt-3 text-sm text-red-600">
            {request.status === "expired" ? "QR หมดอายุแล้ว — ให้เครื่องร้านสร้าง QR ใหม่" : "คำขอนี้ใช้ไปแล้วหรือถูกยกเลิก"}
          </p>
        ) : (
          <>
            {/* กันส่ง QR หลอกทางแชต: คนที่ได้รับอนุญาตจะได้บัญชีของคุณบนเครื่องนั้น */}
            <div className="mt-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
              <b>อนุญาตเฉพาะเครื่องที่อยู่ตรงหน้าคุณเท่านั้น</b>
              <br />
              ถ้าได้ QR นี้จาก LINE / ข้อความ / อีเมล หรือไม่เห็นรหัสเดียวกันบนจอเครื่องร้าน — อย่ากดอนุญาต
            </div>
            {request.sameNetwork === false && (
              <p className="mt-2 rounded-lg bg-red-50 p-2 text-sm font-semibold text-red-700">
                ⚠️ มือถือนี้กับเครื่องที่ขออยู่คนละเครือข่าย — ถ้าคุณไม่ได้ยืนอยู่หน้าเครื่องนั้น อย่าอนุญาต
                (ถ้ามือถือใช้เน็ตมือถือ ลองต่อ WiFi ร้านแล้วสแกนใหม่)
              </p>
            )}
            {request.sameNetwork === true && (
              <p className="mt-2 rounded-lg bg-emerald-50 p-2 text-sm text-emerald-800">✓ มือถือกับเครื่องที่ขออยู่เครือข่ายเดียวกัน</p>
            )}
            <div className="mt-3 rounded-xl border border-gray-200 p-3 text-sm">
              <p className="font-semibold text-gray-900">🖥 {request.deviceLabel ?? "อุปกรณ์ไม่ระบุชื่อ"}</p>
              <p className="text-gray-600">สาขา: {ctx.storeName}</p>
              <p className="text-gray-600">
                รหัสบนจอเครื่องร้าน: <b className="tracking-widest text-gray-900">{request.shortCode}</b>
              </p>
              {c && c.toUpperCase() !== request.shortCode && (
                <p className="mt-1 font-semibold text-red-600">รหัสใน QR ไม่ตรงกับคำขอ — อย่าอนุญาต</p>
              )}
            </div>
            <p className="mt-3 text-sm text-gray-700">
              เข้าใช้ในชื่อ: <b>{maskEmail(user.email)}</b>
            </p>
            <ApproveDeviceForm requestId={request.id} shortCode={request.shortCode} />
          </>
        )}
      </section>
    </main>
  );
}
