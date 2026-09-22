"use client";

import { useEffect } from "react";
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

export function PushTokenRegistrar() {
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
          void reportPushRegistrationIssueAction({ stage: "permission_denied", detail: permission.receive }).catch(() => {});
          return;
        }
        const { token } = await messaging.getToken();
        if (cancelled) return;
        if (!token) {
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
          if (cached?.token === token && cached.ua === ua && Date.now() - cached.at < REFRESH_INTERVAL_MS) return;
        } catch {
          // cache พัง — ลงทะเบียนใหม่
        }

        const result = await registerPushTokenAction({ token, platform });
        if (result.ok) {
          localStorage.setItem(STORAGE_KEY, JSON.stringify({ token, at: Date.now(), ua }));
        }
      } catch (error) {
        // plugin ล้มเหลว — ไม่กระทบการใช้งาน แต่ต้องรายงานให้ไล่ปัญหาได้
        void reportPushRegistrationIssueAction({
          stage: "client_error",
          detail: error instanceof Error ? error.message : String(error),
        }).catch(() => {});
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return null;
}
