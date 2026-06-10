"use client";

import { useMemo, useState } from "react";
import type { AttendanceRecord } from "@/modules/attendance/types";
import type { DayStatus } from "@/modules/attendance/calendar";

const WEEKDAYS = ["อา", "จ", "อ", "พ", "พฤ", "ศ", "ส"];

function fmtTime(iso: string) {
  return iso.slice(11, 16);
}

// Per-day status palette + labels for the personal calendar.
const STATUS_META: Record<Exclude<DayStatus, "off">, { cell: string; dot: string; label: string }> = {
  completed: { cell: "bg-green-50 border-green-200", dot: "bg-green-500", label: "ครบ" },
  late: { cell: "bg-orange-50 border-orange-200", dot: "bg-orange-500", label: "มาสาย" },
  in_no_out: { cell: "bg-amber-50 border-amber-200", dot: "bg-amber-400", label: "เข้าไม่ออก" },
  leave: { cell: "bg-blue-50 border-blue-200", dot: "bg-blue-500", label: "ลา" },
  absent: { cell: "bg-red-50 border-red-200", dot: "bg-red-500", label: "ขาดงาน" },
  holiday: { cell: "bg-gray-100 border-gray-200", dot: "bg-gray-400", label: "วันหยุด" },
};
const LEGEND_ORDER: Exclude<DayStatus, "off">[] = ["completed", "late", "in_no_out", "absent", "leave", "holiday"];

interface Props {
  records: AttendanceRecord[];
  month: string; // "YYYY-MM"
  employees: { userId: string; name: string }[];
  title?: string;
  /** Personal mode: per-date status drives cell colour + a full legend. */
  dayStatus?: Record<string, DayStatus>;
  /** Team mode: dates to shade as store holidays. */
  holidayDates?: string[];
}

export function AttendanceCalendar({
  records,
  month,
  employees,
  title = "ปฏิทินการเข้างาน",
  dayStatus,
  holidayDates,
}: Props) {
  const [filterUser, setFilterUser] = useState<string>("");
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

  const cells: (number | null)[] = [];
  for (let i = 0; i < startWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

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
            return (
              <div
                key={date}
                className={`min-h-[64px] rounded border p-1 align-top ${
                  meta ? meta.cell : isHoliday ? "bg-gray-100 border-gray-200" : "border-gray-100"
                }`}
              >
                <div className="flex items-center justify-between">
                  <p className="text-xs font-semibold text-gray-500">{d}</p>
                  {meta && (
                    <span className="inline-flex items-center gap-1 text-[10px] text-gray-600">
                      <span className={`inline-block h-1.5 w-1.5 rounded-full ${meta.dot}`} />
                      {meta.label}
                    </span>
                  )}
                  {!personal && isHoliday && <span className="text-[10px] text-gray-500">หยุด</span>}
                </div>
                <div className="space-y-0.5">
                  {recs.slice(0, personal ? 1 : 3).map((r) => (
                    <p
                      key={r.id}
                      className="truncate text-[10px] leading-tight text-gray-600"
                      title={`${r.employeeName} ${fmtTime(r.clockInAt)}-${r.clockOutAt ? fmtTime(r.clockOutAt) : "?"}`}
                    >
                      {personal
                        ? `${fmtTime(r.clockInAt)}-${r.clockOutAt ? fmtTime(r.clockOutAt) : "…"}`
                        : `• ${r.employeeName.split("@")[0].slice(0, 8)}`}
                    </p>
                  ))}
                  {!personal && recs.length > 3 && <p className="text-[10px] text-gray-400">+{recs.length - 3}</p>}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Legend */}
      {personal ? (
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
          {LEGEND_ORDER.map((k) => (
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
        </div>
      )}
    </div>
  );
}
