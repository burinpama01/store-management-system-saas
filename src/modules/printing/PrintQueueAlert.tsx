"use client";

import { useCallback, useEffect, useState } from "react";
import { resolveUnknownPrintJobFromPosAction } from "@/app/pos/actions";

/**
 * แถบเตือน "งานพิมพ์ที่ต้องตรวจสอบ" บนหน้าขาย
 *
 * งานที่ Hub เคลมไปแล้วแต่ไม่รายงานผล (เน็ตหลุด/เครื่องดับกลางคัน) จะถูกตั้งเป็น unknown
 * ระบบ **ไม่พิมพ์ซ้ำให้เอง** เพราะกระดาษอาจออกไปแล้ว — เดาผิดข้างหนึ่งคือใบเสร็จซ้ำ
 * อีกข้างคือใบเสร็จหาย คนที่ตอบได้คือคนที่ยืนอยู่หน้าเครื่องพิมพ์ ซึ่งคือแคชเชียร์
 * ถ้าโชว์แค่ในหน้าตั้งค่า ร้านเล็กจะไม่มีวันเปิดเจอ งานก็ค้างเงียบไปเรื่อย ๆ
 *
 * วางเป็นการ์ดลอย (fixed) ไม่แทรกใน layout เพราะหน้าขายต้องไม่เลื่อนทั้งหน้า
 */

interface UnknownJob {
  id: string;
  jobKind: "receipt" | "station_ticket" | null;
  attempts: number;
  createdAt: string;
}

const POLL_INTERVAL_MS = 25_000;

function jobLabel(kind: UnknownJob["jobKind"]): string {
  if (kind === "station_ticket") return "ตั๋วครัว";
  if (kind === "receipt") return "ใบเสร็จ";
  return "งานพิมพ์";
}

export function PrintQueueAlert() {
  const [jobs, setJobs] = useState<UnknownJob[]>([]);
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** id ของงานที่ผู้ใช้กดซ่อนไว้ — งานใหม่ที่เข้ามาทีหลังต้องเด้งขึ้นเองอีกครั้ง */
  const [hiddenIds, setHiddenIds] = useState<string[]>([]);

  useEffect(() => {
    let alive = true;

    // subscribe แบบ polling: setState เกิดใน callback ของ fetch ไม่ใช่ในตัว effect
    const poll = () => {
      fetch("/api/print/queue-health", { cache: "no-store" })
        .then((res) => (res.ok ? res.json() : null))
        .then((data: { unknownJobList?: UnknownJob[] } | null) => {
          if (!alive || !data) return;
          setJobs(Array.isArray(data.unknownJobList) ? data.unknownJobList : []);
        })
        .catch(() => {
          // เน็ตสะดุดชั่วคราว — เก็บค่าล่าสุดไว้ ไม่รบกวนการขาย
        });
    };

    poll();
    const id = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const resolve = useCallback(
    async (jobId: string, resolution: "printed_confirmed" | "retried") => {
      setWorking(jobId);
      setError(null);
      const result = await resolveUnknownPrintJobFromPosAction({ jobId, resolution });
      setWorking(null);
      if (result.error) {
        setError(result.error);
        return;
      }
      setJobs((prev) => prev.filter((job) => job.id !== jobId));
      setHiddenIds((prev) => prev.filter((id) => id !== jobId));
    },
    [],
  );

  const visible = jobs.filter((job) => !hiddenIds.includes(job.id));
  if (visible.length === 0) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-4 left-4 z-50 w-[min(92vw,22rem)] rounded-[var(--radius-md)] border border-amber-300 bg-amber-50 p-3 shadow-lg"
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-semibold text-amber-900">
          ⚠️ งานพิมพ์ที่ต้องตรวจสอบ ({visible.length})
        </p>
        <button
          type="button"
          onClick={() => setHiddenIds(visible.map((job) => job.id))}
          aria-label="ซ่อนแถบนี้ไว้ก่อน"
          className="min-h-8 min-w-8 rounded text-amber-900/70 hover:text-amber-900"
        >
          ✕
        </button>
      </div>
      <p className="mt-1 text-[11px] text-amber-800">
        ระบบไม่ได้รับผลยืนยันจากเครื่องพิมพ์ ดูที่กระดาษก่อนแล้วเลือก — ระบบจะไม่พิมพ์ซ้ำให้เองเพื่อไม่ให้ได้ใบซ้ำ
      </p>
      <ul className="mt-2 max-h-52 space-y-2 overflow-y-auto">
        {visible.map((job) => (
          <li key={job.id} className="rounded-[var(--radius-md)] border border-amber-200 bg-white px-3 py-2">
            <p className="text-sm font-semibold text-[var(--ink)]">{jobLabel(job.jobKind)}</p>
            <p className="text-[11px] text-[var(--muted)]">
              {new Date(job.createdAt).toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" })} ·
              พยายามแล้ว {job.attempts} ครั้ง
            </p>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                disabled={working === job.id}
                onClick={() => void resolve(job.id, "printed_confirmed")}
                className="btn-secondary min-h-11 flex-1 px-2 text-xs disabled:opacity-40"
              >
                ออกแล้ว
              </button>
              <button
                type="button"
                disabled={working === job.id}
                onClick={() => void resolve(job.id, "retried")}
                className="btn-primary min-h-11 flex-1 px-2 text-xs disabled:opacity-40"
              >
                พิมพ์ใหม่
              </button>
            </div>
          </li>
        ))}
      </ul>
      {error && (
        <p className="mt-2 rounded-[var(--radius-md)] border border-red-200 bg-red-50 px-2 py-1 text-[11px] text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
