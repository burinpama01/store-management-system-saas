"use client";

import { useEffect, useState } from "react";
import { registerPushTokenAction, reportPushRegistrationIssueAction } from "./push-actions";

/**
 * ลงทะเบียน FCM token เมื่อเปิดผ่านแอปมือถือ (Capacitor injects window.Capacitor
 * เข้าหน้า remote) — บนเว็บปกติ component นี้ไม่ทำอะไรเลย
 */

interface CapacitorFirebaseMessaging {
  requestPermissions(): Promise<{ receive: string }>;
  getToken(): Promise<{ token: string }>;
}

interface CapacitorBridge {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
  Plugins?: { FirebaseMessaging?: CapacitorFirebaseMessaging };
}

declare global {
  interface Window {
    Capacitor?: CapacitorBridge;
  }
}

const STORAGE_KEY = "storeos_push_token_registered";
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** ปัญหาที่พนักงานแก้เองได้ — โชว์แถบเตือน (หน้าแรกของแอปคือหน้าลงเวลา เห็นทุกเช้า) */
type RegistrationProblem = "permission_denied" | "failed";

export function PushTokenRegistrar() {
  const [problem, setProblem] = useState<RegistrationProblem | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const capacitor = window.Capacitor;
    if (!capacitor?.isNativePlatform?.()) return;
    const messaging = capacitor.Plugins?.FirebaseMessaging;
    if (!messaging) {
      void reportPushRegistrationIssueAction({ stage: "plugin_missing" }).catch(() => {});
      return;
    }
    const platform = capacitor.getPlatform?.();
    if (platform !== "android" && platform !== "ios") return;

    let cancelled = false;

    (async () => {
      try {
        const permission = await messaging.requestPermissions();
        if (cancelled) return;
        if (permission.receive !== "granted") {
          setProblem("permission_denied");
          void reportPushRegistrationIssueAction({ stage: "permission_denied", detail: permission.receive }).catch(() => {});
          return;
        }
        const { token } = await messaging.getToken();
        if (cancelled) return;
        if (!token) {
          setProblem("failed");
          void reportPushRegistrationIssueAction({ stage: "no_token" }).catch(() => {});
          return;
        }

        // กันยิงซ้ำทุกครั้งที่เปิดหน้า: ข้ามถ้า token เดิม รุ่นแอปเดิม และเพิ่งลงทะเบียนไป
        // (อัปเดตแอปแล้วต้องลงทะเบียนใหม่ทันที — เซิร์ฟเวอร์เลือกรูปแบบ push ตามรุ่นแอป)
        const ua = navigator.userAgent;
        try {
          const cached = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as
            | { token: string; at: number; ua?: string }
            | null;
          if (cached?.token === token && cached.ua === ua && Date.now() - cached.at < REFRESH_INTERVAL_MS) {
            setProblem(null);
            return;
          }
        } catch {
          // cache พัง — ลงทะเบียนใหม่
        }

        const result = await registerPushTokenAction({ token, platform });
        if (cancelled) return;
        if (result.ok) {
          localStorage.setItem(STORAGE_KEY, JSON.stringify({ token, at: Date.now(), ua }));
        }
        setProblem(result.ok ? null : "failed");
      } catch (error) {
        // plugin ล้มเหลว — ไม่กระทบการใช้งาน แต่ต้องรายงานให้ไล่ปัญหาได้
        if (!cancelled) setProblem("failed");
        void reportPushRegistrationIssueAction({
          stage: "client_error",
          detail: error instanceof Error ? error.message : String(error),
        }).catch(() => {});
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [attempt]);

  if (!problem) return null;

  return (
    <div
      role="alert"
      className="fixed inset-x-3 top-3 z-50 mx-auto flex max-w-md items-start gap-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 shadow-lg"
    >
      <div className="min-w-0 flex-1">
        <p className="font-bold">
          {problem === "permission_denied" ? "ยังไม่ได้เปิดการแจ้งเตือนของแอป" : "รับแจ้งเตือนออเดอร์ไม่ได้"}
        </p>
        <p className="mt-0.5 text-xs">
          {problem === "permission_denied"
            ? "ออเดอร์ใหม่จะไม่เด้ง/ไม่มีเสียงตอนปิดจอ — กด \"ลองอีกครั้ง\" แล้วเลือกอนุญาต ถ้าไม่มีหน้าต่างขึ้น ให้เปิดที่ ตั้งค่าเครื่อง > แอป > StoreOS > การแจ้งเตือน"
            : "ลงทะเบียนรับแจ้งเตือนไม่สำเร็จ ออเดอร์ใหม่อาจไม่เด้งตอนปิดจอ — ลองอีกครั้ง หรือตรวจอินเทอร์เน็ต"}
        </p>
      </div>
      <button
        type="button"
        className="btn-secondary min-h-10 shrink-0 px-3 text-xs"
        onClick={() => {
          setProblem(null);
          setAttempt((n) => n + 1);
        }}
      >
        ลองอีกครั้ง
      </button>
    </div>
  );
}
