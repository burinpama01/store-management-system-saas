"use client";

import type { ReactNode } from "react";

interface Column<T> {
  key: string;
  header: string;
  cell: (row: T) => ReactNode;
  align?: "left" | "right" | "center";
  width?: string;
}

interface Props<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  emptyMessage?: string;
  compact?: boolean;
}

const ALIGN_CLASS: Record<NonNullable<Column<unknown>["align"]>, string> = {
  left: "text-left",
  right: "text-right",
  center: "text-center",
};

export function Table<T>({ columns, rows, rowKey, emptyMessage = "ไม่มีข้อมูล", compact }: Props<T>) {
  const cellPy = compact ? "py-1.5" : "py-2.5";

  return (
    <div className="table-surface overflow-x-auto">
      <table className="w-full text-sm border-collapse">
        <thead className="bg-[var(--color-surface-muted)]">
          <tr className="border-b border-[var(--color-border)]">
            {columns.map((col) => (
              <th
                key={col.key}
                style={col.width ? { width: col.width } : undefined}
                className={`px-3 py-2 text-xs font-bold text-[var(--color-text-secondary)] whitespace-nowrap ${ALIGN_CLASS[col.align ?? "left"]}`}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--color-border)]">
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="px-3 py-8 text-center text-xs text-[var(--color-text-muted)]">
                {emptyMessage}
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr key={rowKey(row)} className="hover:bg-[var(--color-surface-muted)] transition-colors">
                {columns.map((col) => (
                  <td
                    key={col.key}
                    className={`px-3 ${cellPy} ${ALIGN_CLASS[col.align ?? "left"]} text-[var(--color-text-primary)] whitespace-nowrap`}
                  >
                    {col.cell(row)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
