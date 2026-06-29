"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { Button } from "@/shared/components/ui";
import {
  MUSIC_REQUEST_STATUS_LABEL,
  type MusicRequest,
  type MusicDecisionAction,
} from "@/modules/music-requests/types";
import { listMusicRequestsAction, decideMusicRequestAction } from "./actions";

interface Props {
  initialRequests: MusicRequest[];
  musicEnabled: boolean;
}

const STATUS_STYLE: Record<MusicRequest["status"], string> = {
  pending: "bg-amber-50 text-amber-700",
  approved: "bg-blue-50 text-blue-700",
  played: "bg-green-50 text-green-700",
  rejected: "bg-red-50 text-red-600",
  skipped: "bg-gray-100 text-gray-500",
  expired: "bg-gray-100 text-gray-400",
};

function fmt(iso: string): string {
  return new Date(iso).toLocaleString("th-TH", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function MusicRequestsBoard({ initialRequests, musicEnabled }: Props) {
  const [requests, setRequests] = useState<MusicRequest[]>(initialRequests);
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [, startRefresh] = useTransition();

  const refresh = useCallback(() => {
    startRefresh(async () => {
      const res = await listMusicRequestsAction();
      if (res.error) setError(res.error);
      else setRequests(res.requests);
    });
  }, []);

  // Poll so the board reflects new customer requests without a manual reload.
  useEffect(() => {
    const id = setInterval(refresh, 15000);
    return () => clearInterval(id);
  }, [refresh]);

  function decide(requestId: string, action: MusicDecisionAction) {
    setError(null);
    setPendingId(requestId);
    startRefresh(async () => {
      const res = await decideMusicRequestAction(requestId, action);
      if (res.error) setError(res.error);
      else {
        const list = await listMusicRequestsAction();
        if (!list.error) setRequests(list.requests);
      }
      setPendingId(null);
    });
  }

  const pending = requests.filter((r) => r.status === "pending");
  const decided = requests.filter((r) => r.status !== "pending");

  return (
    <div className="mx-auto max-w-3xl p-4">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">คิวขอเพลง</h1>
          {!musicEnabled && (
            <p className="text-xs text-amber-600">การขอเพลงถูกปิดอยู่ ลูกค้าจะส่งคำขอใหม่ไม่ได้</p>
          )}
        </div>
        <Button variant="secondary" onClick={refresh} className="min-h-9 text-sm">
          รีเฟรช
        </Button>
      </div>

      {error && (
        <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>
      )}

      <section className="mb-6">
        <h2 className="mb-2 text-sm font-semibold text-gray-500">รอคิว ({pending.length})</h2>
        {pending.length === 0 ? (
          <p className="py-6 text-center text-sm text-gray-400">ไม่มีคำขอที่รอคิว</p>
        ) : (
          <ul className="space-y-2">
            {pending.map((r) => (
              <li key={r.id} className="rounded-xl border border-gray-100 bg-white p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-semibold text-gray-900">
                      {r.songTitle}
                      {r.donationStatus === "verified" && (
                        <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700">
                          💸 โดเนท
                        </span>
                      )}
                    </p>
                    {r.artistName && <p className="text-sm text-gray-500">{r.artistName}</p>}
                    <p className="mt-0.5 text-xs text-gray-400">
                      {r.requesterLabel ? `${r.requesterLabel} · ` : ""}
                      {r.tableNumber ? `โต๊ะ ${r.tableNumber} · ` : ""}
                      {fmt(r.requestedAt)}
                    </p>
                    {r.note && <p className="mt-1 text-xs text-gray-500">📝 {r.note}</p>}
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button
                    variant="primary"
                    onClick={() => decide(r.id, "approve")}
                    loading={pendingId === r.id}
                    className="min-h-9 px-3 text-xs"
                  >
                    อนุมัติ
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => decide(r.id, "play")}
                    loading={pendingId === r.id}
                    className="min-h-9 px-3 text-xs"
                  >
                    เปิดแล้ว
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => decide(r.id, "skip")}
                    loading={pendingId === r.id}
                    className="min-h-9 px-3 text-xs"
                  >
                    ข้าม
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => decide(r.id, "reject")}
                    loading={pendingId === r.id}
                    className="min-h-9 px-3 text-xs text-red-500"
                  >
                    ปฏิเสธ
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold text-gray-500">ประวัติล่าสุด</h2>
        {decided.length === 0 ? (
          <p className="py-6 text-center text-sm text-gray-400">ยังไม่มีประวัติ</p>
        ) : (
          <ul className="space-y-2">
            {decided.map((r) => (
              <li
                key={r.id}
                className="flex items-center justify-between gap-2 rounded-lg border border-gray-100 bg-white px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-gray-900">{r.songTitle}</p>
                  <p className="truncate text-xs text-gray-400">
                    {r.artistName ? `${r.artistName} · ` : ""}
                    {fmt(r.requestedAt)}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {r.status === "played" && (
                    <Button
                      variant="secondary"
                      onClick={() => decide(r.id, "play")}
                      loading={pendingId === r.id}
                      className="min-h-8 px-2 text-xs"
                    >
                      เปิดอีกครั้ง
                    </Button>
                  )}
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_STYLE[r.status]}`}
                  >
                    {MUSIC_REQUEST_STATUS_LABEL[r.status]}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
