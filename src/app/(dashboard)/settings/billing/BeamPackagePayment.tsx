"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { QrCode } from "@/shared/components/ui";
import { PLAN_LABELS } from "@/modules/billing/types";
import { DURATION_LABELS } from "@/modules/billing/pricing";
import type { BillingOrderView } from "@/modules/billing/beam-billing-types";
import { createBeamPackageAction, pendingBeamPackageAction, refreshBeamPackageAction } from "./beam-actions";

export function BeamPackagePayment({ plan, duration, businessConfigJson, discountCode, fallbackEnabled, initialOrder }: {
  plan: string; duration: string; businessConfigJson?: string; discountCode?: string;
  fallbackEnabled: boolean; initialOrder: BillingOrderView | null;
}) {
  const router = useRouter();
  const [order, setOrder] = useState(initialOrder);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [expiredOrderId, setExpiredOrderId] = useState<string | null>(null);
  const refreshing = useRef(false);
  const active = order?.status === "pending" || order?.status === "creating";
  const paid = order?.status === "paid" || order?.status === "test_paid";
  const expired = Boolean(order && expiredOrderId === order.id);

  useEffect(() => {
    if (!order) return;
    const timer = setTimeout(() => setExpiredOrderId(order.id), Math.max(0, Date.parse(order.expires_at) - Date.now()));
    return () => clearTimeout(timer);
  }, [order]);

  useEffect(() => {
    if (!order || order.method !== "beam" || (order.status !== "pending" && order.status !== "creating")) return;
    let cancelled = false;
    const timer = setInterval(async () => {
      if (refreshing.current || document.visibilityState === "hidden") return;
      refreshing.current = true;
      try {
        const next = await refreshBeamPackageAction(order.id);
        if (!cancelled) { setOrder(next); setMessage(""); if (next.status === "paid") router.refresh(); }
      } catch { if (!cancelled) setMessage("ยังตรวจผลไม่ได้ ตรวจรายการเดิมก่อนโอนซ้ำ"); }
      finally { refreshing.current = false; }
    }, 8000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [order, router]);

  async function create() {
    setBusy(true); setMessage("");
    try { setOrder(await createBeamPackageAction({ plan, duration, businessConfigJson, discountCode })); }
    catch (e) {
      setMessage(e instanceof Error ? e.message : "สร้างรายการไม่สำเร็จ");
      try { setOrder(await pendingBeamPackageAction()); } catch { /* Preserve the error and allow retry. */ }
    } finally { setBusy(false); }
  }

  async function refresh() {
    if (!order || refreshing.current) return;
    refreshing.current = true; setBusy(true);
    try { const next = await refreshBeamPackageAction(order.id); setOrder(next); setMessage(""); if (next.status === "paid") router.refresh(); }
    catch (e) { setMessage(e instanceof Error ? e.message : "ตรวจผลไม่สำเร็จ"); }
    finally { setBusy(false); refreshing.current = false; }
  }

  async function upload(file: File) {
    if (!order) return;
    setBusy(true); setMessage("");
    const fd = new FormData(); fd.set("billingOrderId", order.id); fd.set("slip", file);
    try {
      const res = await fetch("/api/billing/verify-slip", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok || !data.order) throw new Error(data.error ?? "ตรวจสลิปไม่สำเร็จ");
      setOrder(data.order); if (data.order.status === "paid") router.refresh();
    } catch (e) { setMessage(e instanceof Error ? e.message : "ตรวจสลิปไม่สำเร็จ"); }
    finally { setBusy(false); }
  }

  return <div className="mt-4 rounded-lg border border-[var(--border)] p-4 space-y-3">
    <h3 className="font-bold">ชำระแพ็กเกจ</h3>
    {paid && <button type="button" className="btn-secondary min-h-11" onClick={() => { setOrder(null); setMessage(""); }}>เริ่มรายการชำระใหม่</button>}
    {!active && !paid && <div className="flex flex-wrap gap-3">
      <button type="button" className="btn-primary min-h-11" disabled={busy} onClick={() => void create()}>ชำระแพ็กเกจ</button>
      {fallbackEnabled && <p className="text-sm text-[var(--muted)]">ระบบตรวจ Beam ก่อนเริ่ม หากไม่พร้อมจะใช้ PromptPay และตรวจสลิปให้อัตโนมัติ</p>}
    </div>}
    {order && <>
      {order.method === "slip" && <p role="status" className="rounded bg-amber-50 p-3 text-amber-800">Beam ไม่พร้อมตอนตรวจระบบก่อนเริ่มรายการ จึงใช้ PromptPay แทน กรุณาแนบสลิปหลังโอน</p>}
      <p className="font-semibold">{PLAN_LABELS[order.plan]} · {DURATION_LABELS[order.duration]} · {order.amount.toLocaleString()} บาท</p>
      {order.environment === "test" && <p className="rounded bg-amber-50 p-3 text-amber-800">โหมดทดสอบ — ไม่เปิดสิทธิ์แพ็กเกจจริง {order.method === "slip" && "อย่าโอนเงินจริงเข้าบัญชีสำรองในโหมดนี้"}</p>}
      <p role="status" aria-live="polite">{order.status === "paid" ? `ชำระสำเร็จ ใช้งานได้ถึง ${new Date(order.new_expiry!).toLocaleDateString("th-TH")}` : order.status === "test_paid" ? "ทดสอบชำระสำเร็จ ไม่มีการต่ออายุจริง" : order.status === "failed" ? "รายการไม่สำเร็จหรือปิดแล้ว หากโอนแล้วติดต่อผู้ดูแลก่อนจ่ายใหม่" : "รอยืนยันการชำระเงิน"}</p>
      {active && <>
        {expired ? <p className="text-amber-800">QR หมดเวลาแล้ว หากชำระแล้วให้ตรวจรายการเดิมหรือส่งสลิป</p> : order.qr_payload ? <div className="flex justify-center"><QrCode value={order.qr_payload} /></div> : order.qr_image ?
          // eslint-disable-next-line @next/next/no-img-element -- provider-generated inline QR
          <img src={`data:image/png;base64,${order.qr_image}`} alt="QR ชำระค่าแพ็กเกจ" width={240} height={240} className="mx-auto max-w-full" /> : null}
        <p className="text-sm">QR ใช้ได้ถึง {new Date(order.expires_at).toLocaleString("th-TH")}</p>
        <p className="text-sm text-amber-800">มีรายการค้างอยู่ กรุณาชำระหรือตรวจรายการนี้ก่อนสร้างรายการใหม่ หากโอนแล้วอย่าโอนซ้ำ</p>
        {order.method === "beam" ? <button type="button" className="btn-secondary min-h-11" disabled={busy} onClick={() => void refresh()}>ตรวจสถานะอีกครั้ง</button> : <>
          <label className="block">อัปโหลดสลิปเพื่อยืนยัน<input className="block mt-2 max-w-full" type="file" accept="image/png,image/jpeg,image/webp" disabled={busy} onChange={(e) => { const file = e.target.files?.[0]; if (file) void upload(file); e.target.value = ""; }} /></label>
          {expired && <button type="button" className="btn-secondary min-h-11" disabled={busy} onClick={() => void refresh()}>ยังไม่ได้โอน — ปิดรายการหมดอายุ</button>}
        </>}
      </>}
    </>}
    {busy && <p role="status">{order ? "กำลังดำเนินการ…" : "กำลังตรวจระบบก่อนเริ่มชำระเงิน…"}</p>}
    {message && <p role="alert" className="text-red-700">{message}</p>}
  </div>;
}
