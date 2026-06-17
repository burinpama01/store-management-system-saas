"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import { listTablesForOpenAction, openTableAction, closeTableAction, type OpenTableStatus } from "./actions";

interface Props {
  onClose: () => void;
  onSelectTable?: (table: OpenTableStatus) => void;
}

function remaining(expiresAt: string | null): string {
  if (!expiresAt) return "";
  const mins = Math.round((Date.parse(expiresAt) - Date.now()) / 60000);
  if (mins <= 0) return "หมดเวลา";
  return `เหลือ ${mins} นาที`;
}

export function TableOpenModal({ onClose, onSelectTable }: Props) {
  const [tables, setTables] = useState<OpenTableStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const load = useCallback(() => {
    startTransition(async () => {
      setLoading(true);
      const res = await listTablesForOpenAction();
      if (res.error) setError(res.error);
      else setTables(res.tables);
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function open(t: OpenTableStatus) {
    setError(null);
    startTransition(async () => {
      const res = await openTableAction(t.id);
      if (res.error) {
        setError(res.error);
        return;
      }
      // Open the printable table receipt (QR + valid-until) in a new tab.
      window.open(`/table-receipt?tableId=${t.id}`, "_blank", "noopener,noreferrer");
      load();
    });
  }

  function close(t: OpenTableStatus) {
    setError(null);
    if (t.unpaidCount > 0) {
      const ok = window.confirm(
        `โต๊ะ ${t.label ?? t.number} ยังมีบิลค้าง ${t.unpaidCount} รายการ รวม ${new Intl.NumberFormat("th-TH").format(t.unpaidTotal)} บาท\n\nปิดโต๊ะโดยยังไม่เก็บเงิน? (ออร์เดอร์ยังเช็คบิลได้ภายหลังที่ "เช็คบิลโต๊ะ")`,
      );
      if (!ok) return;
    }
    startTransition(async () => {
      const res = await closeTableAction(t.id);
      if (res.error) setError(res.error);
      else load();
    });
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={isPending ? undefined : onClose} />
      <div className="relative flex max-h-[90vh] w-full max-w-md flex-col rounded-2xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
          <h2 className="text-base font-bold text-gray-900">เปิดโต๊ะ (à la carte)</h2>
          <button onClick={onClose} className="min-h-9 min-w-9 text-gray-400">✕</button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          {error && <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}
          {loading ? (
            <p className="py-8 text-center text-sm text-gray-400">กำลังโหลด...</p>
          ) : tables.length === 0 ? (
            <p className="py-8 text-center text-sm text-gray-400">ยังไม่มีโต๊ะ (เพิ่มได้ที่ ตั้งค่า › โต๊ะ &amp; QR)</p>
          ) : (
            <ul className="grid grid-cols-2 gap-2">
              {tables.map((t) => (
                <li key={t.id} className={`rounded-xl border p-3 ${t.occupied ? "border-amber-200 bg-amber-50" : "border-gray-200"}`}>
                  <p className="text-sm font-bold text-gray-900">โต๊ะ {t.label ?? t.number}</p>
                  {t.occupied ? (
                    <>
                      <p className="text-xs text-amber-700">เปิดอยู่ · {remaining(t.expiresAt)}</p>
                      {t.unpaidCount > 0 && (
                        <p className="text-xs font-semibold text-red-600">
                          บิลค้าง {t.unpaidCount} รายการ · ฿{new Intl.NumberFormat("th-TH").format(t.unpaidTotal)}
                        </p>
                      )}
                      <div className="mt-2 flex gap-1">
                        <a
                          href={`/table-receipt?tableId=${t.id}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="btn-secondary min-h-9 flex-1 text-center text-xs"
                        >
                          ใบ/QR
                        </a>
                        {onSelectTable && (
                          <button
                            onClick={() => {
                              onSelectTable(t);
                              onClose();
                            }}
                            disabled={isPending}
                            className="min-h-9 px-2 text-xs text-teal-600"
                          >
                            ใช้กับตั๋ว
                          </button>
                        )}
                        <button onClick={() => close(t)} disabled={isPending} className="min-h-9 px-2 text-xs text-red-500">ปิด</button>
                      </div>
                    </>
                  ) : (
                    <button onClick={() => open(t)} disabled={isPending} className="btn-primary mt-2 min-h-9 w-full text-xs">
                      เปิดโต๊ะ + พิมพ์ QR
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
