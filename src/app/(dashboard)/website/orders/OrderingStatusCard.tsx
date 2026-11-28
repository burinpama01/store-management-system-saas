"use client";

import { useState, useTransition } from "react";
import { PAUSE_PRESETS, PAUSE_PRESET_LABEL, type PausePreset } from "@/modules/online-orders/hours";
import { extendTodayAction, pauseOrderingAction, resumeOrderingAction } from "./hours-actions";

const EXTEND_TIMES = ["22:00", "23:00", "00:00", "01:00", "02:00"];
const extendLabel = (t: string) => (t === "00:00" ? "เที่ยงคืน" : t === "01:00" ? "ตีหนึ่ง" : t === "02:00" ? "ตีสอง" : `${t} น.`);

/** สถานะรับออเดอร์ + ปิดรับด่วน (ไฟดับ/ของหมด) — พนักงานจัดการออเดอร์กดได้ · ขยายเวลาวันนี้เฉพาะเจ้าของ/แอดมิน */
export function OrderingStatusCard({
  switchEnabled,
  open,
  paused,
  title,
  detail,
  hoursEnabled,
  canManageHours,
}: {
  switchEnabled: boolean;
  open: boolean;
  paused: boolean;
  title: string;
  detail: string | null;
  hoursEnabled: boolean;
  canManageHours: boolean;
}) {
  const [preset, setPreset] = useState<PausePreset>("1h");
  const [reason, setReason] = useState("");
  const [extendTo, setExtendTo] = useState("00:00");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const run = (fn: () => Promise<{ ok: boolean; error: string | null }>, okText: string) => {
    setMessage(null);
    startTransition(async () => {
      const res = await fn();
      setMessage(res.ok ? { ok: true, text: okText } : { ok: false, text: res.error ?? "ไม่สำเร็จ" });
      if (res.ok) setReason("");
    });
  };

  if (!switchEnabled) {
    return (
      <section className="panel p-4 text-sm">
        <p className="font-semibold">⚪ ยังไม่เปิดรับสั่งออนไลน์</p>
        <p className="text-[var(--muted)]">เปิดสวิตช์ “เปิดรับสั่งออนไลน์” ในตั้งค่าด้านล่างก่อน</p>
      </section>
    );
  }

  return (
    <section className="panel space-y-3 p-4 text-sm" aria-live="polite">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className={`text-base font-semibold ${open ? "text-emerald-700" : "text-red-700"}`}>
            {open ? "🟢" : "🔴"} {open ? "กำลังรับออเดอร์ออนไลน์" : title}
          </p>
          {detail && <p className="text-[var(--muted)]">{detail}</p>}
          {!hoursEnabled && open && <p className="text-xs text-[var(--muted)]">ยังไม่ได้ตั้งเวลาทำการ — รับตลอด 24 ชม.</p>}
        </div>
        {paused && (
          <button type="button" className="btn-primary min-h-10" disabled={pending} onClick={() => run(resumeOrderingAction, "เปิดรับออเดอร์กลับแล้ว")}>
            เปิดรับกลับตอนนี้
          </button>
        )}
      </div>

      {!paused && (
        <div className="space-y-2 rounded-lg border border-red-200 bg-red-50/50 p-3">
          <p className="font-medium text-red-800">ปิดรับด่วน (ไฟดับ ของหมด คนไม่พอ)</p>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="ปิดรับนานเท่าไร">
            {PAUSE_PRESETS.map((p) => (
              <button
                key={p}
                type="button"
                role="radio"
                aria-checked={preset === p}
                onClick={() => setPreset(p)}
                className={`rounded-lg border px-3 py-1.5 ${preset === p ? "border-red-600 bg-white font-semibold text-red-700" : "border-[var(--border)] bg-white"}`}
              >
                {PAUSE_PRESET_LABEL[p]}
              </button>
            ))}
          </div>
          <input
            className="input w-full"
            style={{ fontSize: 16 }}
            maxLength={120}
            placeholder="เหตุผลที่ลูกค้าจะเห็น (ไม่บังคับ) เช่น ไฟดับ ขออภัยค่ะ"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <button
            type="button"
            className="min-h-10 rounded-lg bg-red-600 px-4 font-semibold text-white disabled:opacity-60"
            disabled={pending}
            onClick={() => run(() => pauseOrderingAction(preset, reason), `ปิดรับแล้ว (${PAUSE_PRESET_LABEL[preset]})`)}
          >
            {pending ? "กำลังบันทึก…" : "ปิดรับออเดอร์ตอนนี้"}
          </button>
          <p className="text-xs text-[var(--muted)]">ออเดอร์ที่จ่ายแล้วยังอยู่ในคิว · ลูกค้าดูเมนูได้แต่สั่งไม่ได้จนกว่าจะเปิดกลับ</p>
        </div>
      )}

      {canManageHours && hoursEnabled && (
        <div className="flex flex-wrap items-center gap-2">
          <span>วันนี้มี OT เปิดยาวถึง</span>
          <select className="input" style={{ fontSize: 16 }} value={extendTo} onChange={(e) => setExtendTo(e.target.value)} aria-label="เปิดถึงกี่โมง">
            {EXTEND_TIMES.map((t) => (
              <option key={t} value={t}>
                {extendLabel(t)}
              </option>
            ))}
          </select>
          <button type="button" className="btn-secondary min-h-10" disabled={pending} onClick={() => run(() => extendTodayAction(extendTo), `วันนี้รับออเดอร์ถึง${extendLabel(extendTo)}แล้ว`)}>
            ขยายเวลาวันนี้
          </button>
        </div>
      )}

      {message && (
        <p role="status" className={message.ok ? "alert-success" : "rounded-lg bg-red-50 p-2 text-red-700"}>
          {message.text}
        </p>
      )}
    </section>
  );
}
