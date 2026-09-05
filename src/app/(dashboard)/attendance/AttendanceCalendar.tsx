"use client";

import { useMemo, useState } from "react";
import type { AttendanceRecord } from "@/modules/attendance/types";
import type { DayStatus } from "@/modules/attendance/calendar";
import { formatStoreTime } from "@/modules/attendance/date";

const WEEKDAYS = ["อา", "จ", "อ", "พ", "พฤ", "ศ", "ส"];

type StatusKey = Exclude<DayStatus, "off">;

// Per-day status palette + labels (ใช้ร่วมกันทั้งปฏิทินส่วนตัวและปฏิทินทีม)
const STATUS_META: Record<StatusKey, { cell: string; dot: string; text: string; label: string }> = {
  completed: { cell: "bg-green-50 border-green-200", dot: "bg-green-500", text: "text-green-700", label: "ครบ" },
  late: { cell: "bg-orange-50 border-orange-200", dot: "bg-orange-500", text: "text-orange-700", label: "มาสาย" },
  half_day: { cell: "bg-yellow-50 border-yellow-300", dot: "bg-yellow-500", text: "text-yellow-800", label: "ครึ่งวัน" },
  in_no_out: { cell: "bg-amber-50 border-amber-200", dot: "bg-amber-400", text: "text-amber-700", label: "เข้าไม่ออก" },
  leave: { cell: "bg-blue-50 border-blue-200", dot: "bg-blue-500", text: "text-blue-700", label: "ลา" },
  absent: { cell: "bg-red-50 border-red-200", dot: "bg-red-500", text: "text-red-700", label: "ขาดงาน" },
  holiday: { cell: "bg-gray-100 border-gray-200", dot: "bg-gray-400", text: "text-gray-600", label: "วันหยุด" },
  holiday_open: {
    cell: "bg-gray-100 border-gray-300",
    dot: "bg-gray-500",
    text: "text-gray-600",
    label: "วันหยุด (ไม่คิดเงิน)",
  },
};

const LEGEND_ORDER: StatusKey[] = [
  "completed",
  "late",
  "half_day",
  "in_no_out",
  "absent",
  "leave",
  "holiday",
  "holiday_open",
];

/** ยิ่งเลขมาก = ยิ่งต้องรีบเห็น — ใช้เลือกสีพื้นของช่องวันในโหมดทีม */
const SEVERITY: Record<StatusKey, number> = {
  absent: 6,
  in_no_out: 5,
  half_day: 4,
  late: 3,
  leave: 2,
  holiday_open: 1,
  completed: 1,
  holiday: 0,
};

interface Props {
  records: AttendanceRecord[];
  month: string; // "YYYY-MM"
  employees: { userId: string; name: string }[];
  title?: string;
  /** Personal mode: per-date status drives cell colour + a full legend. */
  dayStatus?: Record<string, DayStatus>;
  /** Team mode: per-date, per-employee status — makes absences and half days visible. */
  teamDayStatus?: Record<string, Record<string, DayStatus>>;
  /** Team mode: dates to shade as store holidays. */
  holidayDates?: string[];
  /** Team mode: per-employee leave/holiday dates from payroll adjustments. */
  employeeLeaveDates?: { date: string; userId: string; employeeName: string; note?: string }[];
  /** IANA timezone of the store — clock times are stored UTC and rendered in this zone. */
  timeZone: string;
}

function shortName(name: string): string {
  return name.split("@")[0].slice(0, 10);
}

export function AttendanceCalendar({
  records,
  month,
  employees,
  title = "ปฏิทินการเข้างาน",
  dayStatus,
  teamDayStatus,
  holidayDates,
  employeeLeaveDates,
  timeZone,
}: Props) {
  const [filterUser, setFilterUser] = useState<string>("");
  const fmtTime = (iso: string) => formatStoreTime(iso, timeZone);
  const personal = !!dayStatus;
  const holidaySet = useMemo(() => new Set(holidayDates ?? []), [holidayDates]);

  const [year, mon] = month.split("-").map(Number);
  const startWeekday = new Date(Date.UTC(year, mon - 1, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(year, mon, 0)).getUTCDate();

  const byDate = useMemo(() => {
    const map = new Map<string, AttendanceRecord[]>();
    for (const r of records) {
      if (!r.date.startsWith(month)) continue;
      if (filterUser && r.userId !== filterUser) continue;
      const next = map.get(r.date) ?? [];
      next.push(r);
      map.set(r.date, next);
    }
    return map;
  }, [records, month, filterUser]);

  const leaveByDate = useMemo(() => {
    const map = new Map<string, NonNullable<Props["employeeLeaveDates"]>>();
    for (const leave of employeeLeaveDates ?? []) {
      if (!leave.date.startsWith(month)) continue;
      if (filterUser && leave.userId !== filterUser) continue;
      const next = map.get(leave.date) ?? [];
      next.push(leave);
      map.set(leave.date, next);
    }
    return map;
  }, [employeeLeaveDates, month, filterUser]);

  const visibleEmployees = useMemo(
    () => (filterUser ? employees.filter((e) => e.userId === filterUser) : employees),
    [employees, filterUser],
  );

  /** โหมดทีม: รายชื่อพนักงานพร้อมสถานะของวันนั้น (เรียงตามความสำคัญ) */
  function teamEntries(date: string): { userId: string; name: string; status: StatusKey }[] {
    const perUser = teamDayStatus?.[date];
    if (!perUser) return [];
    return visibleEmployees
      .map((e) => ({ userId: e.userId, name: e.name, status: perUser[e.userId] }))
      .filter((e): e is { userId: string; name: string; status: StatusKey } => !!e.status && e.status !== "off")
      .sort((a, b) => SEVERITY[b.status] - SEVERITY[a.status] || a.name.localeCompare(b.name));
  }

  const cells: (number | null)[] = [];
  for (let i = 0; i < startWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  const legendKeys = personal || teamDayStatus ? LEGEND_ORDER : null;

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-gray-700">{title} ({month})</h2>
        {employees.length > 0 && (
          <select
            value={filterUser}
            onChange={(e) => setFilterUser(e.target.value)}
            className="rounded border border-gray-300 px-2 py-1 text-xs"
          >
            <option value="">ทุกคน</option>
            {employees.map((e) => (
              <option key={e.userId} value={e.userId}>{e.name}</option>
            ))}
          </select>
        )}
      </div>
      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white p-2">
        <div className="grid grid-cols-7 gap-1 min-w-[640px]">
          {WEEKDAYS.map((w) => (
            <div key={w} className="py-1 text-center text-xs font-semibold text-gray-400">{w}</div>
          ))}
          {cells.map((d, i) => {
            if (d === null) return <div key={`e${i}`} />;
            const date = `${month}-${String(d).padStart(2, "0")}`;
            const recs = byDate.get(date) ?? [];
            const status = dayStatus?.[date];
            const meta = status && status !== "off" ? STATUS_META[status] : null;
            const isHoliday = !personal && holidaySet.has(date);
            const leaves = !personal ? leaveByDate.get(date) ?? [] : [];
            const hasEmployeeLeave = leaves.length > 0;

            // โหมดทีม: สีพื้น + ป้ายมาจากสถานะที่ "แรงที่สุด" ของวันนั้น
            const entries = !personal ? teamEntries(date) : [];
            const worst = entries[0]?.status ?? null;
            const teamMeta = worst ? STATUS_META[worst] : null;
            const absentCount = entries.filter((e) => e.status === "absent").length;
            const recordByUser = new Map(recs.map((r) => [r.userId, r]));

            const cellClass = meta
              ? meta.cell
              : teamMeta
                ? teamMeta.cell
                : isHoliday
                  ? "bg-gray-100 border-gray-200"
                  : hasEmployeeLeave
                    ? "bg-blue-50 border-blue-200"
                    : "border-gray-100";

            return (
              <div key={date} className={`min-h-[64px] rounded border p-1 align-top ${cellClass}`}>
                <div className="flex items-center justify-between gap-1">
                  <p className="text-xs font-semibold text-gray-500">{d}</p>
                  {meta && (
                    <span className="inline-flex items-center gap-1 text-[10px] text-gray-600">
                      <span className={`inline-block h-1.5 w-1.5 rounded-full ${meta.dot}`} />
                      {meta.label}
                    </span>
                  )}
                  {!personal && absentCount > 0 && (
                    <span className="rounded bg-red-100 px-1 text-[10px] font-bold text-red-700">
                      ขาด {absentCount}
                    </span>
                  )}
                  {!personal && absentCount === 0 && teamMeta && worst !== "completed" && (
                    <span className={`text-[10px] ${teamMeta.text}`}>{teamMeta.label}</span>
                  )}
                  {!personal && !teamMeta && isHoliday && <span className="text-[10px] text-gray-500">หยุด</span>}
                  {!personal && !teamMeta && !isHoliday && hasEmployeeLeave && (
                    <span className="text-[10px] text-blue-600">ลา</span>
                  )}
                </div>
                <div className="space-y-0.5">
                  {personal &&
                    recs.slice(0, 1).map((r) => (
                      <p
                        key={r.id}
                        className="truncate text-[10px] leading-tight text-gray-600"
                        title={`${r.employeeName} ${fmtTime(r.clockInAt)}-${r.clockOutAt ? fmtTime(r.clockOutAt) : "?"}`}
                      >
                        {`${fmtTime(r.clockInAt)}-${r.clockOutAt ? fmtTime(r.clockOutAt) : "…"}`}
                      </p>
                    ))}

                  {/* โหมดทีม: หนึ่งบรรทัดต่อพนักงาน พร้อมจุดสีบอกสถานะ (เห็นคนขาดงานด้วย) */}
                  {!personal && teamDayStatus
                    ? entries.slice(0, 4).map((entry) => {
                        const rec = recordByUser.get(entry.userId);
                        const em = STATUS_META[entry.status];
                        return (
                          <p
                            key={entry.userId}
                            className={`truncate text-[10px] leading-tight ${em.text}`}
                            title={`${entry.name} · ${em.label}${
                              rec ? ` · ${fmtTime(rec.clockInAt)}-${rec.clockOutAt ? fmtTime(rec.clockOutAt) : "?"}` : ""
                            }`}
                          >
                            <span className={`mr-1 inline-block h-1.5 w-1.5 rounded-full align-middle ${em.dot}`} />
                            {shortName(entry.name)}
                            {entry.status !== "completed" ? ` · ${em.label}` : ""}
                          </p>
                        );
                      })
                    : null}
                  {!personal && !teamDayStatus
                    ? recs.slice(0, 3).map((r) => (
                        <p
                          key={r.id}
                          className="truncate text-[10px] leading-tight text-gray-600"
                          title={`${r.employeeName} ${fmtTime(r.clockInAt)}-${r.clockOutAt ? fmtTime(r.clockOutAt) : "?"}`}
                        >
                          • {shortName(r.employeeName)}
                        </p>
                      ))
                    : null}

                  {!personal && !teamDayStatus &&
                    leaves.slice(0, 2).map((leave) => (
                      <p
                        key={`${leave.userId}-${leave.date}`}
                        className="truncate text-[10px] leading-tight text-blue-700"
                        title={`${leave.employeeName} วันลาพนักงาน${leave.note ? ` · ${leave.note}` : ""}`}
                      >
                        ลา {shortName(leave.employeeName)}
                      </p>
                    ))}
                  {!personal && teamDayStatus && entries.length > 4 && (
                    <p className="text-[10px] text-gray-400">+{entries.length - 4} คน</p>
                  )}
                  {!personal && !teamDayStatus && recs.length > 3 && (
                    <p className="text-[10px] text-gray-400">+{recs.length - 3}</p>
                  )}
                  {!personal && !teamDayStatus && leaves.length > 2 && (
                    <p className="text-[10px] text-blue-500">+{leaves.length - 2} ลา</p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Legend */}
      {legendKeys ? (
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
          {legendKeys.map((k) => (
            <span key={k} className="inline-flex items-center gap-1.5 text-[11px] text-gray-500">
              <span className={`inline-block h-2 w-2 rounded-full ${STATUS_META[k].dot}`} />
              {STATUS_META[k].label}
            </span>
          ))}
        </div>
      ) : (
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-gray-500">
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-full bg-green-500" /> มีบันทึกเข้างาน
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-sm bg-gray-300" /> วันหยุดร้าน
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-sm bg-blue-300" /> วันลาพนักงาน
          </span>
        </div>
      )}
    </div>
  );
}
