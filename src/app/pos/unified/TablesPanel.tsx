"use client";

// U9 — Tables panel ของ unified shell: แสดงบริบทโต๊ะ + เลือกโต๊ะเข้า context กลาง
// U9 ยังไม่มี action เปิดโต๊ะ/ปิดบิลจากแท็บนี้ (งาน U10/U11) — dialog เดียวคือรายละเอียดโต๊ะ

import { useCallback, useEffect, useRef, useState } from "react";
import type { UnifiedTableSummary } from "./types";

const STATUS_META: Record<
  UnifiedTableSummary["status"],
  { label: string; dotClass: string }
> = {
  available: { label: "ว่าง", dotClass: "bg-green-500" },
  occupied: { label: "มีลูกค้า", dotClass: "bg-orange-500" },
  reserved: { label: "จอง", dotClass: "bg-violet-500" },
  cleaning: { label: "กำลังเก็บ", dotClass: "bg-gray-400" },
};

interface TablesPanelProps {
  readonly tables: readonly UnifiedTableSummary[];
  readonly selectedTableId: string | null;
  readonly onSelectTable: (table: UnifiedTableSummary) => void;
}

export function TablesPanel({ tables, selectedTableId, onSelectTable }: TablesPanelProps) {
  const [detailTable, setDetailTable] = useState<UnifiedTableSummary | null>(null);
  // state ของ dialog เป็นของแท็บนี้เท่านั้น (isolated per tab) — สลับแท็บแล้วคงสถานะไว้
  const detailTriggerRef = useRef<HTMLButtonElement | null>(null);
  const detailCloseRef = useRef<HTMLButtonElement | null>(null);

  const closeDetail = useCallback(() => {
    setDetailTable(null);
    detailTriggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!detailTable) return;
    detailCloseRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeDetail();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [detailTable, closeDetail]);

  if (tables.length === 0) {
    return (
      <div className="rounded-xl border border-gray-200 bg-white p-6 text-center text-sm text-gray-500">
        ยังไม่มีโต๊ะในร้านนี้ — เพิ่มโต๊ะได้ที่ ตั้งค่า &gt; โต๊ะ
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-gray-600">
        เลือกโต๊ะเพื่อใช้เป็นบริบทร่วมของแท็บขาย (สถานะค้างเตือนเชื่อมคิวครัวในรอบถัดไป)
      </p>
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {tables.map((table) => {
          const meta = STATUS_META[table.status];
          const isSelected = table.id === selectedTableId;
          return (
            <li
              key={table.id}
              className={`rounded-xl border bg-white p-4 transition-colors motion-reduce:transition-none ${
                isSelected ? "border-orange-500 ring-2 ring-orange-200" : "border-gray-200"
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-base font-semibold text-gray-900">
                    โต๊ะ {table.number}
                    {table.label ? <span className="text-gray-500"> · {table.label}</span> : null}
                  </p>
                  <p className="mt-1 flex items-center gap-1.5 text-sm text-gray-600">
                    <span aria-hidden="true" className={`inline-block h-2 w-2 rounded-full ${meta.dotClass}`} />
                    <span>
                      {meta.label}
                      {table.seats ? ` · ${table.seats} ที่นั่ง` : ""}
                    </span>
                  </p>
                </div>
                {isSelected ? (
                  <span className="shrink-0 rounded-full bg-orange-100 px-2 py-0.5 text-xs font-medium text-orange-800">
                    เลือกอยู่
                  </span>
                ) : null}
              </div>
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  onClick={() => onSelectTable(table)}
                  aria-pressed={isSelected}
                  className={`min-h-9 flex-1 rounded-lg px-3 py-1.5 text-sm font-semibold border transition-colors motion-reduce:transition-none ${
                    isSelected
                      ? "border-orange-500 bg-orange-500 text-white hover:bg-orange-600"
                      : "border-gray-300 bg-white text-gray-900 hover:bg-gray-50"
                  }`}
                >
                  {isSelected ? "เลือกอยู่" : "เลือกโต๊ะ"}
                </button>
                <button
                  type="button"
                  ref={table.id === detailTable?.id ? detailTriggerRef : undefined}
                  onClick={() => setDetailTable(table)}
                  className="min-h-9 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 transition-colors motion-reduce:transition-none"
                >
                  รายละเอียด
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      {detailTable ? (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center"
          onClick={closeDetail}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="unified-table-detail-title"
            className="w-full max-w-md rounded-xl border border-gray-200 bg-white p-5 shadow-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <h3 id="unified-table-detail-title" className="text-lg font-semibold text-gray-900">
              รายละเอียดโต๊ะ {detailTable.number}
            </h3>
            <dl className="mt-3 space-y-2 text-sm text-gray-700">
              <div className="flex justify-between gap-4">
                <dt className="text-gray-500">ชื่อ</dt>
                <dd className="text-right">{detailTable.label ?? "—"}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-gray-500">สถานะ</dt>
                <dd className="text-right">{STATUS_META[detailTable.status].label}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-gray-500">ที่นั่ง</dt>
                <dd className="text-right">{detailTable.seats ?? "—"}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-gray-500">เริ่มรอบล่าสุด</dt>
                <dd className="text-right">
                  {detailTable.sessionStartedAt
                    ? new Date(detailTable.sessionStartedAt).toLocaleString("th-TH")
                    : "—"}
                </dd>
              </div>
            </dl>
            <p className="mt-3 text-xs text-gray-500">
              เครื่องมือเปิดโต๊ะ/ปิดบิลจากหน้านี้จะเปิดใช้ในรอบถัดไป
            </p>
            <div className="mt-4 flex justify-end">
              <button
                type="button"
                ref={detailCloseRef}
                onClick={closeDetail}
                className="min-h-10 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-900 hover:bg-gray-50 transition-colors motion-reduce:transition-none"
              >
                ปิด
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
