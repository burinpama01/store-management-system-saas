"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { SelfInfoRequestView } from "@/modules/hr/self-info-repository";
import { reviewSelfInfoRequestAction } from "./self-info-actions";

/** คำขอแก้ข้อมูลของพนักงานที่รออนุมัติ (แสดงบนสุดของแท็บพนักงาน) */
export function SelfInfoRequests({
  requests,
  nameOf,
}: {
  requests: SelfInfoRequestView[];
  nameOf: (userId: string) => string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [note, setNote] = useState("");

  if (requests.length === 0) return null;

  const review = (id: string, approve: boolean, reason: string | null) => {
    setError(null);
    startTransition(async () => {
      const res = await reviewSelfInfoRequestAction(id, approve, reason);
      if (res.error) setError(res.error);
      else {
        setRejecting(null);
        setNote("");
        router.refresh();
      }
    });
  };

  return (
    <section className="rounded-xl border border-amber-300 bg-amber-50 p-4">
      <h2 className="text-sm font-bold text-amber-900">คำขอแก้ข้อมูลรออนุมัติ ({requests.length})</h2>
      {error && <p className="mt-2 rounded-lg bg-red-50 p-2 text-sm text-red-700">{error}</p>}
      <ul className="mt-3 space-y-3">
        {requests.map((r) => (
          <li key={r.id} className="rounded-lg border border-amber-200 bg-white p-3">
            <p className="text-sm font-semibold text-gray-900">{nameOf(r.userId)}</p>
            <dl className="mt-1 space-y-0.5 text-sm text-gray-700">
              {r.changes.map((c) => (
                <div key={c.field} className="flex flex-wrap gap-x-2">
                  <dt className="text-gray-500">{c.label}</dt>
                  <dd className="font-medium">{c.value ?? <span className="text-red-600">ขอลบค่านี้</span>}</dd>
                </div>
              ))}
            </dl>
            {rejecting === r.id ? (
              <div className="mt-3 space-y-2">
                <input
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  maxLength={300}
                  placeholder="เหตุผล (ไม่บังคับ)"
                  aria-label="เหตุผลที่ปฏิเสธ"
                  className="w-full min-h-11 rounded-lg border border-gray-300 px-3"
                  style={{ fontSize: 16 }}
                />
                <div className="flex flex-wrap gap-2">
                  <button type="button" disabled={pending} onClick={() => review(r.id, false, note.trim() || null)} className="btn-secondary min-h-11 px-4 text-sm text-red-700">
                    ยืนยันปฏิเสธ
                  </button>
                  <button type="button" disabled={pending} onClick={() => setRejecting(null)} className="btn-secondary min-h-11 px-4 text-sm">
                    กลับ
                  </button>
                </div>
              </div>
            ) : (
              <div className="mt-3 flex flex-wrap gap-2">
                <button type="button" disabled={pending} onClick={() => review(r.id, true, null)} className="btn-primary min-h-11 px-4 text-sm">
                  อนุมัติ
                </button>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => {
                    setRejecting(r.id);
                    setNote("");
                  }}
                  className="btn-secondary min-h-11 px-4 text-sm"
                >
                  ปฏิเสธ
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
