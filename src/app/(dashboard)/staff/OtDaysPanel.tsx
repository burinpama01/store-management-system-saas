"use client";

import { useState } from "react";
import type { StoreOtDay } from "@/modules/hr/types";
import { OT_DAY_BACKDATE_LIMIT_DAYS } from "@/modules/hr/types";
import { addDaysIso, OT_DAY_MAX_RANGE_DAYS } from "@/modules/hr/ot-days";
import { Button, useConfirm } from "@/shared/components/ui";
import { saveOtDaysAction, deleteOtDayAction } from "./ot-day-actions";

export interface OtDayEmployee {
  userId: string;
  name: string;
  /** ติ๊ก "มีสิทธิ์ OT" ไว้ในข้อมูลพนักงาน — ใช้ติ๊กให้ก่อนในฟอร์ม */
  otEligible: boolean;
}

interface Props {
  otDays: StoreOtDay[];
  employees: OtDayEmployee[];
  today: string;
  /** โหมดที่บันทึกไว้ — ถ้ายังเป็น "ทุกวัน" รายการนี้ยังไม่มีผล */
  otMode: "daily" | "scheduled";
  storeMultiplier: number;
  isPending: boolean;
  run: (action: () => Promise<{ error: string | null }>, onOk?: () => void) => void;
  onNotice: (msg: string) => void;
}

const inputCls = "mt-1 w-full min-h-11 rounded-lg border border-gray-300 px-3 text-base sm:text-sm";

function thaiDate(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString("th-TH", { day: "numeric", month: "short", year: "2-digit", timeZone: "UTC" });
}

/** รวมวันที่ติดกันและตั้งค่าเหมือนกันเป็นช่วงเดียว (13–15 เม.ย.) ให้อ่านง่าย */
function groupDays(days: StoreOtDay[]): { key: string; days: StoreOtDay[] }[] {
  const sameRule = (a: StoreOtDay, b: StoreOtDay) =>
    a.capHours === b.capHours &&
    a.multiplier === b.multiplier &&
    (a.note ?? "") === (b.note ?? "") &&
    [...a.userIds].sort().join() === [...b.userIds].sort().join();
  const out: { key: string; days: StoreOtDay[] }[] = [];
  for (const d of [...days].sort((x, y) => x.date.localeCompare(y.date))) {
    const last = out[out.length - 1];
    const prev = last?.days[last.days.length - 1];
    if (prev && addDaysIso(prev.date, 1) === d.date && sameRule(prev, d)) last.days.push(d);
    else out.push({ key: d.id, days: [d] });
  }
  return out;
}

export function OtDaysPanel({ otDays, employees, today, otMode, storeMultiplier, isPending, run, onNotice }: Props) {
  const earliest = addDaysIso(today, -OT_DAY_BACKDATE_LIMIT_DAYS);
  const [showForm, setShowForm] = useState(false);
  const [dateFrom, setDateFrom] = useState(today);
  const [dateTo, setDateTo] = useState(today);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(employees.filter((e) => e.otEligible).map((e) => e.userId)));
  const [showPast, setShowPast] = useState(false);
  const [editing, setEditing] = useState<StoreOtDay | null>(null);
  /** แก้กลุ่มที่เริ่มก่อนกำหนดย้อนหลัง — วันก่อน earliest แก้ไม่ได้แล้ว */
  const [clippedFrom, setClippedFrom] = useState<string | null>(null);
  const { confirm, confirmDialog } = useConfirm();

  const nameOf = (userId: string) => employees.find((e) => e.userId === userId)?.name ?? "พนักงานที่ออกแล้ว";
  const visible = otDays.filter((d) => showPast || d.date >= earliest);
  const hiddenPast = otDays.length - otDays.filter((d) => d.date >= earliest).length;
  const groups = groupDays(visible);

  function toggle(userId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  }

  function openForm(prefill?: StoreOtDay[]) {
    if (prefill && prefill.length > 0) {
      // ช่วงที่เริ่มก่อนกำหนดย้อนหลัง แก้ได้เฉพาะส่วนที่ยังอยู่ใน 7 วัน
      setDateFrom(prefill[0].date < earliest ? earliest : prefill[0].date);
      setClippedFrom(prefill[0].date < earliest ? prefill[0].date : null);
      setDateTo(prefill[prefill.length - 1].date);
      setSelected(new Set(prefill[0].userIds));
    } else {
      setDateFrom(today);
      setDateTo(today);
      setSelected(new Set(employees.filter((e) => e.otEligible).map((e) => e.userId)));
      setClippedFrom(null);
    }
    setEditing(prefill?.[0] ?? null);
    setShowForm(true);
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      {confirmDialog}
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-bold text-gray-900">วันให้ OT</h2>
          <p className="text-xs text-gray-500">
            กำหนดวันที่ให้ OT พร้อมเพดานชั่วโมงของแต่ละวัน · วันที่ไม่อยู่ในรายการจะไม่คิด OT · ให้ย้อนหลังได้ไม่เกิน{" "}
            {OT_DAY_BACKDATE_LIMIT_DAYS} วัน และงวดที่จ่ายเงินแล้วแก้ไม่ได้
          </p>
        </div>
        {!showForm && (
          <Button type="button" variant="primary" className="min-h-11 px-4 text-sm" onClick={() => openForm()}>
            + เพิ่มวันให้ OT
          </Button>
        )}
      </div>

      {otMode !== "scheduled" && (
        <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
          ตอนนี้ร้านคิด OT แบบ “ทุกวัน” อยู่ — รายการนี้จะมีผลเมื่อเปลี่ยน “การคิด OT” ในนโยบายด้านบนเป็น “เฉพาะวันที่กำหนด”
        </p>
      )}

      {showForm && (
        <form
          action={(fd) =>
            run(
              () => saveOtDaysAction(fd),
              () => {
                setShowForm(false);
                onNotice("บันทึกวันให้ OT เรียบร้อยแล้ว");
              },
            )
          }
          className="mt-4 grid gap-3 rounded-lg border border-orange-200 bg-orange-50/40 p-3 sm:grid-cols-2"
        >
          <label className="text-xs font-medium text-gray-600">
            ตั้งแต่วันที่
            <input
              name="dateFrom"
              type="date"
              required
              min={earliest}
              value={dateFrom}
              onChange={(e) => {
                setDateFrom(e.target.value);
                if (dateTo < e.target.value) setDateTo(e.target.value);
              }}
              className={inputCls}
            />
          </label>
          <label className="text-xs font-medium text-gray-600">
            ถึงวันที่
            <input
              name="dateTo"
              type="date"
              required
              min={dateFrom || earliest}
              max={dateFrom ? addDaysIso(dateFrom, OT_DAY_MAX_RANGE_DAYS - 1) : undefined}
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className={inputCls}
            />
            <span className="mt-1 block text-[11px] font-normal text-gray-400">วันเดียวให้เลือกวันเดียวกัน · เลือกช่วงได้ ระบบสร้างให้ทีละวัน</span>
          </label>
          <label className="text-xs font-medium text-gray-600">
            OT สูงสุด/วัน (ชม.)
            <input
              key={`cap-${editing?.id ?? "new"}`}
              name="capHours"
              type="number"
              required
              min={0.5}
              max={12}
              step="0.5"
              defaultValue={editing?.capHours ?? 4}
              className={inputCls}
            />
          </label>
          <label className="text-xs font-medium text-gray-600">
            ตัวคูณ (เว้นว่าง = ใช้ของร้าน ×{storeMultiplier})
            <input
              key={`mul-${editing?.id ?? "new"}`}
              name="multiplier"
              type="number"
              min={1}
              max={5}
              step="0.1"
              defaultValue={editing?.multiplier ?? ""}
              placeholder={`${storeMultiplier}`}
              className={inputCls}
            />
          </label>
          <label className="text-xs font-medium text-gray-600 sm:col-span-2">
            ชื่อ/เหตุผล (ไม่บังคับ)
            <input
              key={`note-${editing?.id ?? "new"}`}
              name="note"
              maxLength={120}
              defaultValue={editing?.note ?? ""}
              placeholder="เช่น สงกรานต์, งานจัดเลี้ยง"
              className={inputCls}
            />
          </label>
          <fieldset className="sm:col-span-2">
            <legend className="text-xs font-medium text-gray-600">
              พนักงานที่ได้ OT ({selected.size}/{employees.length} คน)
            </legend>
            <div className="mt-1 flex flex-wrap gap-2">
              <button
                type="button"
                className="min-h-9 rounded-full border border-gray-300 px-3 text-xs text-gray-600"
                onClick={() => setSelected(new Set(employees.map((e) => e.userId)))}
              >
                เลือกทั้งหมด
              </button>
              <button
                type="button"
                className="min-h-9 rounded-full border border-gray-300 px-3 text-xs text-gray-600"
                onClick={() => setSelected(new Set())}
              >
                ไม่เลือกเลย
              </button>
            </div>
            <div className="mt-2 grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
              {employees.map((e) => (
                <label key={e.userId} className="flex min-h-11 items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 text-sm">
                  <input
                    type="checkbox"
                    name="userIds"
                    value={e.userId}
                    checked={selected.has(e.userId)}
                    onChange={() => toggle(e.userId)}
                    className="accent-orange-500"
                  />
                  <span className="truncate">{e.name}</span>
                  {!e.otEligible && <span className="ml-auto shrink-0 text-[10px] text-gray-400">ไม่มีสิทธิ์ OT</span>}
                </label>
              ))}
            </div>
          </fieldset>
          {clippedFrom && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 sm:col-span-2">
              วันที่ {thaiDate(clippedFrom)} ถึงก่อน {thaiDate(earliest)} เกินกำหนดย้อนหลังแล้ว แก้ไม่ได้ — บันทึกจะเปลี่ยนเฉพาะตั้งแต่ {thaiDate(earliest)}
            </p>
          )}
          {dateFrom && dateFrom < today && (
            <p className="text-xs text-amber-700 sm:col-span-2">
              ให้ OT ย้อนหลัง — ระบบจะคิดจากเวลาที่ลงไว้จริงของวันนั้น และบันทึกไว้ว่าใครเป็นคนให้
            </p>
          )}
          <div className="flex flex-wrap gap-2 sm:col-span-2">
            <Button type="submit" variant="primary" loading={isPending} loadingText="กำลังบันทึก..." className="min-h-11 px-6 text-sm" disabled={selected.size === 0}>
              บันทึกวันให้ OT
            </Button>
            <Button type="button" variant="secondary" className="min-h-11 px-4 text-sm" onClick={() => setShowForm(false)}>
              ยกเลิก
            </Button>
          </div>
        </form>
      )}

      {groups.length === 0 ? (
        <p className="mt-4 text-sm text-gray-500">ยังไม่มีวันให้ OT</p>
      ) : (
        <ul className="mt-4 space-y-2">
          {groups.map(({ key, days }) => {
            const first = days[0];
            const last = days[days.length - 1];
            const locked = last.date < earliest;
            return (
              <li key={key} className="rounded-lg border border-gray-200 px-3 py-2 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <span className="font-medium text-gray-900">
                      {thaiDate(first.date)}
                      {days.length > 1 ? ` – ${thaiDate(last.date)}` : ""}
                    </span>
                    {first.note && <span className="text-gray-500"> · {first.note}</span>}
                    <span className="ml-2 inline-block rounded-full bg-green-50 px-2 py-0.5 text-xs text-green-700">
                      ≤ {first.capHours} ชม.{first.multiplier ? ` · ×${first.multiplier}` : ""} · {first.userIds.length} คน
                    </span>
                  </div>
                  {!locked && (
                    <div className="flex gap-2">
                      <button
                        type="button"
                        className="min-h-9 rounded-lg border border-gray-300 px-3 text-xs text-gray-700"
                        onClick={() => openForm(days)}
                      >
                        แก้ไข
                      </button>
                      <button
                        type="button"
                        disabled={isPending}
                        className="min-h-9 rounded-lg border border-red-200 px-3 text-xs text-red-600"
                        onClick={async () => {
                          const editable = days.filter((d) => d.date >= earliest);
                          const ok = await confirm({
                            title: "ลบวันให้ OT",
                            message: `ลบวันให้ OT ${editable.length} วัน? OT ของวันนั้นจะหายจากเงินเดือนงวดที่ยังไม่ปิด`,
                            confirmLabel: "ลบ",
                            danger: true,
                          });
                          if (!ok) return;
                          run(
                            async () => {
                              for (const d of editable) {
                                const res = await deleteOtDayAction(d.id);
                                if (res.error) return res;
                              }
                              return { error: null };
                            },
                            () => onNotice("ลบวันให้ OT แล้ว"),
                          );
                        }}
                      >
                        ลบ
                      </button>
                    </div>
                  )}
                </div>
                <p className="mt-1 truncate text-xs text-gray-500">{first.userIds.map(nameOf).join(", ")}</p>
              </li>
            );
          })}
        </ul>
      )}
      {hiddenPast > 0 && (
        <button type="button" className="mt-3 text-xs text-gray-500 underline" onClick={() => setShowPast((v) => !v)}>
          {showPast ? "ซ่อนวันที่เก่ากว่า 7 วัน" : `แสดงวันที่เก่ากว่า 7 วัน (${hiddenPast} วัน)`}
        </button>
      )}
    </div>
  );
}
