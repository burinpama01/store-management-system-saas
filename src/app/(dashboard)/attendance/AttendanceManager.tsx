"use client";

import { useRouter } from "next/navigation";
import { useActionState, useState } from "react";
import type { AttendanceRecord, AttendanceSettings, PayrollSummary } from "@/modules/attendance/types";
import { ModalDialog } from "@/shared/components/ui";
import { clockInAction, clockOutAction, saveAttendanceSettingsAction } from "./actions";

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

export function AttendanceManager({
  todayRecord,
  canManage,
  records,
  payrollSummaries,
  dateFrom,
  dateTo,
  canUseGps,
  attendanceSettings,
}: Props) {
  const router = useRouter();
  const [clocking, setClocking] = useState(false);
  const [clockError, setClockError] = useState<string | null>(null);
  const [attendanceSettingsDialogOpen, setAttendanceSettingsDialogOpen] = useState(false);
  const [filterFrom, setFilterFrom] = useState(dateFrom);
  const [filterTo, setFilterTo] = useState(dateTo);
  const [rates, setRates] = useState<Record<string, string>>({});

  const isClockedIn = !!todayRecord && !todayRecord.clockOutAt;
  const isClockedOut = !!todayRecord && !!todayRecord.clockOutAt;

  async function handleClockIn() {
    setClocking(true);
    setClockError(null);
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
    router.refresh();
  }

  async function handleClockOut() {
    setClocking(true);
    setClockError(null);
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
    router.refresh();
  }

  function handleFilter() {
    router.push(`/attendance?dateFrom=${filterFrom}&dateTo=${filterTo}`);
  }

  function computePay(summary: PayrollSummary): number {
    const rate = parseFloat(rates[summary.userId] ?? "");
    if (!isFinite(rate) || rate <= 0) return 0;
    return Math.round(summary.totalHours * rate * 100) / 100;
  }

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold text-gray-900">การเข้างาน</h1>

      {/* Clock widget */}
      <div className="bg-white rounded-lg border border-gray-200 p-4 max-w-sm">
        <p className="text-xs text-gray-500 uppercase tracking-wide mb-2">สถานะวันนี้</p>

        {!todayRecord && (
          <p className="text-sm text-gray-500 mb-3">ยังไม่ได้ลงชื่อเข้างาน</p>
        )}
        {isClockedIn && todayRecord && (
          <p className="text-sm text-green-700 font-medium mb-3">
            เข้างานแล้ว · {fmtTime(todayRecord.clockInAt)} น.
            {todayRecord.clockInLocationLabel && (
              <span className="text-xs text-gray-400 font-normal ml-1">
                ({todayRecord.clockInLocationLabel})
              </span>
            )}
          </p>
        )}
        {isClockedOut && todayRecord && (
          <p className="text-sm text-gray-500 mb-3">
            ออกงานแล้ว · {fmtTime(todayRecord.clockInAt)}–{fmtTime(todayRecord.clockOutAt!)} น.
            &nbsp;({fmtDuration(todayRecord.clockInAt, todayRecord.clockOutAt)})
          </p>
        )}

        {clockError && (
          <p className="text-xs text-red-600 mb-2 bg-red-50 border border-red-200 rounded px-2 py-1">
            {clockError}
          </p>
        )}

        <div className="flex gap-2">
          {!isClockedIn && !isClockedOut && (
            <button
              onClick={handleClockIn}
              disabled={clocking}
              className="px-4 py-2 text-sm font-medium text-white bg-green-600 hover:bg-green-700 rounded disabled:opacity-40 transition-colors"
            >
              {clocking ? "กำลังบันทึก..." : "ลงชื่อเข้างาน"}
            </button>
          )}
          {isClockedIn && (
            <button
              onClick={handleClockOut}
              disabled={clocking}
              className="px-4 py-2 text-sm font-medium text-white bg-orange-600 hover:bg-orange-700 rounded disabled:opacity-40 transition-colors"
            >
              {clocking ? "กำลังบันทึก..." : "ลงชื่อออกงาน"}
            </button>
          )}
        </div>
        <p className="text-xs text-gray-400 mt-2">
          {canUseGps
            ? "ระบบจะขอสิทธิ์ตำแหน่ง GPS โดยอัตโนมัติ"
            : "GPS ถูกจำกัดตามแพ็กเกจ ระบบจะบันทึกเวลาโดยไม่เก็บตำแหน่ง"}
        </p>
      </div>

      {/* Manage sections — visible to attendance.manage only */}
      {canManage && (
        <>
          {canUseGps && (
            <>
              <section className="bg-white rounded-lg border border-gray-200 p-4 max-w-3xl">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 className="text-sm font-semibold text-gray-900">ตั้งค่า GPS เข้างาน</h2>
                    <p className="text-xs text-gray-500">ดูค่า geofence ปัจจุบันและเปิด dialog เพื่อแก้ไข</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setAttendanceSettingsDialogOpen(true)}
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
              </section>

              {attendanceSettingsDialogOpen && (
                <AttendanceSettingsDialog
                  attendanceSettings={attendanceSettings}
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

          {/* Attendance records */}
          <div>
            <h2 className="text-sm font-medium text-gray-700 mb-2">
              รายการเข้า-ออกงาน ({records?.length ?? 0} รายการ)
            </h2>
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
                                : r.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
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
  onClose,
}: {
  attendanceSettings: AttendanceSettings | null;
  onClose: () => void;
}) {
  const [settingsState, settingsAction, settingsPending] = useActionState(
    async (prev: { error: string | null; success?: boolean }, fd: FormData) => {
      const result = await saveAttendanceSettingsAction(prev, fd);
      if (!result.error) onClose();
      return result;
    },
    { error: null, success: false },
  );

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
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="text-xs text-gray-500">
            Latitude
            <input
              name="geofenceCenterLat"
              type="number"
              step="0.000001"
              min="-90"
              max="90"
              defaultValue={attendanceSettings?.geofenceCenterLat ?? ""}
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
              defaultValue={attendanceSettings?.geofenceCenterLng ?? ""}
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
              defaultValue={attendanceSettings?.geofenceRadiusMeters ?? ""}
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
        <button
          type="submit"
          disabled={settingsPending}
          className="px-3 py-1.5 text-sm bg-gray-900 text-white rounded disabled:opacity-40"
        >
          {settingsPending ? "กำลังบันทึก..." : "บันทึกการตั้งค่า"}
        </button>
      </form>
    </ModalDialog>
  );
}
