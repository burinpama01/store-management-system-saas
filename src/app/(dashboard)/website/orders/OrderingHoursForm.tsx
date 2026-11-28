"use client";

import { useState, useTransition } from "react";
import { DAY_LABELS, MAX_HOURS_EXCEPTIONS, type HoursException, type OrderingHours } from "@/modules/online-orders/hours";
import { saveOrderingHoursAction } from "./hours-actions";

// iOS ซูมเมื่อ font < 16px — ใส่ inline ตามที่ใช้ทั้งโปรเจกต์
const INPUT_STYLE = { fontSize: 16 } as const;

const crossesMidnight = (open: string, close: string) => close <= open;
const rangeHint = (open: string, close: string) =>
  open === close ? "24 ชม." : close === "00:00" ? "ถึงเที่ยงคืน" : crossesMidnight(open, close) ? "ข้ามเที่ยงคืน" : null;

/** ตั้งเวลารับออเดอร์ประจำสัปดาห์ + วันหยุด/เวลาพิเศษล่วงหน้า (เจ้าของ/แอดมิน) */
export function OrderingHoursForm({ initial, today }: { initial: OrderingHours; today: string }) {
  const [hours, setHours] = useState<OrderingHours>(initial);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const [newDate, setNewDate] = useState("");

  const setDay = (i: number, patch: Partial<OrderingHours["weekly"][number]>) =>
    setHours((h) => ({ ...h, weekly: h.weekly.map((d, idx) => (idx === i ? { ...d, ...patch } : d)) }));
  const setException = (date: string, patch: Partial<HoursException>) =>
    setHours((h) => ({ ...h, exceptions: h.exceptions.map((e) => (e.date === date ? { ...e, ...patch } : e)) }));
  const removeException = (date: string) => setHours((h) => ({ ...h, exceptions: h.exceptions.filter((e) => e.date !== date) }));
  const copyToAll = (i: number) => setHours((h) => ({ ...h, weekly: h.weekly.map(() => ({ ...h.weekly[i] })) }));

  const addException = (closed: boolean) => {
    setMessage(null);
    if (!newDate) return setMessage({ ok: false, text: "เลือกวันที่ก่อน" });
    if (newDate < today) return setMessage({ ok: false, text: "เลือกวันนี้หรือวันถัดไป" });
    if (hours.exceptions.some((e) => e.date === newDate)) return setMessage({ ok: false, text: "มีวันนี้ในรายการแล้ว — แก้ในรายการได้เลย" });
    if (hours.exceptions.length >= MAX_HOURS_EXCEPTIONS) return setMessage({ ok: false, text: `วันพิเศษได้ไม่เกิน ${MAX_HOURS_EXCEPTIONS} วัน` });
    const dow = new Date(`${newDate}T00:00:00Z`).getUTCDay();
    const base = hours.weekly[dow];
    setHours((h) => ({
      ...h,
      exceptions: [...h.exceptions, { date: newDate, closed, open: base.open, close: base.close, note: closed ? "วันหยุด" : "" }].sort((a, b) => a.date.localeCompare(b.date)),
    }));
    setNewDate("");
  };

  const save = () => {
    setMessage(null);
    startTransition(async () => {
      const res = await saveOrderingHoursAction(hours);
      setMessage(res.ok ? { ok: true, text: "บันทึกเวลารับออเดอร์แล้ว" } : { ok: false, text: res.error ?? "บันทึกไม่สำเร็จ" });
    });
  };

  const thDate = (d: string) =>
    new Date(`${d}T00:00:00Z`).toLocaleDateString("th-TH", { weekday: "short", day: "numeric", month: "short", year: "2-digit", timeZone: "UTC" });

  return (
    <section className="panel space-y-4 p-4 text-sm">
      <div>
        <h2 className="text-base font-semibold">เวลารับออเดอร์ออนไลน์</h2>
        <p className="text-[var(--muted)]">นอกเวลา ลูกค้าดูเมนูได้แต่สั่ง/จ่ายไม่ได้ · เวลาปิดน้อยกว่าเวลาเปิด = ข้ามเที่ยงคืน (เช่น 18:00–02:00) · 00:00 = ถึงเที่ยงคืน</p>
      </div>
      <label className="flex items-center gap-2 font-medium">
        <input type="checkbox" checked={hours.enabled} onChange={(e) => setHours((h) => ({ ...h, enabled: e.target.checked }))} />
        ใช้เวลาทำการ (ไม่ติ๊ก = รับออเดอร์ตลอด 24 ชม.)
      </label>

      <fieldset className="space-y-2" disabled={!hours.enabled}>
        <legend className="mb-1 font-medium">เวลาประจำสัปดาห์</legend>
        {hours.weekly.map((d, i) => (
          <div key={i} className={`flex flex-wrap items-center gap-2 rounded-lg border border-[var(--border)] p-2 ${hours.enabled ? "" : "opacity-50"}`}>
            <span className="w-16 font-medium">{DAY_LABELS[i]}</span>
            <label className="flex items-center gap-1">
              <input type="checkbox" checked={d.closed} onChange={(e) => setDay(i, { closed: e.target.checked })} />
              หยุด
            </label>
            {!d.closed && (
              <>
                <input type="time" className="input" style={INPUT_STYLE} value={d.open} onChange={(e) => setDay(i, { open: e.target.value })} aria-label={`${DAY_LABELS[i]} เปิด`} />
                <span>–</span>
                <input type="time" className="input" style={INPUT_STYLE} value={d.close} onChange={(e) => setDay(i, { close: e.target.value })} aria-label={`${DAY_LABELS[i]} ปิด`} />
                {rangeHint(d.open, d.close) && <span className="text-xs text-amber-700">{rangeHint(d.open, d.close)}</span>}
              </>
            )}
            <button type="button" className="ml-auto text-xs text-[var(--muted)] underline" onClick={() => copyToAll(i)}>
              ใช้กับทุกวัน
            </button>
          </div>
        ))}
      </fieldset>

      <fieldset className="space-y-2" disabled={!hours.enabled}>
        <legend className="mb-1 font-medium">วันหยุด / เวลาพิเศษล่วงหน้า</legend>
        <p className="text-xs text-[var(--muted)]">ใช้แทนเวลาประจำสัปดาห์ของวันนั้น เช่น หยุดสงกรานต์ หรือวันเคาท์ดาวน์เปิดถึงตีสอง · วันที่ผ่านไปแล้วระบบลบให้เอง</p>
        <div className={`flex flex-wrap items-center gap-2 ${hours.enabled ? "" : "opacity-50"}`}>
          <input type="date" className="input" style={INPUT_STYLE} min={today} value={newDate} onChange={(e) => setNewDate(e.target.value)} aria-label="วันที่" />
          <button type="button" className="btn-secondary min-h-10" onClick={() => addException(true)}>
            + วันหยุด
          </button>
          <button type="button" className="btn-secondary min-h-10" onClick={() => addException(false)}>
            + เวลาพิเศษ
          </button>
        </div>
        {hours.exceptions.length === 0 ? (
          <p className="text-xs text-[var(--muted)]">ยังไม่มีวันพิเศษ</p>
        ) : (
          <ul className="space-y-2">
            {hours.exceptions.map((e) => (
              <li key={e.date} className={`flex flex-wrap items-center gap-2 rounded-lg border p-2 ${e.closed ? "border-red-200 bg-red-50/40" : "border-amber-200 bg-amber-50/40"}`}>
                <span className="min-w-28 font-medium">
                  {thDate(e.date)}
                  {e.date === today ? " (วันนี้)" : ""}
                </span>
                <select
                  className="input"
                  style={INPUT_STYLE}
                  value={e.closed ? "closed" : "open"}
                  onChange={(ev) => setException(e.date, { closed: ev.target.value === "closed" })}
                  aria-label="หยุดหรือเปิด"
                >
                  <option value="closed">หยุดทั้งวัน</option>
                  <option value="open">เปิดเวลาพิเศษ</option>
                </select>
                {!e.closed && (
                  <>
                    <input type="time" className="input" style={INPUT_STYLE} value={e.open} onChange={(ev) => setException(e.date, { open: ev.target.value })} aria-label="เปิด" />
                    <span>–</span>
                    <input type="time" className="input" style={INPUT_STYLE} value={e.close} onChange={(ev) => setException(e.date, { close: ev.target.value })} aria-label="ปิด" />
                    {rangeHint(e.open, e.close) && <span className="text-xs text-amber-700">{rangeHint(e.open, e.close)}</span>}
                  </>
                )}
                <input
                  className="input min-w-0 flex-1"
                  style={INPUT_STYLE}
                  maxLength={80}
                  placeholder="หมายเหตุที่ลูกค้าเห็น"
                  value={e.note}
                  onChange={(ev) => setException(e.date, { note: ev.target.value })}
                />
                <button type="button" className="text-xs text-red-700 underline" onClick={() => removeException(e.date)}>
                  ลบ
                </button>
              </li>
            ))}
          </ul>
        )}
      </fieldset>

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="btn-primary min-h-10" onClick={save} disabled={pending}>
          {pending ? "กำลังบันทึก…" : "บันทึกเวลารับออเดอร์"}
        </button>
        {message && (
          <p role="status" className={message.ok ? "text-emerald-700" : "text-red-700"}>
            {message.text}
          </p>
        )}
      </div>
    </section>
  );
}
