"use client";

import { useRouter } from "next/navigation";
import { useActionState, useState } from "react";
import type { BuffetSession } from "@/modules/buffet/types";
import type { StoreTable } from "@/modules/buffet/repository";
import { ModalDialog } from "@/shared/components/ui";
import { createSessionAction, updateGuestCountAction, closeSessionAction } from "./actions";

function fmt(n: number) {
  return n.toLocaleString("th-TH", { minimumFractionDigits: 2 });
}

function fmtElapsed(startedAt: string): string {
  const mins = Math.floor((Date.now() - new Date(startedAt).getTime()) / 60_000);
  if (mins < 60) return `${mins} นาที`;
  return `${Math.floor(mins / 60)} ชม. ${mins % 60} นาที`;
}

interface Props {
  openSessions: BuffetSession[];
  closedToday: BuffetSession[];
  tables: StoreTable[];
  canManage: boolean;
}

export function BuffetManager({ openSessions, closedToday, tables, canManage }: Props) {
  const router = useRouter();
  const [sessionDialogOpen, setSessionDialogOpen] = useState(false);
  const [guestDialogSession, setGuestDialogSession] = useState<BuffetSession | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [closingId, setClosingId] = useState<string | null>(null);

  async function handleClose(id: string) {
    if (!confirm("ปิดเซสชันบุฟเฟต์นี้?")) return;
    setClosingId(id);
    setActionError(null);
    const result = await closeSessionAction(id);
    setClosingId(null);
    if (result.error) { setActionError(result.error); return; }
    router.refresh();
  }

  const tableLabel = (tableId: string | null) => {
    if (!tableId) return "—";
    const t = tables.find((t) => t.id === tableId);
    return t ? `โต๊ะ ${t.number}${t.label ? ` (${t.label})` : ""}` : "—";
  };

  return (
    <div className="page-shell">
      <h1 className="text-xl font-semibold text-gray-900">บุฟเฟต์</h1>

      {actionError && (
        <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">
          {actionError}
        </p>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        {canManage && (
          <>
            <div className="xl:col-span-1 bg-white rounded-lg border border-gray-200 p-4">
              <h2 className="font-medium text-gray-800 mb-2">เปิดเซสชันใหม่</h2>
              <p className="mb-4 text-sm text-gray-500">
                เริ่มโต๊ะบุฟเฟต์ผ่าน dialog แล้วคงพื้นที่หลักไว้สำหรับสถานะเซสชัน
              </p>
              <button
                type="button"
                onClick={() => setSessionDialogOpen(true)}
                className="w-full rounded bg-blue-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700"
              >
                เปิดเซสชันใหม่
              </button>
            </div>

            {sessionDialogOpen && (
              <BuffetSessionDialog
                tables={tables}
                onClose={() => setSessionDialogOpen(false)}
              />
            )}
          </>
        )}

        {guestDialogSession && (
          <BuffetGuestCountDialog
            session={guestDialogSession}
            onClose={() => setGuestDialogSession(null)}
            onUpdated={() => {
              setGuestDialogSession(null);
              router.refresh();
            }}
          />
        )}

        {/* Active sessions */}
        <div className={`${canManage ? "xl:col-span-2" : "xl:col-span-3"} space-y-3`}>
          <h2 className="text-sm font-medium text-gray-700">เซสชันที่เปิดอยู่ ({openSessions.length})</h2>

          {openSessions.length === 0 ? (
            <div className="bg-white rounded-lg border border-gray-200 px-4 py-8 text-center text-sm text-gray-400">
              ไม่มีเซสชันที่เปิดอยู่
            </div>
          ) : (
            openSessions.map((s) => (
              <SessionCard
                key={s.id}
                session={s}
                tableLabel={tableLabel(s.tableId)}
                onEditGuests={() => setGuestDialogSession(s)}
                onClose={() => handleClose(s.id)}
                closing={closingId === s.id}
                canManage={canManage}
              />
            ))
          )}

          {/* Closed today */}
          {closedToday.length > 0 && (
            <>
              <h2 className="text-sm font-medium text-gray-700 pt-2">ปิดแล้ววันนี้ ({closedToday.length})</h2>
              <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 text-xs text-gray-500 uppercase">
                    <tr>
                      <th className="px-3 py-2 text-left">โต๊ะ</th>
                      <th className="px-3 py-2 text-left">แพ็กเกจ</th>
                      <th className="px-3 py-2 text-right">คน</th>
                      <th className="px-3 py-2 text-right">ยอดรวม</th>
                      <th className="px-3 py-2 text-right">เวลา</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {closedToday.map((s) => (
                      <tr key={s.id} className="hover:bg-gray-50">
                        <td className="px-3 py-2 text-gray-600">{tableLabel(s.tableId)}</td>
                        <td className="px-3 py-2 text-gray-700">{s.packageName}</td>
                        <td className="px-3 py-2 text-right text-gray-600 tabular-nums">{s.guestCount}</td>
                        <td className="px-3 py-2 text-right font-medium tabular-nums text-green-700">
                          ฿{fmt(s.totalCharge)}
                        </td>
                        <td className="px-3 py-2 text-right text-gray-400 text-xs whitespace-nowrap">
                          {s.startedAt.slice(11, 16)} – {s.endedAt ? s.endedAt.slice(11, 16) : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function BuffetSessionDialog({
  tables,
  onClose,
}: {
  tables: StoreTable[];
  onClose: () => void;
}) {
  const [formState, formAction] = useActionState(
    async (prev: { error: string | null }, fd: FormData) => {
      const result = await createSessionAction(prev, fd);
      if (!result.error) onClose();
      return result;
    },
    { error: null },
  );

  return (
    <ModalDialog
      open
      title="เปิดเซสชันใหม่"
      onClose={onClose}
      size="md"
    >
      <form action={formAction} className="space-y-3">
        <div>
          <label className="block text-xs text-gray-500 mb-1">โต๊ะ (ไม่บังคับ)</label>
          <select
            name="tableId"
            className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            <option value="">— ไม่ระบุโต๊ะ —</option>
            {tables.map((t) => (
              <option key={t.id} value={t.id}>
                โต๊ะ {t.number}{t.label ? ` (${t.label})` : ""}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-xs text-gray-500 mb-1">ชื่อแพ็กเกจ</label>
          <input
            type="text"
            name="packageName"
            required
            maxLength={100}
            placeholder="เช่น บุฟเฟต์หมูกระทะ"
            className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>

        <div>
          <label className="block text-xs text-gray-500 mb-1">ราคาต่อคน (บาท)</label>
          <input
            type="number"
            name="pricePerGuest"
            min="0"
            step="1"
            required
            placeholder="299"
            className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>

        <div>
          <label className="block text-xs text-gray-500 mb-1">จำนวนคน</label>
          <input
            type="number"
            name="guestCount"
            min="1"
            max="500"
            required
            placeholder="2"
            className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>

        {formState.error && (
          <p className="text-xs text-red-600">{formState.error}</p>
        )}

        <button
          type="submit"
          className="w-full py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded transition-colors"
        >
          เปิดเซสชัน
        </button>
      </form>
    </ModalDialog>
  );
}

function BuffetGuestCountDialog({
  session,
  onClose,
  onUpdated,
}: {
  session: BuffetSession;
  onClose: () => void;
  onUpdated: () => void;
}) {
  const [guestCount, setGuestCount] = useState(String(session.guestCount));
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit() {
    const newCount = parseInt(guestCount, 10);
    if (!Number.isInteger(newCount) || newCount < 1 || newCount > 500) {
      setError("จำนวนคนต้องอยู่ระหว่าง 1–500");
      return;
    }
    setPending(true);
    setError(null);
    const result = await updateGuestCountAction(session.id, newCount);
    setPending(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    onUpdated();
  }

  return (
    <ModalDialog
      open
      title="แก้ไขจำนวนคน"
      onClose={onClose}
      size="sm"
    >
      <div className="space-y-3">
        <div>
          <p className="text-sm font-medium text-gray-800">{session.packageName}</p>
          <p className="text-xs text-gray-500">
            ปัจจุบัน {session.guestCount} คน · ฿{fmt(session.pricePerGuest)} ต่อคน
          </p>
        </div>
        <label className="block text-xs text-gray-500">
          จำนวนคน
          <input
            type="number"
            min="1"
            max="500"
            value={guestCount}
            onChange={(e) => setGuestCount(e.target.value)}
            className="mt-1 w-full border border-gray-300 rounded px-2 py-1.5 text-sm"
          />
        </label>
        {error && (
          <p className="text-xs text-red-600">{error}</p>
        )}
        <button
          type="button"
          onClick={handleSubmit}
          disabled={pending}
          className="w-full py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded disabled:opacity-40 transition-colors"
        >
          {pending ? "กำลังบันทึก..." : "บันทึกจำนวนคน"}
        </button>
      </div>
    </ModalDialog>
  );
}

function SessionCard({
  session,
  tableLabel,
  onEditGuests,
  onClose,
  closing,
  canManage,
}: {
  session: BuffetSession;
  tableLabel: string;
  onEditGuests: () => void;
  onClose: () => void;
  closing: boolean;
  canManage: boolean;
}) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <p className="font-medium text-gray-800">{session.packageName}</p>
          <p className="text-xs text-gray-500 mt-0.5">
            {tableLabel} · เริ่ม {session.startedAt.slice(11, 16)} น.
            · <span className="text-yellow-600">{fmtElapsed(session.startedAt)}</span>
          </p>
        </div>
        <div className="text-right shrink-0">
          <p className="text-lg font-semibold tabular-nums text-green-600">
            ฿{fmt(session.totalCharge)}
          </p>
          <p className="text-xs text-gray-400">
            ฿{fmt(session.pricePerGuest)} × {session.guestCount} คน
          </p>
        </div>
      </div>

      {canManage && (
        <div className="mt-3 space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={onEditGuests}
              disabled={closing}
              className="px-2 py-1 text-xs bg-gray-100 hover:bg-gray-200 rounded disabled:opacity-40 transition-colors"
            >
              แก้ไขจำนวนคน
            </button>
            <button
              onClick={onClose}
              disabled={closing}
              className="ml-auto px-3 py-1.5 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded disabled:opacity-40 transition-colors"
            >
              {closing ? "กำลังปิด..." : "ปิดเซสชัน"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
