"use client";

import { useEffect } from "react";
import { registerPushTokenAction } from "./push-actions";

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
    if (!messaging) return;
    const platform = capacitor.getPlatform?.();
    if (platform !== "android" && platform !== "ios") return;

    let cancelled = false;

    (async () => {
      try {
        const permission = await messaging.requestPermissions();
        if (cancelled || permission.receive !== "granted") return;
        const { token } = await messaging.getToken();
        if (cancelled || !token) return;

        // กันยิงซ้ำทุกครั้งที่เปิดหน้า: ข้ามถ้า token เดิมและเพิ่งลงทะเบียนไป
        try {
          const cached = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as
            | { token: string; at: number }
            | null;
          if (cached?.token === token && Date.now() - cached.at < REFRESH_INTERVAL_MS) return;
        } catch {
          // cache พัง — ลงทะเบียนใหม่
        }

        const result = await registerPushTokenAction({ token, platform });
        if (result.ok) {
          localStorage.setItem(STORAGE_KEY, JSON.stringify({ token, at: Date.now() }));
        }
      } catch {
        // permission ถูกปฏิเสธหรือ plugin ล้มเหลว — เงียบไว้ ไม่กระทบการใช้งาน
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return null;
}
