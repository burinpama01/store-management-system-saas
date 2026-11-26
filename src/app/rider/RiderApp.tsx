"use client";

import { useCallback, useEffect, useState } from "react";
import type { CodCollectMethod } from "@/modules/online-orders/core";
import { CodCollectPicker, CodFailButton } from "../(dashboard)/website/orders/CodControls";
import {
  claimRiderJobAction,
  completeRiderJobAction,
  failRiderJobAction,
  listRiderJobsAction,
  type RiderJobVM,
} from "./actions";
import { DriveMode } from "./DriveMode";

const baht = (n: number) => `฿${n.toLocaleString("th-TH", { maximumFractionDigits: 2 })}`;
const POLL_MS = 30_000;

export function RiderApp({ storeName, browserMapsKey, mapId }: { storeName: string; browserMapsKey: string | null; mapId: string | null }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof listRiderJobsAction>> | null>(null);
  const [tab, setTab] = useState<"mine" | "available">("mine");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [driving, setDriving] = useState<RiderJobVM | null>(null);
  const [collecting, setCollecting] = useState<RiderJobVM | null>(null);

  const load = useCallback(async () => {
    const res = await listRiderJobsAction().catch(() => null);
    if (res) setData(res);
  }, []);

  useEffect(() => {
    // setTimeout(0): setState หลัง effect (react-hooks/set-state-in-effect)
    const first = window.setTimeout(() => void load(), 0);
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, POLL_MS);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(id);
    };
  }, [load]);

  const run = async (id: string, task: () => Promise<{ ok: boolean; error: string | null }>, okText: string) => {
    setBusyId(id);
    setMessage(null);
    const res = await task().catch(() => ({ ok: false, error: "บันทึกไม่สำเร็จ" }));
    setMessage(res.ok ? (res.error ?? okText) : res.error);
    setBusyId(null);
    await load();
    return res.ok;
  };

  const claim = (job: RiderJobVM) =>
    run(job.id, () => claimRiderJobAction(job.id), `รับงาน ${job.orderCode} แล้ว — กด “นำทาง” เพื่อเริ่ม`).then((ok) => {
      if (ok) setTab("mine");
    });

  const complete = (job: RiderJobVM, method?: CodCollectMethod) => {
    if (job.paymentMethod === "cod" && !method) {
      // ออกจากโหมดขับก่อน ไม่งั้นหน้าเลือกวิธีรับเงินไม่ขึ้น
      setDriving(null);
      setCollecting(job);
      return;
    }
    setCollecting(null);
    setDriving(null);
    void run(job.id, () => completeRiderJobAction(job.id, method), `ส่ง ${job.orderCode} สำเร็จ${method === "cash" ? " — เงินสดคืนร้านด้วย" : ""}`);
  };

  const mine = data?.mine ?? [];
  const available = data?.available ?? [];
  const cashTotal = mine.reduce((s, j) => s + (j.cashHeld ?? 0), 0);

  if (driving) {
    return (
      <DriveMode
        job={driving}
        shop={data?.shop ?? null}
        browserMapsKey={browserMapsKey}
        mapId={mapId}
        onClose={() => setDriving(null)}
        onComplete={() => complete(driving)}
      />
    );
  }

  return (
    <main className="mx-auto min-h-dvh max-w-md bg-stone-50 pb-8 text-stone-900">
      <header className="sticky top-0 z-10 border-b bg-white px-4 py-3">
        <p className="text-xs text-stone-500">{storeName}</p>
        <h1 className="text-lg font-bold">🛵 หน้าคนส่ง</h1>
        <div className="mt-2 grid grid-cols-2 gap-2 text-sm">
          <button type="button" onClick={() => setTab("mine")} className={`min-h-11 rounded-lg border ${tab === "mine" ? "border-orange-600 bg-orange-50 font-semibold" : ""}`}>
            งานของฉัน ({mine.length})
          </button>
          <button type="button" onClick={() => setTab("available")} className={`min-h-11 rounded-lg border ${tab === "available" ? "border-orange-600 bg-orange-50 font-semibold" : ""}`}>
            งานรอส่ง ({available.length})
          </button>
        </div>
      </header>

      <div className="space-y-3 p-4">
        {data?.error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{data.error}</p>}
        {message && <p role="status" className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{message}</p>}
        {cashTotal > 0 && (
          <p className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-900">💵 เงินสดที่ต้องคืนร้าน <b>{baht(cashTotal)}</b> — ให้แคชเชียร์กด “รับเงินคืน”</p>
        )}
        {!data && <p className="py-8 text-center text-sm text-stone-500">กำลังโหลดงาน…</p>}
        {data && (tab === "mine" ? mine : available).length === 0 && (
          <p className="rounded-lg border border-dashed p-6 text-center text-sm text-stone-500">
            {tab === "mine" ? "ยังไม่มีงานของคุณ — ดูที่ “งานรอส่ง”" : "ยังไม่มีงานรอส่ง (ร้านต้องกดรับออเดอร์ก่อน)"}
          </p>
        )}
        {(tab === "mine" ? mine : available).map((job) => (
          <article key={job.id} className="space-y-2 rounded-xl border bg-white p-3 text-sm">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-base font-bold">{job.orderCode}</p>
                <p className="text-xs text-stone-500">{job.statusLabel}</p>
              </div>
              <span className={`rounded-full px-2 py-1 text-xs ${job.paymentMethod === "cod" ? "bg-amber-100 text-amber-900" : "bg-emerald-100 text-emerald-800"}`}>
                {job.paymentMethod === "cod" ? (job.cashHeld ? `ถือเงินสด ${baht(job.cashHeld)}` : `เก็บเงิน ${baht(job.total)}`) : "จ่ายแล้ว"}
              </span>
            </div>
            <p>
              <b>{job.customerName}</b> ·{" "}
              <a href={`tel:${job.customerPhone}`} className="text-orange-700 underline">
                {job.customerPhone}
              </a>
            </p>
            {job.address && <p className="text-stone-700">{job.address}</p>}
            {job.addressNote && <p className="text-xs text-stone-500">{job.addressNote}</p>}
            {job.note && <p className="rounded bg-yellow-50 px-2 py-1 text-xs">📝 {job.note}</p>}
            <p className="text-xs text-stone-500">{job.items.join(" · ")}</p>
            {job.riderPayAmount ? <p className="text-xs text-emerald-700">รายได้พิเศษงานนี้ {baht(job.riderPayAmount)} (เข้าเงินเดือนเมื่อส่งสำเร็จ)</p> : null}
            <div className="flex flex-wrap gap-2">
              {!job.mine && (
                <button type="button" disabled={busyId === job.id} onClick={() => void claim(job)} className="min-h-11 flex-1 rounded-lg bg-orange-600 px-4 font-semibold text-white disabled:opacity-50">
                  {busyId === job.id ? "กำลังรับ…" : "รับงานนี้"}
                </button>
              )}
              {job.mine && job.status === "out_for_delivery" && (
                <>
                  <button
                    type="button"
                    disabled={!job.dest}
                    onClick={() => setDriving(job)}
                    className="min-h-11 flex-1 rounded-lg bg-orange-600 px-4 font-semibold text-white disabled:opacity-50"
                  >
                    🧭 นำทาง{job.dest ? "" : " (ลูกค้าไม่ได้ปักหมุด)"}
                  </button>
                  <button type="button" disabled={busyId === job.id} onClick={() => complete(job)} className="min-h-11 rounded-lg border px-4">
                    ส่งสำเร็จ
                  </button>
                  {job.paymentMethod === "cod" && (
                    <CodFailButton busy={busyId === job.id} onConfirm={(reason) => void run(job.id, () => failRiderJobAction(job.id, reason), `บันทึกส่งไม่สำเร็จ ${job.orderCode}`)} />
                  )}
                </>
              )}
              {job.navUrl && (
                <a href={job.navUrl} target="_blank" rel="noreferrer" className="flex min-h-11 items-center rounded-lg border px-3 text-xs">
                  แอป Google Maps
                </a>
              )}
            </div>
          </article>
        ))}
      </div>

      {collecting && (
        <CodCollectPicker
          orderCode={collecting.orderCode}
          total={collecting.total}
          busy={busyId === collecting.id}
          onPick={(method) => complete(collecting, method)}
          onClose={() => setCollecting(null)}
        />
      )}
    </main>
  );
}
