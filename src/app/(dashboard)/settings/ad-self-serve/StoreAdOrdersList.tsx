"use client";

import { useState, useTransition } from "react";
import { STORE_AD_STATUS_LABEL, type StoreAdOrder, type StoreAdReviewAction } from "@/modules/ad-self-serve/orders";
import { useConfirm } from "@/shared/components/ui/useConfirm";
import { reviewStoreAdOrderAction } from "./actions";

const baht = (n: number) => `${n.toLocaleString("th-TH", { maximumFractionDigits: 2 })} ฿`;
const thDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("th-TH", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" }) : "-";

const TONE: Record<string, string> = {
  active: "bg-emerald-50 text-emerald-700 border-emerald-200",
  pending_review: "bg-amber-50 text-amber-800 border-amber-200",
};

/** โฆษณาที่ลูกค้าลง — ดูตัวอย่าง/ผู้ลง/หลักฐานจ่าย + อนุมัติ/ไม่อนุมัติ/ถอด 1 แตะ */
export function StoreAdOrdersList({ orders }: { orders: StoreAdOrder[] }) {
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const { confirm, confirmDialog } = useConfirm();
  // เวลาตอนเปิดหน้า (หน้า revalidate หลังกดทุกครั้ง) — ไม่เรียก Date.now() ทุกรอบ render
  const [nowMs] = useState(() => Date.now());

  function run(order: StoreAdOrder, action: StoreAdReviewAction) {
    startTransition(async () => {
      if (action !== "approve") {
        const ok = await confirm({
          title: action === "remove" ? "ถอดโฆษณานี้ออกจากจอ?" : "ไม่อนุมัติโฆษณานี้?",
          message: `${order.advertiserName} · ${order.packageName} ${baht(order.amount)} — เงินอยู่ที่ร้าน ร้านติดต่อคืนเงินเอง`,
          confirmLabel: action === "remove" ? "ถอดออก" : "ไม่อนุมัติ",
          cancelLabel: "กลับ",
          danger: true,
        });
        if (!ok) return;
      }
      const reason = action === "approve" ? undefined : action === "remove" ? "ร้านถอดโฆษณา" : "ร้านไม่อนุมัติ";
      const result = await reviewStoreAdOrderAction({ orderId: order.id, action, reason });
      setMessage(result.error ?? (action === "approve" ? "อนุมัติแล้ว — ขึ้นจอภายในไม่กี่นาที" : "บันทึกแล้ว"));
    });
  }

  return (
    <section className="section-card space-y-3">
      <div>
        <h2 className="font-semibold text-[var(--text)]">โฆษณาที่ลูกค้าลง</h2>
        <p className="text-xs text-[var(--muted)]">ถอดได้ทันที จอลูกค้าอัปเดตภายใน 5 นาที · เงินค่าโฆษณาอยู่ในบัญชีร้าน (คืนเงินร้านจัดการเอง)</p>
      </div>
      {message ? (
        <p className="alert-success text-sm" role="status">
          {message}
        </p>
      ) : null}
      {orders.length === 0 ? (
        <p className="rounded-lg bg-[var(--surface-muted)] p-3 text-sm text-[var(--muted)]">ยังไม่มีโฆษณาที่จ่ายแล้ว</p>
      ) : (
        <ul className="space-y-3">
          {orders.map((order) => {
            const live = order.status === "active" && order.endsAt !== null && Date.parse(order.endsAt) > nowMs;
            return (
              <li key={order.id} className="flex flex-col gap-3 rounded-lg border border-[var(--border)] p-3 sm:flex-row">
                <div className="h-32 w-full shrink-0 overflow-hidden rounded-md bg-black sm:w-48">
                  {order.mediaUrl && order.mediaType === "video" ? (
                    <video src={order.mediaUrl} className="h-full w-full object-contain" muted playsInline controls preload="metadata" />
                  ) : order.mediaUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element -- สื่อของผู้ลงโฆษณา
                    <img src={order.mediaUrl} alt={`โฆษณาของ ${order.advertiserName}`} className="h-full w-full object-contain" />
                  ) : (
                    <p className="flex h-full items-center justify-center text-xs text-white/70">ไฟล์ถูกลบแล้ว</p>
                  )}
                </div>
                <div className="min-w-0 flex-1 space-y-1 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${TONE[order.status] ?? "border-[var(--border)] text-[var(--muted)]"}`}>
                      {order.status === "active" && !live ? "หมดอายุแล้ว" : STORE_AD_STATUS_LABEL[order.status]}
                    </span>
                    <span className="font-semibold text-[var(--text)]">
                      {order.packageName} · {baht(order.amount)}
                    </span>
                  </div>
                  <p className="text-[var(--text)]">
                    {order.advertiserName} ·{" "}
                    <a href={`tel:${order.advertiserPhone}`} className="underline">
                      {order.advertiserPhone}
                    </a>
                  </p>
                  <p className="text-xs text-[var(--muted)]">
                    จ่าย {order.paymentMethod === "beam" ? "Beam" : order.paymentMethod === "slip" ? "สลิป" : "-"} {thDate(order.paidAt)}
                    {order.paymentRef ? ` · อ้างอิง ${order.paymentRef}` : ""}
                  </p>
                  {order.startsAt ? (
                    <p className="text-xs text-[var(--muted)]">
                      แสดง {thDate(order.startsAt)} – {thDate(order.endsAt)}
                    </p>
                  ) : null}
                  {order.statusReason ? <p className="text-xs text-[var(--muted)]">หมายเหตุ: {order.statusReason}</p> : null}
                  <div className="flex flex-wrap gap-2 pt-1">
                    {order.status === "pending_review" ? (
                      <>
                        <button type="button" className="btn-primary min-h-9 text-sm" disabled={pending} onClick={() => run(order, "approve")}>
                          อนุมัติขึ้นจอ
                        </button>
                        <button type="button" className="btn-secondary min-h-9 text-sm" disabled={pending} onClick={() => run(order, "reject")}>
                          ไม่อนุมัติ
                        </button>
                      </>
                    ) : null}
                    {live ? (
                      <button type="button" className="btn-secondary min-h-9 text-sm text-red-700" disabled={pending} onClick={() => run(order, "remove")}>
                        ถอดออก
                      </button>
                    ) : null}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {confirmDialog}
    </section>
  );
}
