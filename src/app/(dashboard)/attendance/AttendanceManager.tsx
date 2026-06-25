"use client";

import { useRouter } from "next/navigation";
import { useActionState, useState, useTransition, type ReactNode } from "react";
import type { AttendanceRecord, AttendanceSettings, PayrollSummary } from "@/modules/attendance/types";
import { ModalDialog, MapPicker, Button } from "@/shared/components/ui";
import {
  clockInAction,
  clockOutAction,
  saveAttendanceSettingsAction,
  saveStoreWorkingDaysAction,
  addManualAttendanceAction,
  adjustAttendanceAction,
  deleteAttendanceAction,
  selfBackdatedClockAction,
  addHolidayAction,
  deleteHolidayAction,
  addEmployeeLeaveAction,
  deleteEmployeeLeaveAction,
} from "./actions";
import { WEEKDAY_LABELS } from "@/modules/hr/types";
import { AttendanceCalendar } from "./AttendanceCalendar";
import type { DayStatus } from "@/modules/attendance/calendar";
import type { StoreHoliday } from "@/modules/attendance/repository";
import type { PayrollAdjustment } from "@/modules/hr/types";

interface Props {
  todayRecord: AttendanceRecord | null;
  canManage: boolean;
  records: AttendanceRecord[] | null;
  payrollSummaries: PayrollSummary[] | null;
  dateFrom: string;
  dateTo: string;
  canUseGps: boolean;
  userEmail: string;
  attendanceSettings: AttendanceSettings | null;
  members: { userId: string; name: string }[];
  today: string;
  backdatedRights: number;
  backdatedUsed: number;
  /** Store-level open weekdays (0=Sun .. 6=Sat). */
  storeWorkingDays: number[];
  /** The viewer's own clock-in/out records for the current month (personal calendar). */
  myMonthRecords: AttendanceRecord[];
  currentMonth: string;
  dayStatus: Record<string, DayStatus>;
  holidays: StoreHoliday[];
  holidayDates: string[];
  canManageHolidays: boolean;
  leaveAdjustments: PayrollAdjustment[];
}

/** Convert an ISO timestamp to a value for <input type="datetime-local"> in local time. */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtTime(iso: string) {
  return iso.slice(11, 16);
}

function fmtDuration(inIso: string, outIso: string | null): string {
  if (!outIso) return "—";
  const mins = Math.floor((new Date(outIso).getTime() - new Date(inIso).getTime()) / 60_000);
  if (mins < 0) return "—";
  if (mins < 60) return `${mins} นาที`;
  return `${Math.floor(mins / 60)} ชม. ${mins % 60} นาที`;
}

function fmtHours(h: number) {
  return h.toLocaleString("th-TH", { minimumFractionDigits: 2 });
}

function fmtMoney(n: number) {
  return n.toLocaleString("th-TH", { minimumFractionDigits: 2 });
}

async function getGps(): Promise<{ lat?: number; lng?: number; label?: string }> {
  return new Promise((resolve) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      resolve({});
      return;
    }
    const timer = setTimeout(() => resolve({}), 5000);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        clearTimeout(timer);
        resolve({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          label: `${pos.coords.latitude.toFixed(5)},${pos.coords.longitude.toFixed(5)}`,
        });
      },
      () => {
        clearTimeout(timer);
        resolve({});
      },
    );
  });
}

/** Collapsible form section so manager tools don't all take up space at once. */
function Collapsible({
  title,
  desc,
  defaultOpen = false,
  children,
}: {
  title: string;
  desc?: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="bg-white rounded-lg border border-gray-200 max-w-3xl">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-3 p-4 text-left"
        aria-expanded={open}
      >
        <div>
          <h2 className="text-sm font-semibold text-gray-900">{title}</h2>
          {desc && <p className="text-xs text-gray-500">{desc}</p>}
        </div>
        <span className="shrink-0 text-xs font-semibold text-gray-400">{open ? "▲ ปิด" : "▼ เปิด"}</span>
      </button>
      {open && <div className="border-t border-gray-100 p-4">{children}</div>}
    </section>
  );
}

export function AttendanceManager({
  todayRecord,
  canManage,
  records,
  payrollSummaries,
  dateFrom,
  dateTo,
  canUseGps,
  attendanceSettings,
  members,
  today,
  backdatedRights,
  backdatedUsed,
  storeWorkingDays,
  myMonthRecords,
  currentMonth,
  dayStatus,
  holidays,
  holidayDates,
  canManageHolidays,
  leaveAdjustments,
}: Props) {
  const router = useRouter();
  const [selfBackdateOpen, setSelfBackdateOpen] = useState(false);
  const [clocking, setClocking] = useState(false);
  const [clockError, setClockError] = useState<string | null>(null);
  const [attendanceSettingsDialogOpen, setAttendanceSettingsDialogOpen] = useState(false);
  const [filterFrom, setFilterFrom] = useState(dateFrom);
  const [filterTo, setFilterTo] = useState(dateTo);
  const [rates, setRates] = useState<Record<string, string>>({});
  const [addOpen, setAddOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<AttendanceRecord | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [isEditing, startEditTransition] = useTransition();

  function runEdit(
    action: () => Promise<{ error: string | null }>,
    onOk: () => void,
    successMessage: string,
  ) {
    setEditError(null);
    setActionNotice(null);
    startEditTransition(async () => {
      const res = await action();
      if (res.error) {
        setEditError(res.error);
        return;
      }
      onOk();
      setActionNotice(successMessage);
      router.refresh();
    });
  }

  const isClockedIn = !!todayRecord && !todayRecord.clockOutAt;
  const isClockedOut = !!todayRecord && !!todayRecord.clockOutAt;

  async function handleClockIn() {
    setClocking(true);
    setClockError(null);
    setActionNotice(null);
    const gps = canUseGps ? await getGps() : {};
    const fd = new FormData();
    if (gps.lat !== undefined) fd.append("lat", String(gps.lat));
    if (gps.lng !== undefined) fd.append("lng", String(gps.lng));
    if (gps.label) fd.append("locationLabel", gps.label);
    const result = await clockInAction(fd);
    setClocking(false);
    if (result.error) {
      setClockError(result.error);
      return;
    }
    setActionNotice("ลงชื่อเข้างานแล้ว");
    router.refresh();
  }

  async function handleClockOut() {
    setClocking(true);
    setClockError(null);
    setActionNotice(null);
    const gps = canUseGps ? await getGps() : {};
    const fd = new FormData();
    if (gps.lat !== undefined) fd.append("lat", String(gps.lat));
    if (gps.lng !== undefined) fd.append("lng", String(gps.lng));
    if (gps.label) fd.append("locationLabel", gps.label);
    const result = await clockOutAction(fd);
    setClocking(false);
    if (result.error) {
      setClockError(result.error);
      return;
    }
    setActionNotice("ลงชื่อออกงานแล้ว");
    router.refresh();
  }

  function handleFilter() {
    setEditError(null);
    setActionNotice(`กรองช่วงวันที่ ${filterFrom} – ${filterTo} แล้ว`);
    router.push(`/attendance?dateFrom=${filterFrom}&dateTo=${filterTo}`);
  }

  function computePay(summary: PayrollSummary): number {
    const rate = parseFloat(rates[summary.userId] ?? "");
    if (!isFinite(rate) || rate <= 0) return 0;
    return Math.round(summary.totalHours * rate * 100) / 100;
  }

  return (
    <div className="page-shell">
      <div className="page-header">
        <div>
          <h1 className="page-title">การเข้างาน</h1>
          <p className="page-kicker">ลงเวลาเข้า-ออกงาน และดูสรุปชั่วโมงทำงาน</p>
        </div>
      </div>

      {actionNotice && (
        <p className="alert-success" aria-live="polite">
          {actionNotice}
        </p>
      )}
      {editError && (
        <p className="alert-danger" role="alert">
          {editError}
        </p>
      )}

      {/* Alert: ยังไม่ได้เข้างานวันนี้ */}
      {!todayRecord && (
        <div className="flex flex-wrap items-center gap-3 rounded-[var(--radius-lg)] border border-amber-300 bg-amber-50 p-4">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-amber-100 text-2xl">⏰</span>
          <div className="min-w-0 flex-1">
            <p className="font-extrabold text-amber-900">คุณยังไม่ได้ลงชื่อเข้างานวันนี้</p>
            <p className="text-sm text-amber-800">กดปุ่มด้านขวาเพื่อเริ่มบันทึกเวลาทำงานของวันนี้</p>
          </div>
          <Button onClick={handleClockIn} loading={clocking} loadingText="กำลังบันทึก..." variant="primary" className="shrink-0 disabled:opacity-40">
            ลงชื่อเข้างาน
          </Button>
        </div>
      )}

      {/* Clock card */}
      <section className="panel max-w-md p-5">
        <div className="mb-3 flex items-center justify-between gap-3">
          <p className="label-muted">สถานะวันนี้</p>
          <span className={`badge ${isClockedIn ? "badge-success" : isClockedOut ? "badge" : "badge-warning"}`}>
            {isClockedIn ? "กำลังทำงาน" : isClockedOut ? "ออกงานแล้ว" : "ยังไม่เข้างาน"}
          </span>
        </div>

        {isClockedIn && todayRecord && (
          <p className="mb-3 text-2xl font-extrabold text-[var(--ink)]">
            เข้างาน {fmtTime(todayRecord.clockInAt)} น.
            {todayRecord.clockInLocationLabel && (
              <span className="ml-2 align-middle text-xs font-normal text-[var(--muted)]">
                📍 {todayRecord.clockInLocationLabel}
              </span>
            )}
          </p>
        )}
        {isClockedOut && todayRecord && (
          <p className="mb-3 text-lg font-bold text-[var(--ink-2)]">
            {fmtTime(todayRecord.clockInAt)}–{fmtTime(todayRecord.clockOutAt!)} น.
            <span className="ml-2 text-sm font-normal text-[var(--muted)]">
              (รวม {fmtDuration(todayRecord.clockInAt, todayRecord.clockOutAt)})
            </span>
          </p>
        )}

        {clockError && <p className="alert-danger mb-3" role="alert">{clockError}</p>}

        {!isClockedIn && !isClockedOut && (
          <Button onClick={handleClockIn} loading={clocking} loadingText="กำลังบันทึก..." variant="primary" className="w-full disabled:opacity-40">
            ลงชื่อเข้างาน
          </Button>
        )}
        {isClockedIn && (
          <Button onClick={handleClockOut} loading={clocking} loadingText="กำลังบันทึก..." variant="primary" className="w-full disabled:opacity-40">
            ลงชื่อออกงาน
          </Button>
        )}
        {isClockedOut && (
          <p className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2 text-center text-sm text-[var(--muted)]">
            ลงเวลาครบแล้วสำหรับวันนี้ ขอบคุณค่ะ
          </p>
        )}

        <p className="mt-3 text-xs text-[var(--muted)]">
          {canUseGps
            ? "ระบบจะขอสิทธิ์ตำแหน่ง GPS โดยอัตโนมัติเพื่อยืนยันพื้นที่เข้างาน"
            : "GPS ถูกจำกัดตามแพ็กเกจ ระบบจะบันทึกเวลาโดยไม่เก็บตำแหน่ง"}
        </p>

        <div className="mt-3 border-t border-[var(--border)] pt-3">
          <button
            onClick={() => {
              setClockError(null);
              setEditError(null);
              setActionNotice("เปิดฟอร์มลงเวลาย้อนหลังแล้ว");
              setSelfBackdateOpen(true);
            }}
            disabled={backdatedUsed >= backdatedRights}
            className="btn-secondary w-full text-sm disabled:opacity-40"
          >
            ลงเวลาย้อนหลัง (เหลือ {Math.max(0, backdatedRights - backdatedUsed)}/{backdatedRights} ครั้งเดือนนี้)
          </button>
        </div>
      </section>

      {/* Personal attendance calendar — everyone sees their own clock-in/out with statuses.
          Managers get the full team calendar in the manage section below instead. */}
      {!canManage && (
        <AttendanceCalendar
          records={myMonthRecords}
          month={currentMonth}
          employees={[]}
          title="ปฏิทินการเข้า-ออกงานของฉัน"
          dayStatus={dayStatus}
        />
      )}

      {/* Store holidays — owner/admin only */}
      {canManageHolidays && (
        <Collapsible
          title="วันหยุดร้าน (ปิดทั้งร้าน)"
          desc="เฉพาะเจ้าของ/แอดมิน — ทั้งร้านหยุดวันนี้ ใช้กับพนักงานทุกคน แสดงบนปฏิทินและไม่นับเป็นขาดงาน"
        >
          {editError && <p className="mb-2 text-xs text-red-600">{editError}</p>}
          <form
            action={(fd) => runEdit(() => addHolidayAction(fd), () => {}, "เพิ่มวันหยุดร้านแล้ว")}
            className="flex flex-wrap items-end gap-2"
          >
            <label className="text-xs font-medium text-gray-600">
              วันที่
              <input name="date" type="date" required className="mt-1 block min-h-11 rounded-lg border border-gray-300 px-3 text-sm" />
            </label>
            <label className="text-xs font-medium text-gray-600">
              ชื่อวันหยุด (ไม่บังคับ)
              <input name="name" maxLength={100} placeholder="เช่น วันสงกรานต์" className="mt-1 block min-h-11 rounded-lg border border-gray-300 px-3 text-sm" />
            </label>
            <Button type="submit" variant="primary" loading={isEditing} className="min-h-11 px-4 text-sm">เพิ่มวันหยุด</Button>
          </form>
          {holidays.length > 0 && (
            <ul className="mt-3 divide-y divide-gray-100 border-t border-gray-100">
              {holidays.map((h) => (
                <li key={h.id} className="flex items-center justify-between py-2 text-sm">
                  <span className="text-gray-700">
                    <span className="font-medium">{h.date}</span>{h.name ? ` · ${h.name}` : ""}
                  </span>
                  <button
                    onClick={() => runEdit(() => deleteHolidayAction(h.id), () => {}, "ลบวันหยุดร้านแล้ว")}
                    disabled={isEditing}
                    className="text-xs text-red-500 hover:underline"
                  >
                    ลบ
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Collapsible>
      )}

      {/* Manage sections — visible to attendance.manage only */}
      {canManage && (
        <>
          <Collapsible
            title="วันลาพนักงาน (รายบุคคล)"
            desc="ลาเฉพาะพนักงานคนนั้น (ลาพักร้อน/ลากิจ/ลาป่วย) — คนละอย่างกับ 'วันหยุดร้าน' ที่ปิดทั้งร้าน; แสดงบนปฏิทินและไม่นับเป็นขาดงาน"
          >
            <form
              action={(fd) => runEdit(() => addEmployeeLeaveAction(fd), () => {}, "เพิ่มวันลาพนักงานแล้ว")}
              className="grid gap-2 md:grid-cols-[1fr_1fr_1.4fr_auto]"
            >
              <label className="text-xs font-medium text-gray-600">
                วันที่
                <input
                  name="date"
                  type="date"
                  defaultValue={today}
                  required
                  className="mt-1 block w-full min-h-11 rounded-lg border border-gray-300 px-3 text-sm"
                />
              </label>
              <label className="text-xs font-medium text-gray-600">
                พนักงาน
                <select
                  name="userId"
                  required
                  className="mt-1 block w-full min-h-11 rounded-lg border border-gray-300 px-3 text-sm"
                  onChange={(e) => {
                    const opt = e.target.selectedOptions[0];
                    const hidden = e.currentTarget.form?.elements.namedItem("employeeName") as HTMLInputElement | null;
                    if (hidden) hidden.value = opt?.dataset.name ?? "";
                  }}
                >
                  <option value="">— เลือก —</option>
                  {members.map((m) => (
                    <option key={m.userId} value={m.userId} data-name={m.name}>{m.name}</option>
                  ))}
                </select>
              </label>
              <input type="hidden" name="employeeName" />
              <label className="text-xs font-medium text-gray-600">
                หมายเหตุ (ไม่บังคับ)
                <input
                  name="note"
                  maxLength={200}
                  placeholder="เช่น ลาพักร้อน"
                  className="mt-1 block w-full min-h-11 rounded-lg border border-gray-300 px-3 text-sm"
                />
              </label>
              <Button type="submit" variant="primary" loading={isEditing} loadingText="กำลังบันทึก..." className="min-h-11 self-end px-4 text-sm">
                เพิ่มวันลาพนักงาน
              </Button>
            </form>
            {leaveAdjustments.length > 0 ? (
              <ul className="mt-3 divide-y divide-gray-100 border-t border-gray-100">
                {leaveAdjustments.map((leave) => (
                  <li key={leave.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                    <span className="text-gray-700">
                      <span className="font-medium">{leave.date}</span> · {leave.employeeName}
                      {leave.note ? <span className="text-gray-500"> · {leave.note}</span> : null}
                    </span>
                    <button
                      onClick={() => runEdit(() => deleteEmployeeLeaveAction(leave.id), () => {}, "ลบวันลาพนักงานแล้ว")}
                      disabled={isEditing}
                      className="text-xs text-red-500 hover:underline disabled:opacity-40"
                    >
                      ลบ
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-500">
                ยังไม่มีวันลาพนักงานในช่วงวันที่นี้
              </p>
            )}
          </Collapsible>

          {/* วันเปิดทำการของร้าน (ค่าเริ่มต้นของปฏิทิน) */}
          <Collapsible
            title="วันเปิดทำการของร้าน"
            desc="ร้านเปิดวันไหนบ้าง (รวมเสาร์-อาทิตย์ได้) — ใช้เป็นค่าเริ่มต้นของปฏิทิน วันที่เปิดทำการแต่ไม่มีคนเข้างานจะนับเป็น 'ขาด'"
          >
            <form
              action={(fd) => runEdit(() => saveStoreWorkingDaysAction(fd), () => {}, "บันทึกวันเปิดทำการแล้ว")}
              className="space-y-3"
            >
              <div className="flex flex-wrap gap-2">
                {WEEKDAY_LABELS.map((label, day) => (
                  <label
                    key={day}
                    className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-gray-300 px-3 text-sm"
                  >
                    <input
                      type="checkbox"
                      name="workingDays"
                      value={day}
                      defaultChecked={storeWorkingDays.includes(day)}
                      className="h-4 w-4 rounded border-gray-300"
                    />
                    {label}
                  </label>
                ))}
              </div>
              <Button type="submit" variant="primary" loading={isEditing} loadingText="กำลังบันทึก..." className="min-h-11 px-4 text-sm">
                บันทึกวันเปิดทำการ
              </Button>
            </form>
          </Collapsible>

          {canUseGps && (
            <>
              <Collapsible
                title="ตั้งค่า GPS เข้างาน"
                desc="กำหนด geofence ของร้าน — เปิดแล้วพนักงานต้องจับตำแหน่งจริงจึงจะลงเวลาได้"
              >
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={() => {
                      setEditError(null);
                      setActionNotice("เปิดหน้าต่างแก้ไข GPS เข้างานแล้ว");
                      setAttendanceSettingsDialogOpen(true);
                    }}
                    className="px-3 py-1.5 text-sm bg-gray-900 text-white rounded hover:bg-gray-700 transition-colors"
                  >
                    แก้ไข GPS เข้างาน
                  </button>
                </div>
                <div className="mt-4 grid gap-3 sm:grid-cols-4">
                  <AttendanceInfo
                    label="Geofence"
                    value={attendanceSettings?.geofenceEnabled ? "เปิดใช้" : "ปิดอยู่"}
                  />
                  <AttendanceInfo
                    label="Latitude"
                    value={attendanceSettings?.geofenceCenterLat?.toString() ?? "ยังไม่ได้ตั้งค่า"}
                  />
                  <AttendanceInfo
                    label="Longitude"
                    value={attendanceSettings?.geofenceCenterLng?.toString() ?? "ยังไม่ได้ตั้งค่า"}
                  />
                  <AttendanceInfo
                    label="Radius"
                    value={attendanceSettings?.geofenceRadiusMeters
                      ? `${attendanceSettings.geofenceRadiusMeters} เมตร`
                      : "ยังไม่ได้ตั้งค่า"}
                  />
                </div>
              </Collapsible>

              {attendanceSettingsDialogOpen && (
                <AttendanceSettingsDialog
                  attendanceSettings={attendanceSettings}
                  onSaved={() => setActionNotice("บันทึกการตั้งค่า GPS เข้างานแล้ว")}
                  onClose={() => setAttendanceSettingsDialogOpen(false)}
                />
              )}
            </>
          )}

          {/* Date range filter */}
          <div className="flex items-center gap-2 flex-wrap">
            <label className="text-xs text-gray-500">ช่วงวันที่:</label>
            <input
              type="date"
              value={filterFrom}
              onChange={(e) => setFilterFrom(e.target.value)}
              className="border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <span className="text-gray-400 text-sm">–</span>
            <input
              type="date"
              value={filterTo}
              onChange={(e) => setFilterTo(e.target.value)}
              className="border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <button
              onClick={handleFilter}
              className="px-3 py-1 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors"
            >
              กรอง
            </button>
          </div>

          {/* Payroll summary */}
          {payrollSummaries && payrollSummaries.length > 0 && (
            <div>
              <h2 className="text-sm font-medium text-gray-700 mb-2">
                สรุปค่าแรง ({dateFrom} – {dateTo})
              </h2>
              <div className="bg-white rounded-lg border border-gray-200 overflow-x-auto">
                <table className="w-full text-sm min-w-[640px]">
                  <thead className="bg-gray-50 text-xs text-gray-500 uppercase">
                    <tr>
                      <th className="px-3 py-2 text-left">พนักงาน</th>
                      <th className="px-3 py-2 text-right">วัน</th>
                      <th className="px-3 py-2 text-right">ชม. รวม</th>
                      <th className="px-3 py-2 text-right">ปกติ</th>
                      <th className="px-3 py-2 text-right">OT</th>
                      <th className="px-3 py-2 text-right">อัตรา (บาท/ชม.)</th>
                      <th className="px-3 py-2 text-right">ค่าแรงรวม</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {payrollSummaries.map((s) => {
                      const pay = computePay(s);
                      return (
                        <tr key={s.userId} className="hover:bg-gray-50">
                          <td className="px-3 py-2 text-gray-800">{s.employeeName}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-gray-600">
                            {s.totalDays}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-gray-700">
                            {fmtHours(s.totalHours)}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-gray-600">
                            {fmtHours(s.regularHours)}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-orange-600">
                            {fmtHours(s.overtimeHours)}
                          </td>
                          <td className="px-3 py-2 text-right">
                            <input
                              type="number"
                              min="0"
                              step="1"
                              placeholder="0"
                              value={rates[s.userId] ?? ""}
                              onChange={(e) =>
                                setRates((prev) => ({ ...prev, [s.userId]: e.target.value }))
                              }
                              className="w-24 border border-gray-300 rounded px-2 py-0.5 text-sm text-right tabular-nums focus:outline-none focus:ring-1 focus:ring-blue-500"
                            />
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums font-medium text-green-700">
                            {pay > 0 ? `฿${fmtMoney(pay)}` : "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="text-xs text-gray-400 mt-1">
                * อัตราค่าแรงคำนวณ ณ หน้าจอเท่านั้น ไม่ได้บันทึกในระบบ
              </p>
            </div>
          )}

          {/* Attendance calendar (#5) */}
          <AttendanceCalendar
            records={records ?? []}
            month={dateFrom.slice(0, 7)}
            employees={members}
            holidayDates={holidayDates}
            employeeLeaveDates={leaveAdjustments}
          />

          {/* Attendance records */}
          <div>
            <div className="mb-2 flex items-center justify-between gap-2">
              <h2 className="text-sm font-medium text-gray-700">
                รายการเข้า-ออกงาน ({records?.length ?? 0} รายการ)
              </h2>
              <button
                onClick={() => {
                  setEditError(null);
                  setActionNotice("เปิดฟอร์มเพิ่มบันทึกย้อนหลังแล้ว");
                  setAddOpen(true);
                }}
                className="btn-secondary min-h-9 px-3 text-xs"
              >
                + เพิ่มย้อนหลัง
              </button>
            </div>
            {!records || records.length === 0 ? (
              <div className="bg-white rounded-lg border border-gray-200 px-4 py-8 text-center text-sm text-gray-400">
                ไม่พบรายการในช่วงวันที่นี้
              </div>
            ) : (
              <div className="bg-white rounded-lg border border-gray-200 overflow-x-auto">
                <table className="w-full text-sm min-w-[640px]">
                  <thead className="bg-gray-50 text-xs text-gray-500 uppercase">
                    <tr>
                      <th className="px-3 py-2 text-left">วันที่</th>
                      <th className="px-3 py-2 text-left">พนักงาน</th>
                      <th className="px-3 py-2 text-right">เข้า</th>
                      <th className="px-3 py-2 text-right">ออก</th>
                      <th className="px-3 py-2 text-right">ระยะเวลา</th>
                      <th className="px-3 py-2 text-left">GPS เข้า</th>
                      <th className="px-3 py-2 text-left">สถานะ</th>
                      <th className="px-3 py-2 text-right">จัดการ</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {records.map((r) => (
                      <tr key={r.id} className="hover:bg-gray-50">
                        <td className="px-3 py-2 text-gray-600 whitespace-nowrap">{r.date}</td>
                        <td className="px-3 py-2 text-gray-800">{r.employeeName}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-gray-700">
                          {fmtTime(r.clockInAt)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-gray-600">
                          {r.clockOutAt ? fmtTime(r.clockOutAt) : "—"}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-gray-500 whitespace-nowrap">
                          {fmtDuration(r.clockInAt, r.clockOutAt)}
                        </td>
                        <td className="px-3 py-2 text-xs text-gray-400 max-w-[140px] truncate">
                          {r.clockInLocationLabel ?? "—"}
                        </td>
                        <td className="px-3 py-2">
                          <span
                            className={`inline-block text-xs px-1.5 py-0.5 rounded ${
                              r.status === "active"
                                ? "bg-green-100 text-green-700"
                                : r.status === "completed"
                                  ? "bg-gray-100 text-gray-600"
                                  : "bg-yellow-100 text-yellow-700"
                            }`}
                          >
                            {r.status === "active"
                              ? "กำลังทำงาน"
                              : r.status === "completed"
                                ? "เสร็จแล้ว"
                                : r.status === "backdated"
                                  ? "เพิ่มย้อนหลัง"
                                  : r.status === "adjusted"
                                    ? "แก้ไขแล้ว"
                                    : r.status}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right whitespace-nowrap">
                          <button
                            onClick={() => {
                              setEditError(null);
                              setActionNotice("เปิดฟอร์มแก้ไขรายการเข้า-ออกงานแล้ว");
                              setEditTarget(r);
                            }}
                            className="text-xs text-blue-600 hover:underline"
                          >
                            แก้ไข
                          </button>
                          <button
                            onClick={() => runEdit(() => deleteAttendanceAction(r.id), () => {}, "ลบรายการเข้า-ออกงานแล้ว")}
                            disabled={isEditing}
                            className="ml-2 text-xs text-red-500 hover:underline disabled:opacity-40"
                          >
                            ลบ
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Add backdated record */}
          {addOpen && (
            <ModalDialog open title="เพิ่มบันทึกเวลาย้อนหลัง" onClose={() => setAddOpen(false)} size="md">
              <form
                action={(fd) => runEdit(() => addManualAttendanceAction(fd), () => setAddOpen(false), "เพิ่มบันทึกเวลาย้อนหลังแล้ว")}
                className="space-y-3"
              >
                <label className="block text-xs font-medium text-gray-600">
                  พนักงาน
                  <select
                    name="userId"
                    required
                    className="mt-1 w-full min-h-11 rounded-lg border border-gray-300 px-3 text-sm"
                    onChange={(e) => {
                      const opt = e.target.selectedOptions[0];
                      const hidden = e.currentTarget.form?.elements.namedItem("employeeName") as HTMLInputElement | null;
                      if (hidden) hidden.value = opt?.dataset.name ?? "";
                    }}
                  >
                    <option value="">— เลือก —</option>
                    {members.map((m) => (
                      <option key={m.userId} value={m.userId} data-name={m.name}>{m.name}</option>
                    ))}
                  </select>
                </label>
                <input type="hidden" name="employeeName" />
                <label className="block text-xs font-medium text-gray-600">
                  วันที่
                  <input name="date" type="date" defaultValue={today} required className="mt-1 w-full min-h-11 rounded-lg border border-gray-300 px-3 text-sm" />
                </label>
                <div className="grid grid-cols-2 gap-3">
                  <label className="block text-xs font-medium text-gray-600">
                    เวลาเข้า
                    <input name="clockInAt" type="datetime-local" required className="mt-1 w-full min-h-11 rounded-lg border border-gray-300 px-3 text-sm" />
                  </label>
                  <label className="block text-xs font-medium text-gray-600">
                    เวลาออก (ไม่บังคับ)
                    <input name="clockOutAt" type="datetime-local" className="mt-1 w-full min-h-11 rounded-lg border border-gray-300 px-3 text-sm" />
                  </label>
                </div>
                <label className="block text-xs font-medium text-gray-600">
                  หมายเหตุ
                  <input name="note" maxLength={200} className="mt-1 w-full min-h-11 rounded-lg border border-gray-300 px-3 text-sm" />
                </label>
                {editError && <p className="text-xs text-red-600">{editError}</p>}
                <Button type="submit" variant="primary" loading={isEditing} loadingText="กำลังบันทึก..." className="min-h-11 w-full text-sm">
                  เพิ่มบันทึก
                </Button>
              </form>
            </ModalDialog>
          )}

          {/* Edit existing record */}
          {editTarget && (
            <ModalDialog open title={`แก้ไขเวลา · ${editTarget.employeeName}`} onClose={() => setEditTarget(null)} size="md">
              <form
                action={(fd) => runEdit(() => adjustAttendanceAction(fd), () => setEditTarget(null), "บันทึกการแก้ไขเวลาแล้ว")}
                className="space-y-3"
              >
                <input type="hidden" name="id" value={editTarget.id} />
                <div className="grid grid-cols-2 gap-3">
                  <label className="block text-xs font-medium text-gray-600">
                    เวลาเข้า
                    <input name="clockInAt" type="datetime-local" required defaultValue={toLocalInput(editTarget.clockInAt)} className="mt-1 w-full min-h-11 rounded-lg border border-gray-300 px-3 text-sm" />
                  </label>
                  <label className="block text-xs font-medium text-gray-600">
                    เวลาออก (ไม่บังคับ)
                    <input name="clockOutAt" type="datetime-local" defaultValue={editTarget.clockOutAt ? toLocalInput(editTarget.clockOutAt) : ""} className="mt-1 w-full min-h-11 rounded-lg border border-gray-300 px-3 text-sm" />
                  </label>
                </div>
                <label className="block text-xs font-medium text-gray-600">
                  หมายเหตุ
                  <input name="note" maxLength={200} defaultValue={editTarget.note ?? ""} className="mt-1 w-full min-h-11 rounded-lg border border-gray-300 px-3 text-sm" />
                </label>
                {editError && <p className="text-xs text-red-600">{editError}</p>}
                <Button type="submit" variant="primary" loading={isEditing} loadingText="กำลังบันทึก..." className="min-h-11 w-full text-sm">
                  บันทึกการแก้ไข
                </Button>
              </form>
            </ModalDialog>
          )}
        </>
      )}

      {/* Self-service backdated clock (all employees, limited per month) */}
      {selfBackdateOpen && (
        <ModalDialog open title="ลงเวลาย้อนหลัง" onClose={() => setSelfBackdateOpen(false)} size="md">
          <form
            action={(fd) => runEdit(() => selfBackdatedClockAction(fd), () => setSelfBackdateOpen(false), "ลงเวลาย้อนหลังแล้ว")}
            className="space-y-3"
          >
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
              ใช้สำหรับวันที่ลืมลงเวลา · เหลือสิทธิ {Math.max(0, backdatedRights - backdatedUsed)}/{backdatedRights} ครั้งในเดือนนี้
            </p>
            <label className="block text-xs font-medium text-gray-600">
              วันที่ (ย้อนหลัง)
              <input name="date" type="date" max={today} required className="mt-1 w-full min-h-11 rounded-lg border border-gray-300 px-3 text-sm" />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block text-xs font-medium text-gray-600">
                เวลาเข้า
                <input name="clockInAt" type="datetime-local" required className="mt-1 w-full min-h-11 rounded-lg border border-gray-300 px-3 text-sm" />
              </label>
              <label className="block text-xs font-medium text-gray-600">
                เวลาออก (ไม่บังคับ)
                <input name="clockOutAt" type="datetime-local" className="mt-1 w-full min-h-11 rounded-lg border border-gray-300 px-3 text-sm" />
              </label>
            </div>
            <label className="block text-xs font-medium text-gray-600">
              เหตุผล
              <input name="note" maxLength={200} placeholder="เช่น ลืมลงเวลา" className="mt-1 w-full min-h-11 rounded-lg border border-gray-300 px-3 text-sm" />
            </label>
            {editError && <p className="text-xs text-red-600">{editError}</p>}
            <Button type="submit" variant="primary" loading={isEditing} loadingText="กำลังบันทึก..." className="min-h-11 w-full text-sm">
              ลงเวลาย้อนหลัง
            </Button>
          </form>
        </ModalDialog>
      )}
    </div>
  );
}

function AttendanceInfo({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-gray-200 bg-gray-50 p-3">
      <p className="text-xs text-gray-500">{label}</p>
      <p className="mt-1 text-sm font-medium text-gray-800">{value}</p>
    </div>
  );
}

function AttendanceSettingsDialog({
  attendanceSettings,
  onSaved,
  onClose,
}: {
  attendanceSettings: AttendanceSettings | null;
  onSaved: () => void;
  onClose: () => void;
}) {
  const [settingsState, settingsAction, settingsPending] = useActionState(
    async (prev: { error: string | null; success?: boolean }, fd: FormData) => {
      const result = await saveAttendanceSettingsAction(prev, fd);
      if (!result.error) {
        onSaved();
        onClose();
      }
      return result;
    },
    { error: null, success: false },
  );

  const [lat, setLat] = useState(attendanceSettings?.geofenceCenterLat?.toString() ?? "");
  const [lng, setLng] = useState(attendanceSettings?.geofenceCenterLng?.toString() ?? "");
  const [radius, setRadius] = useState(attendanceSettings?.geofenceRadiusMeters?.toString() ?? "100");
  const [locating, setLocating] = useState(false);
  const [settingsNotice, setSettingsNotice] = useState<string | null>(null);

  async function useCurrentLocation() {
    setLocating(true);
    setSettingsNotice(null);
    const g = await getGps();
    setLocating(false);
    if (g.lat !== undefined && g.lng !== undefined) {
      setLat(g.lat.toFixed(6));
      setLng(g.lng.toFixed(6));
      setSettingsNotice("ใช้ตำแหน่งปัจจุบันแล้ว");
      return;
    }
    setSettingsNotice("ไม่สามารถอ่านตำแหน่งปัจจุบันได้");
  }

  return (
    <ModalDialog
      open
      title="แก้ไข GPS เข้างาน"
      onClose={onClose}
      size="lg"
    >
      <form action={settingsAction} className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-gray-900">ตั้งค่า GPS เข้างาน</h3>
            <p className="text-xs text-gray-500">กำหนด center/radius สำหรับตรวจพื้นที่ลงเวลา</p>
          </div>
          <label className="inline-flex items-center gap-2 text-sm text-gray-700">
            <input
              name="geofenceEnabled"
              type="checkbox"
              defaultChecked={attendanceSettings?.geofenceEnabled ?? false}
              className="h-4 w-4 rounded border-gray-300"
            />
            เปิดใช้ geofence
          </label>
        </div>
        <div className="space-y-2">
          <button
            type="button"
            onClick={useCurrentLocation}
            disabled={locating}
            className="btn-secondary text-xs disabled:opacity-40"
          >
            {locating ? "กำลังระบุตำแหน่ง..." : "📍 ใช้ตำแหน่งปัจจุบัน"}
          </button>
          <p className="text-xs text-gray-500">
            คลิกบนแผนที่เพื่อปักหมุดตำแหน่งร้าน หรือกดปุ่มด้านบนเพื่อใช้ตำแหน่งปัจจุบัน · วงสีเขียว = รัศมีเข้างาน
          </p>
          {settingsNotice && (
            <p className="text-xs text-emerald-700" aria-live="polite">
              {settingsNotice}
            </p>
          )}
          <MapPicker
            lat={lat ? parseFloat(lat) : null}
            lng={lng ? parseFloat(lng) : null}
            radius={radius ? parseInt(radius, 10) : null}
            onPick={(la, ln) => {
              setLat(la.toFixed(6));
              setLng(ln.toFixed(6));
            }}
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="text-xs text-gray-500">
            Latitude
            <input
              name="geofenceCenterLat"
              type="number"
              step="0.000001"
              min="-90"
              max="90"
              value={lat}
              onChange={(e) => setLat(e.target.value)}
              className="mt-1 w-full border border-gray-300 rounded px-2 py-1 text-sm"
            />
          </label>
          <label className="text-xs text-gray-500">
            Longitude
            <input
              name="geofenceCenterLng"
              type="number"
              step="0.000001"
              min="-180"
              max="180"
              value={lng}
              onChange={(e) => setLng(e.target.value)}
              className="mt-1 w-full border border-gray-300 rounded px-2 py-1 text-sm"
            />
          </label>
          <label className="text-xs text-gray-500">
            Radius (เมตร)
            <input
              name="geofenceRadiusMeters"
              type="number"
              min="10"
              max="5000"
              value={radius}
              onChange={(e) => setRadius(e.target.value)}
              className="mt-1 w-full border border-gray-300 rounded px-2 py-1 text-sm"
            />
          </label>
        </div>
        {settingsState.error && (
          <p className="text-xs text-red-600">{settingsState.error}</p>
        )}
        {settingsState.success && !settingsState.error && (
          <p className="text-xs text-green-700">บันทึกแล้ว</p>
        )}
        <Button
          type="submit"
          loading={settingsPending}
          loadingText="กำลังบันทึก..."
          className="px-3 py-1.5 text-sm bg-gray-900 text-white rounded disabled:opacity-40"
        >
          บันทึกการตั้งค่า
        </Button>
      </form>
    </ModalDialog>
  );
}
