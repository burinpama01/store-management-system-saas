"use client";

import { useMemo, useState } from "react";
import type { AttendanceRecord } from "@/modules/attendance/types";

const WEEKDAYS = ["อา", "จ", "อ", "พ", "พฤ", "ศ", "ส"];

function fmtTime(iso: string) {
  return iso.slice(11, 16);
}

type StatusKey = "completed" | "active" | "backdated" | "adjusted";

const STATUS_META: Record<StatusKey, { dot: string; label: string }> = {
  completed: { dot: "bg-green-500", label: "ครบ (เข้า-ออก)" },
  active: { dot: "bg-amber-400", label: "กำลังทำงาน (ยังไม่ออก)" },
  backdated: { dot: "bg-blue-400", label: "เพิ่มย้อนหลัง" },
  adjusted: { dot: "bg-purple-400", label: "แก้ไขแล้ว" },
};

function statusOf(r: AttendanceRecord): StatusKey {
  if (r.status === "backdated") return "backdated";
  if (r.status === "adjusted") return "adjusted";
  return r.clockOutAt ? "completed" : "active";
}

/** Read-only month calendar of clock-in/out records (#5). Month derived from `month` = "YYYY-MM". */
export function AttendanceCalendar({
  records,
  month,
  employees,
  title = "ปฏิทินการเข้างาน",
}: {
  records: AttendanceRecord[];
  month: string;
  employees: { userId: string; name: string }[];
  title?: string;
}) {
  const [filterUser, setFilterUser] = useState<string>("");

  const [year, mon] = month.split("-").map(Number);
  const firstDay = new Date(Date.UTC(year, mon - 1, 1));
  const startWeekday = firstDay.getUTCDay();
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
            return (
              <div key={date} className="min-h-[64px] rounded border border-gray-100 p-1 align-top">
                <p className="text-xs font-semibold text-gray-500">{d}</p>
                <div className="space-y-0.5">
                  {recs.slice(0, 3).map((r) => {
                    const meta = STATUS_META[statusOf(r)];
                    return (
                      <p
                        key={r.id}
                        className="truncate text-[10px] leading-tight text-gray-600"
                        title={`${r.employeeName} ${fmtTime(r.clockInAt)}-${r.clockOutAt ? fmtTime(r.clockOutAt) : "?"} · ${meta.label}`}
                      >
                        <span className={`inline-block h-1.5 w-1.5 rounded-full ${meta.dot}`} />{" "}
                        {filterUser ? `${fmtTime(r.clockInAt)}-${r.clockOutAt ? fmtTime(r.clockOutAt) : "…"}` : r.employeeName.split("@")[0].slice(0, 8)}
                      </p>
                    );
                  })}
                  {recs.length > 3 && <p className="text-[10px] text-gray-400">+{recs.length - 3}</p>}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Legend */}
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
        {(Object.keys(STATUS_META) as StatusKey[]).map((k) => (
          <span key={k} className="inline-flex items-center gap-1.5 text-[11px] text-gray-500">
            <span className={`inline-block h-2 w-2 rounded-full ${STATUS_META[k].dot}`} />
            {STATUS_META[k].label}
          </span>
        ))}
      </div>
    </div>
  );
}
