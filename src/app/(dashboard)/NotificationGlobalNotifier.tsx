"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { getSupabaseBrowserClient } from "@/server/integrations/supabase/client";
import { managedRealtimeSubscription } from "@/shared/realtime/realtime-client";
import { ensureAudioUnlocked, playAlertChime } from "@/shared/notifications/alert-sound";
import { metaFor } from "./notifications/NotificationCenter";
import {
  listNewNotificationsAction,
  type NewNotificationItem,
} from "./notifications/actions";
import type { Database } from "@/server/integrations/supabase/database.types";

type NotificationRow = Database["public"]["Tables"]["notifications"]["Row"];

/** ประเภทที่มี dialog + เสียงของตัวเองอยู่แล้ว (QrOrderGlobalNotifier) — ข้ามเมื่อ realtime ทำงาน */
const QR_DIALOG_TYPES = new Set(["new_qr_order", "new_buffet_order"]);

const POLL_INTERVAL_MS = 25_000;
const TOAST_TTL_MS = 10_000;
const MAX_TOASTS = 4;

interface Toast extends NewNotificationItem {
  shownAt: number;
}

interface Props {
  storeId: string;
}

/**
 * ตัวเด้งแจ้งเตือนกลางของแดชบอร์ด: toast + เสียง + สั่น เมื่อมีการแจ้งเตือนใหม่
 * (เรียกพนักงาน, ชำระเงิน, สต็อก ฯลฯ) — ฟัง realtime และ **มี polling fallback**
 * เผื่อ realtime ใช้ไม่ได้ (เน็ตร้านบล็อก WebSocket ฯลฯ) จะเด้งช้าสุด ~25 วินาที
 */
export function NotificationGlobalNotifier({ storeId }: Props) {
  const router = useRouter();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seenIds = useRef(new Set<string>());
  // สนใจเฉพาะแจ้งเตือนที่เกิดหลังเปิดหน้า — ของเก่าดูได้ที่ /notifications
  const mountedAtIso = useRef(new Date().toISOString());

  const pushToasts = useCallback((items: NewNotificationItem[], source: "realtime" | "poll") => {
    const fresh = items.filter((item) => {
      if (seenIds.current.has(item.id)) return false;
      if (item.createdAt < mountedAtIso.current) return false;
      // ออร์เดอร์ QR/บุฟเฟต์มี dialog + เสียงซ้ำของตัวเองเมื่อ realtime ทำงาน —
      // แต่ถ้ามาจาก polling แปลว่า realtime ล่ม ให้เด้งที่นี่แทน
      if (source === "realtime" && QR_DIALOG_TYPES.has(item.type)) {
        seenIds.current.add(item.id);
        return false;
      }
      return true;
    });
    if (fresh.length === 0) return;
    for (const item of fresh) seenIds.current.add(item.id);
    setToasts((prev) => [...prev, ...fresh.map((item) => ({ ...item, shownAt: Date.now() }))].slice(-MAX_TOASTS));
    playAlertChime("connect");
    try {
      navigator.vibrate?.([150, 80, 150]);
    } catch {
      /* บางเบราว์เซอร์ไม่รองรับ */
    }
  }, []);

  // ปลดล็อกเสียงตั้งแต่ mount (ดังได้หลัง user แตะหน้าจอครั้งแรก)
  useEffect(() => {
    ensureAudioUnlocked();
  }, []);

  // Realtime: เด้งทันทีเมื่อ dispatcher บันทึกแจ้งเตือนใหม่
  useEffect(() => {
    const client = getSupabaseBrowserClient();
    const unsubscribe = managedRealtimeSubscription<NotificationRow>({
      client,
      table: "notifications",
      filter: `store_id=eq.${storeId}`,
      onEvent: (payload) => {
        if (payload.eventType !== "INSERT" || !payload.new) return;
        const row = payload.new;
        pushToasts(
          [{
            id: row.id,
            type: row.type,
            title: row.title,
            message: row.message,
            createdAt: row.created_at,
          }],
          "realtime",
        );
      },
    });
    return unsubscribe;
  }, [storeId, pushToasts]);

  // Polling fallback: realtime ล่มก็ยังเด้ง (ช้าสุด ~25s)
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      const res = await listNewNotificationsAction();
      if (!cancelled && !res.error) pushToasts(res.notifications, "poll");
    };
    const id = window.setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [pushToasts]);

  // Auto-dismiss toast ที่ค้างเกินอายุ
  useEffect(() => {
    if (toasts.length === 0) return;
    const id = window.setInterval(() => {
      const now = Date.now();
      setToasts((prev) => prev.filter((toast) => now - toast.shownAt < TOAST_TTL_MS));
    }, 1_000);
    return () => window.clearInterval(id);
  }, [toasts.length]);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-16 right-3 z-50 flex w-80 max-w-[calc(100vw-1.5rem)] flex-col gap-2">
      {toasts.map((toast) => {
        const meta = metaFor(toast.type);
        return (
          <div
            key={toast.id}
            role="status"
            className="flex items-start gap-2.5 rounded-xl border border-gray-200 bg-white p-3 shadow-lg"
          >
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-gray-50 text-lg">
              {meta.emoji}
            </span>
            <button
              className="min-w-0 flex-1 text-left"
              onClick={() => {
                setToasts([]);
                router.push("/notifications");
              }}
            >
              <p className="truncate text-sm font-bold text-gray-900">
                {toast.title ?? meta.label}
              </p>
              <p className="line-clamp-2 text-xs text-gray-600">{toast.message}</p>
            </button>
            <button
              aria-label="ปิดแจ้งเตือน"
              onClick={() => setToasts((prev) => prev.filter((t) => t.id !== toast.id))}
              className="shrink-0 px-1 text-gray-300 hover:text-gray-500"
            >
              ✕
            </button>
          </div>
        );
      })}
    </div>
  );
}
