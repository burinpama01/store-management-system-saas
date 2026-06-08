"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Table } from "@/modules/stores/types";
import { QrCode } from "@/shared/components/ui/QrCode";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { saveTableAction, deleteTableAction } from "./actions";

interface Props {
  tables: Table[];
  storeSlug: string;
  qrOrderingEnabled: boolean;
  baseUrl: string;
}

export function TablesManager({ tables, storeSlug, qrOrderingEnabled, baseUrl }: Props) {
  const router = useRouter();
  const [editing, setEditing] = useState<Table | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [confirmDel, setConfirmDel] = useState<Table | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function qrUrl(t: Table) {
    return `${baseUrl}/qr/${storeSlug}/${t.id}`;
  }

  function run(action: () => Promise<{ error: string | null }>, onOk?: () => void) {
    setError(null);
    startTransition(async () => {
      const res = await action();
      if (res.error) setError(res.error);
      else {
        onOk?.();
        router.refresh();
      }
    });
  }

  function openCreate() {
    setEditing(null);
    setShowForm(true);
    setError(null);
  }
  function openEdit(t: Table) {
    setEditing(t);
    setShowForm(true);
    setError(null);
  }

  return (
    <div className="space-y-4">
      <ConfirmDialog
        open={!!confirmDel}
        title="ลบโต๊ะ"
        message={`ลบโต๊ะ ${confirmDel?.number ?? ""}? (ออร์เดอร์เก่าจะไม่ถูกลบ)`}
        confirmLabel="ลบ"
        danger
        onConfirm={() => {
          const t = confirmDel;
          setConfirmDel(null);
          if (t) run(() => deleteTableAction(t.id));
        }}
        onCancel={() => setConfirmDel(null)}
      />

      <div className="flex items-center justify-between gap-2 print:hidden">
        <div>
          <h2 className="text-base font-bold text-gray-900">โต๊ะ &amp; QR Code</h2>
          <p className="text-xs text-gray-500">จัดการโต๊ะและสร้าง QR ให้ลูกค้าสแกนสั่งอาหาร</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => window.print()} className="btn-secondary min-h-11 px-3 text-sm">พิมพ์ QR ทุกโต๊ะ</button>
          <button onClick={openCreate} className="btn-primary min-h-11 px-3 text-sm">+ เพิ่มโต๊ะ</button>
        </div>
      </div>

      {!qrOrderingEnabled && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700 print:hidden">
          QR Ordering ยังปิดอยู่ — เปิดได้ที่ ตั้งค่า › ร้านค้า เพื่อให้ลูกค้าสแกนสั่งได้
        </p>
      )}
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600 print:hidden">{error}</p>}

      {showForm && (
        <form
          action={(fd) => run(() => saveTableAction(fd), () => setShowForm(false))}
          className="grid gap-3 rounded-lg border border-gray-200 bg-white p-4 sm:grid-cols-2 lg:grid-cols-4 print:hidden"
        >
          {editing && <input type="hidden" name="id" value={editing.id} />}
          <label className="text-xs font-medium text-gray-600">
            เลขโต๊ะ *
            <input name="number" required defaultValue={editing?.number ?? ""} className="mt-1 w-full min-h-11 rounded-lg border border-gray-300 px-3 text-sm" />
          </label>
          <label className="text-xs font-medium text-gray-600">
            ชื่อ/ป้าย
            <input name="label" defaultValue={editing?.label ?? ""} className="mt-1 w-full min-h-11 rounded-lg border border-gray-300 px-3 text-sm" />
          </label>
          <label className="text-xs font-medium text-gray-600">
            ที่นั่ง
            <input name="seats" type="number" min={0} max={100} defaultValue={editing?.seats ?? ""} className="mt-1 w-full min-h-11 rounded-lg border border-gray-300 px-3 text-sm" />
          </label>
          <div className="flex items-end gap-3">
            <label className="flex items-center gap-1.5 text-xs text-gray-600">
              <input type="checkbox" name="isActive" defaultChecked={editing ? editing.isActive : true} className="accent-orange-500" /> เปิดใช้
            </label>
            <label className="flex items-center gap-1.5 text-xs text-gray-600">
              <input type="checkbox" name="qrEnabled" defaultChecked={editing ? editing.qrEnabled : true} className="accent-orange-500" /> QR
            </label>
          </div>
          <div className="flex gap-2 lg:col-span-4">
            <button type="button" onClick={() => setShowForm(false)} className="btn-secondary min-h-11 flex-1 text-sm">ยกเลิก</button>
            <button type="submit" disabled={isPending} className="btn-primary min-h-11 flex-1 text-sm">
              {editing ? "บันทึก" : "เพิ่มโต๊ะ"}
            </button>
          </div>
        </form>
      )}

      {tables.length === 0 ? (
        <p className="rounded-lg border border-dashed border-gray-300 bg-white p-8 text-center text-sm text-gray-400 print:hidden">
          ยังไม่มีโต๊ะ — กด “เพิ่มโต๊ะ”
        </p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 print:grid-cols-3">
          {tables.map((t) => (
            <div key={t.id} className="flex flex-col items-center rounded-lg border border-gray-200 bg-white p-4 break-inside-avoid">
              <div className="mb-1 flex w-full items-center justify-between print:hidden">
                <span className="text-sm font-bold text-gray-900">
                  โต๊ะ {t.number}{t.label ? ` · ${t.label}` : ""}
                </span>
                <span className="flex gap-1">
                  {!t.isActive && <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500">ปิด</span>}
                  {!t.qrEnabled && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700">ไม่มี QR</span>}
                </span>
              </div>
              <p className="mb-2 hidden text-center text-sm font-bold print:block">โต๊ะ {t.number}{t.label ? ` · ${t.label}` : ""}</p>

              {baseUrl && t.qrEnabled ? (
                <QrCode value={qrUrl(t)} size={150} />
              ) : (
                <div className="flex h-[150px] w-[150px] items-center justify-center rounded bg-gray-50 text-xs text-gray-400">
                  {t.qrEnabled ? "..." : "QR ปิดอยู่"}
                </div>
              )}

              <div className="mt-3 flex w-full gap-2 print:hidden">
                <button
                  onClick={() => navigator.clipboard?.writeText(qrUrl(t))}
                  className="btn-secondary min-h-9 flex-1 text-xs"
                >
                  คัดลอกลิงก์
                </button>
                <button onClick={() => openEdit(t)} className="btn-secondary min-h-9 px-3 text-xs">แก้ไข</button>
                <button onClick={() => setConfirmDel(t)} className="min-h-9 px-2 text-xs text-red-500">ลบ</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
