"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { getSupabaseBrowserClient } from "@/server/integrations/supabase/client";
import { managedRealtimeSubscription } from "@/shared/realtime/realtime-client";
import { Button } from "@/shared/components/ui";
import type { AppNotification } from "@/modules/notifications/repository";
import {
  acknowledgeNotificationAction,
  acknowledgeAllNotificationsAction,
} from "./actions";

interface Props {
  storeId: string;
  storeName: string;
  initialNotifications: AppNotification[];
}

const TYPE_META: Record<string, { label: string; emoji: string; tone: string }> = {
  payment: { label: "ชำระเงิน", emoji: "💰", tone: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  new_table: { label: "เปิดโต๊ะ", emoji: "🪑", tone: "bg-sky-50 text-sky-700 border-sky-200" },
  new_pos_order: { label: "ออร์เดอร์ POS", emoji: "🧾", tone: "bg-indigo-50 text-indigo-700 border-indigo-200" },
  new_qr_order: { label: "ออร์เดอร์ QR", emoji: "📱", tone: "bg-orange-50 text-orange-700 border-orange-200" },
  new_buffet_order: { label: "ออร์เดอร์บุฟเฟต์", emoji: "🍲", tone: "bg-amber-50 text-amber-700 border-amber-200" },
  kitchen_order: { label: "ครัว", emoji: "👨‍🍳", tone: "bg-slate-50 text-slate-700 border-slate-200" },
  buffet_expiring: { label: "บุฟเฟต์ใกล้หมดเวลา", emoji: "⏰", tone: "bg-rose-50 text-rose-700 border-rose-200" },
  stock_alert: { label: "สต็อก", emoji: "📦", tone: "bg-yellow-50 text-yellow-700 border-yellow-200" },
  order_cancelled: { label: "ยกเลิก/คืนเงิน", emoji: "🚫", tone: "bg-red-50 text-red-700 border-red-200" },
  attendance_clock_in: { label: "เข้างาน", emoji: "🟢", tone: "bg-green-50 text-green-700 border-green-200" },
  attendance_clock_out: { label: "ออกงาน", emoji: "🔴", tone: "bg-gray-50 text-gray-600 border-gray-200" },
  approval: { label: "คำขออนุมัติ", emoji: "✅", tone: "bg-violet-50 text-violet-700 border-violet-200" },
  service_request: { label: "เรียกพนักงาน", emoji: "🔔", tone: "bg-amber-50 text-amber-800 border-amber-200" },
  test: { label: "ทดสอบ", emoji: "🧪", tone: "bg-slate-50 text-slate-600 border-slate-200" },
};

export function metaFor(type: string) {
  return TYPE_META[type] ?? { label: type, emoji: "🔔", tone: "bg-slate-50 text-slate-600 border-slate-200" };
}

function timeAgo(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "เมื่อสักครู่";
  if (mins < 60) return `${mins} นาทีที่แล้ว`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} ชม.ที่แล้ว`;
  const days = Math.floor(hrs / 24);
  return `${days} วันที่แล้ว`;
}

export function NotificationCenter({ storeId, storeName, initialNotifications }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [tab, setTab] = useState<"new" | "all">("new");
  const [live, setLive] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const newCount = useMemo(
    () => initialNotifications.filter((n) => n.status === "new").length,
    [initialNotifications],
  );
  const visible = useMemo(
    () => (tab === "new" ? initialNotifications.filter((n) => n.status === "new") : initialNotifications),
    [initialNotifications, tab],
  );

  // Realtime: refresh (debounced) when a notification row changes.
  useEffect(() => {
    const client = getSupabaseBrowserClient();
    const scheduleRefresh = () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(() => router.refresh(), 400);
    };
    const unsub = managedRealtimeSubscription({
      client,
      table: "notifications",
      filter: `store_id=eq.${storeId}`,
      onEvent: () => scheduleRefresh(),
      onError: () => setLive(false),
    });
    return () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      unsub();
    };
  }, [storeId, router]);

  // Fallback poll every 30s in case realtime is unavailable.
  useEffect(() => {
    const id = setInterval(() => router.refresh(), 30000);
    return () => clearInterval(id);
  }, [router]);

  function acknowledge(id: string) {
    setError(null);
    startTransition(async () => {
      const res = await acknowledgeNotificationAction(id);
      if (res.error) setError(res.error);
      else router.refresh();
    });
  }

  function acknowledgeAll() {
    setError(null);
    startTransition(async () => {
      const res = await acknowledgeAllNotificationsAction();
      if (res.error) setError(res.error);
      else router.refresh();
    });
  }

  return (
    <div className="page-shell">
      <div className="page-header">
        <div>
          <h1 className="text-xl font-bold text-[var(--ink)]">การแจ้งเตือน</h1>
          <p className="text-sm text-[var(--muted)]">
            รายงานแจ้งเตือนทั้งหมดของ {storeName} — ใหม่และที่รับเรื่องแล้ว
          </p>
        </div>
        <span
          className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ${
            live ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"
          }`}
        >
          <span className={`h-2 w-2 rounded-full ${live ? "bg-green-500 animate-pulse" : "bg-gray-400"}`} />
          {live ? "เรียลไทม์" : "ออฟไลน์"}
        </span>
      </div>

      {error && <p className="rounded-lg bg-red-50 px-4 py-2 text-sm text-red-600">{error}</p>}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex rounded-lg border border-[var(--border)] bg-white p-1">
          <button
            onClick={() => setTab("new")}
            className={`min-h-9 rounded-md px-3 text-sm font-semibold ${
              tab === "new" ? "bg-orange-500 text-white" : "text-gray-600"
            }`}
          >
            ใหม่ {newCount > 0 && `(${newCount})`}
          </button>
          <button
            onClick={() => setTab("all")}
            className={`min-h-9 rounded-md px-3 text-sm font-semibold ${
              tab === "all" ? "bg-orange-500 text-white" : "text-gray-600"
            }`}
          >
            ทั้งหมด ({initialNotifications.length})
          </button>
        </div>
        {newCount > 0 && (
          <Button
            variant="secondary"
            onClick={acknowledgeAll}
            loading={isPending}
            className="min-h-9 px-3 text-xs"
          >
            รับเรื่องทั้งหมด
          </Button>
        )}
      </div>

      {visible.length === 0 ? (
        <p className="rounded-lg border border-dashed border-gray-300 bg-white p-10 text-center text-sm text-gray-400">
          {tab === "new" ? "ไม่มีการแจ้งเตือนใหม่" : "ยังไม่มีการแจ้งเตือน"}
        </p>
      ) : (
        <ul className="space-y-2">
          {visible.map((n) => {
            const meta = metaFor(n.type);
            const isNew = n.status === "new";
            return (
              <li
                key={n.id}
                className={`flex items-start gap-3 rounded-lg border bg-white p-3 ${
                  isNew ? "border-orange-200" : "border-gray-100"
                }`}
              >
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-gray-50 text-lg">
                  {meta.emoji}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${meta.tone}`}>
                      {meta.label}
                    </span>
                    {isNew ? (
                      <span className="rounded-full bg-orange-100 px-2 py-0.5 text-xs font-semibold text-orange-700">
                        ใหม่
                      </span>
                    ) : (
                      <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-semibold text-gray-500">
                        รับเรื่องแล้ว
                      </span>
                    )}
                    <span className="text-xs text-gray-400">{timeAgo(n.createdAt)}</span>
                  </div>
                  {n.title && <p className="mt-1 text-sm font-bold text-gray-900">{n.title}</p>}
                  <p className="text-sm text-gray-600">{n.message}</p>
                </div>
                {isNew && (
                  <Button
                    variant="secondary"
                    onClick={() => acknowledge(n.id)}
                    loading={isPending}
                    className="min-h-9 shrink-0 px-3 text-xs"
                  >
                    รับเรื่อง
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
