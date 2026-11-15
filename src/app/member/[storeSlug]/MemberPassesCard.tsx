"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { QrCode } from "@/shared/components/ui/QrCode";
import type { MemberPassesView, MemberPortalPlan } from "@/modules/prepaid-passes/member-portal";
import { formatPassExpiry } from "@/modules/prepaid-passes/rules";
import { cancelPassPurchaseAction, checkPassPurchaseAction, startPassPurchaseAction } from "./actions";

const money = (value: number) => new Intl.NumberFormat("th-TH", { maximumFractionDigits: 2 }).format(value);
/** ถามสถานะทุก 4 วินาทีเฉพาะตอนเปิดหน้าจ่าย (server ยิง Beam ไม่ถี่กว่า 10 วินาที) — หยุดเมื่อจ่าย/ยกเลิก/หมดเวลา */
const POLL_MS = 4000;
const POLL_LIMIT_MS = 11 * 60 * 1000;

interface PendingPurchase {
  purchaseId: string;
  planName: string;
  amount: number;
  qrPayload: string | null;
  qrImageBase64: string | null;
  startedAt: number;
}

const STATUS_LABEL: Record<string, string> = {
  active: "ใช้ได้",
  expired: "หมดอายุ",
  voided: "ยกเลิก",
};

export function MemberPassesCard({
  storeSlug,
  portalCode,
  view,
}: {
  storeSlug: string;
  portalCode: string;
  view: MemberPassesView;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<MemberPortalPlan | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [pending, setPending] = useState<PendingPurchase | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const pollingRef = useRef(false);

  function form(extra: Record<string, string>) {
    const data = new FormData();
    data.set("storeSlug", storeSlug);
    data.set("portalCode", portalCode);
    for (const [key, value] of Object.entries(extra)) data.set(key, value);
    return data;
  }

  useEffect(() => {
    if (!pending) return;
    let alive = true;
    const timer = window.setInterval(() => {
      if (!alive || pollingRef.current) return;
      if (Date.now() - pending.startedAt > POLL_LIMIT_MS) {
        window.clearInterval(timer);
        setMessage("QR หมดเวลา — ถ้าจ่ายไปแล้ว แพ็กจะเข้าบัญชีเองภายในไม่กี่นาที");
        setPending(null);
        return;
      }
      pollingRef.current = true;
      void checkPassPurchaseAction(form({ purchaseId: pending.purchaseId }))
        .then((result) => {
          if (!alive) return;
          if (result.status === "paid") {
            setMessage(`ซื้อ${pending.planName}สำเร็จ แพ็กเข้าบัญชีแล้ว`);
            setPending(null);
            router.refresh();
          } else if (result.status === "failed" || result.status === "review") {
            setMessage(result.error);
            setPending(null);
          }
        })
        .finally(() => {
          pollingRef.current = false;
        });
    }, POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- form() อ่านค่า prop ที่ไม่เปลี่ยนระหว่างจ่าย
  }, [pending, router]);

  function buy() {
    if (!selected) return;
    if (!accepted) {
      setMessage("กรุณาอ่านและติ๊กยอมรับเงื่อนไขก่อนซื้อ");
      return;
    }
    setMessage(null);
    startTransition(async () => {
      const result = await startPassPurchaseAction(form({ planId: selected.id, termsAccepted: "yes" }));
      if (result.error || !result.purchaseId || !result.qr) {
        setMessage(result.error ?? "เริ่มซื้อแพ็กไม่สำเร็จ");
        return;
      }
      setPending({
        purchaseId: result.purchaseId,
        planName: result.planName ?? selected.name,
        amount: result.qr.amount,
        qrPayload: result.qr.qrPayload,
        qrImageBase64: result.qr.qrImageBase64,
        startedAt: Date.now(),
      });
      setSelected(null);
      setAccepted(false);
    });
  }

  function cancel() {
    if (!pending) return;
    const purchaseId = pending.purchaseId;
    startTransition(async () => {
      const result = await cancelPassPurchaseAction(form({ purchaseId }));
      setPending(null);
      setMessage(result.error ?? "ยกเลิกการซื้อแล้ว — ถ้าจ่ายไปก่อนกดยกเลิก แพ็กจะเข้าบัญชีตามปกติ");
      // เงินอาจเข้าก่อนกดยกเลิก → โหลดสถานะจริงจาก server
      router.refresh();
    });
  }

  const activePasses = view.passes.filter((pass) => pass.status === "active" && pass.creditsRemaining > 0);
  const pastPasses = view.passes.filter((pass) => !(pass.status === "active" && pass.creditsRemaining > 0));

  return (
    <section className="rounded-lg border border-[var(--border)] bg-white p-5 shadow-sm" aria-label="แพ็กของฉัน">
      <h2 className="text-lg font-bold text-[var(--foreground)]">แพ็กของฉัน</h2>

      {activePasses.length === 0 ? (
        <p className="mt-1 text-sm text-[var(--muted)]">ยังไม่มีแพ็กที่ใช้ได้</p>
      ) : (
        <div className="mt-3 space-y-2">
          {activePasses.map((pass) => (
            <div key={pass.id} className="rounded-lg border border-violet-200 bg-violet-50 p-3">
              <div className="flex items-baseline justify-between gap-2">
                <p className="font-semibold text-violet-900">🎟️ {pass.planName}</p>
                <p className="text-lg font-black tabular-nums text-violet-900">
                  {pass.creditsRemaining}
                  <span className="text-sm font-semibold text-violet-700">/{pass.creditsTotal}</span>
                </p>
              </div>
              <p className="text-xs text-violet-700">
                {formatPassExpiry(pass.expiresAt)} · {pass.redeemScope === "org" ? "ใช้ได้ทุกสาขา" : "ใช้ได้เฉพาะสาขาที่ซื้อ"}
              </p>
            </div>
          ))}
          <p className="text-xs text-[var(--muted)]">ใช้สิทธิ์: กด “แสดงรหัสใช้สิทธิ์” แล้วให้แคชเชียร์สแกน</p>
        </div>
      )}

      {pending && (
        <div className="mt-4 flex flex-col items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-center">
          <p className="font-semibold text-emerald-900">สแกนจ่าย ฿{money(pending.amount)} — {pending.planName}</p>
          {pending.qrPayload ? (
            <QrCode value={pending.qrPayload} size={220} />
          ) : pending.qrImageBase64 ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={`data:image/png;base64,${pending.qrImageBase64}`} alt="QR พร้อมเพย์" width={220} height={220} />
          ) : (
            <p className="text-sm text-red-700">ไม่มีรูป QR — กดยกเลิกแล้วลองใหม่</p>
          )}
          <p className="text-xs text-emerald-800">จ่ายแล้วระบบยืนยันเองอัตโนมัติ ไม่ต้องส่งสลิป</p>
          <button type="button" className="btn-secondary text-sm" disabled={isPending} onClick={cancel}>
            ยกเลิก
          </button>
        </div>
      )}

      {!pending && view.plans.length > 0 && (
        <div className="mt-4 space-y-2">
          <p className="text-sm font-semibold text-[var(--foreground)]">
            ซื้อแพ็ก {view.canBuyOnline ? "" : "(ซื้อได้ที่เคาน์เตอร์ของร้าน)"}
          </p>
          {view.plans.map((plan) => (
            <button
              key={plan.id}
              type="button"
              disabled={!view.canBuyOnline || isPending}
              onClick={() => {
                setSelected(plan);
                setAccepted(false);
                setMessage(null);
              }}
              className={`flex w-full items-center justify-between gap-3 rounded-lg border p-3 text-left ${
                selected?.id === plan.id ? "border-violet-400 bg-violet-50" : "border-[var(--border)] bg-white"
              } disabled:opacity-60`}
            >
              <span className="min-w-0">
                <span className="block font-semibold text-[var(--foreground)]">{plan.name}</span>
                <span className="block text-xs text-[var(--muted)]">
                  {plan.credits} สิทธิ์ · {plan.validDays ? `ใช้ได้ ${plan.validDays} วันนับจากวันซื้อ` : "ไม่หมดอายุ"}
                </span>
              </span>
              <span className="shrink-0 text-lg font-black text-[var(--foreground)]">฿{money(plan.price)}</span>
            </button>
          ))}
        </div>
      )}

      {selected && !pending && (
        <div className="mt-3 space-y-3 rounded-lg border border-orange-200 bg-orange-50 p-3">
          <p className="text-sm font-semibold text-orange-900">เงื่อนไขของ {selected.name} — อ่านก่อนซื้อ</p>
          <p className="max-h-56 overflow-y-auto whitespace-pre-line text-sm text-orange-900">{selected.terms}</p>
          <label className="flex items-start gap-2 text-sm text-orange-900">
            <input type="checkbox" className="mt-1" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />
            ฉันอ่านและยอมรับเงื่อนไข รวมถึง <b>ไม่สามารถขอคืนเงินได้ทุกกรณี</b>
          </label>
          <button type="button" className="btn-primary w-full" disabled={!accepted || isPending} onClick={buy}>
            {isPending ? "กำลังสร้าง QR…" : `ยืนยันซื้อ ฿${money(selected.price)}`}
          </button>
        </div>
      )}

      {message && (
        <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-800" role="status">
          {message}
        </p>
      )}

      {pastPasses.length > 0 && (
        <details className="mt-4 text-sm">
          <summary className="cursor-pointer text-[var(--muted)]">แพ็กที่ใช้หมด/หมดอายุ ({pastPasses.length})</summary>
          <ul className="mt-2 space-y-1">
            {pastPasses.map((pass) => (
              <li key={pass.id} className="flex justify-between gap-2 text-[var(--muted)]">
                <span className="truncate">{pass.planName}</span>
                <span className="shrink-0">
                  {pass.status === "active" ? "ใช้ครบแล้ว" : STATUS_LABEL[pass.status] ?? pass.status}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
