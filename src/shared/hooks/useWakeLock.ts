"use client";

import { useEffect } from "react";

// กันจอดับขณะเปิดเครื่องเล่นเพลง / จอเนื้อร้อง (Screen Wake Lock API)
// - iPad/iPhone: Safari/iPadOS 16.4+, Android Chrome 84+ — เครื่องเก่าที่ไม่รองรับจะข้ามเงียบ ๆ
//   (ให้ร้านตั้ง "ล็อกอัตโนมัติ: ไม่ใช้" แทน)
// - เบราว์เซอร์ปล่อย lock เองเมื่อสลับแอป/ล็อกจอ → ขอใหม่ทุกครั้งที่กลับมาเห็นหน้า

interface WakeLockSentinelLike {
  released: boolean;
  release: () => Promise<void>;
  addEventListener?: (type: "release", cb: () => void) => void;
}
type WakeLockNavigator = Navigator & {
  wakeLock?: { request: (type: "screen") => Promise<WakeLockSentinelLike> };
};

export function isWakeLockSupported(nav: unknown = typeof navigator === "undefined" ? undefined : navigator): boolean {
  return Boolean((nav as WakeLockNavigator | undefined)?.wakeLock?.request);
}

export function useWakeLock(active: boolean) {
  useEffect(() => {
    if (!active || !isWakeLockSupported()) return;
    const nav = navigator as WakeLockNavigator;
    let sentinel: WakeLockSentinelLike | null = null;
    let disposed = false;

    const acquire = async () => {
      if (disposed || document.visibilityState !== "visible") return;
      if (sentinel && !sentinel.released) return;
      try {
        const next = await nav.wakeLock!.request("screen");
        if (disposed) {
          void next.release().catch(() => {});
          return;
        }
        sentinel = next;
      } catch {
        // ถูกปฏิเสธ (แบตต่ำ / ยังไม่มีการแตะหน้าจอ) — ลองใหม่ตอนกลับมาเห็นหน้า
      }
    };

    const onVisible = () => {
      if (document.visibilityState === "visible") void acquire();
    };

    void acquire();
    document.addEventListener("visibilitychange", onVisible);
    // บางเครื่องต้องมีการแตะก่อน — ลองขออีกครั้งตอนผู้ใช้แตะจอ
    document.addEventListener("pointerdown", onVisible);
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVisible);
      document.removeEventListener("pointerdown", onVisible);
      if (sentinel && !sentinel.released) void sentinel.release().catch(() => {});
      sentinel = null;
    };
  }, [active]);
}
