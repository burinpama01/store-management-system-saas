"use client";

import type { Table } from "@/modules/stores/types";

const STATUS_LABEL: Record<Table["status"], string> = {
  available: "ว่าง",
  occupied: "มีลูกค้า",
  reserved: "จองแล้ว",
  cleaning: "กำลังทำความสะอาด",
};

const STATUS_STYLE: Record<Table["status"], string> = {
  available: "border-emerald-200 bg-emerald-50 text-emerald-800",
  occupied: "border-amber-200 bg-amber-50 text-amber-800",
  reserved: "border-blue-200 bg-blue-50 text-blue-800",
  cleaning: "border-slate-200 bg-slate-100 text-slate-700",
};

export function TableStatusBoard({ tables }: { tables: Table[] }) {
  if (tables.length === 0) {
    return (
      <section className="rounded-lg border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
        ยังไม่มีโต๊ะที่เปิดใช้งาน
      </section>
    );
  }

  return (
    <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {tables.map((table) => (
        <article
          key={table.id}
          className={`rounded-lg border p-4 ${STATUS_STYLE[table.status]}`}
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs font-bold uppercase tracking-wide opacity-70">โต๊ะ</p>
              <h2 className="mt-1 text-2xl font-bold">{table.label ?? table.number}</h2>
              {table.seats && <p className="mt-1 text-sm opacity-80">{table.seats} ที่นั่ง</p>}
            </div>
            <span className="rounded-md bg-white/70 px-2.5 py-1 text-sm font-bold">
              {STATUS_LABEL[table.status]}
            </span>
          </div>
          <p className="mt-4 text-xs opacity-70">
            อัปเดตล่าสุด {new Date(table.updatedAt).toLocaleString("th-TH")}
          </p>
        </article>
      ))}
    </section>
  );
}
