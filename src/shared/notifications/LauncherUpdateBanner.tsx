"use client";

import { useState } from "react";
import { installLauncherUpdate } from "@/modules/launcher/device-host";
import { useLauncherDevice } from "@/modules/launcher/useLauncherDevice";

/**
 * แถบเล็กมุมล่างซ้าย: บอกเรื่องอัปเดตของ StoreOS Launcher บนเครื่องนี้
 *   * Launcher รุ่นเก่า (≤0.4.1 อัปเดตตัวเองไม่ได้) → ชวนดาวน์โหลดรุ่นใหม่ติดตั้งทับหนึ่งครั้ง
 *   * มีรุ่นใหม่ดาวน์โหลดไว้แล้ว → ปุ่มติดตั้ง (Launcher ถามยืนยันกับคนหน้าเครื่องอีกชั้น)
 * เบราว์เซอร์ปกติ/แอปมือถือไม่เห็นแถบนี้เลย ปิดได้ (จำไว้เฉพาะรอบการเปิดหน้านี้)
 */
export function LauncherUpdateBanner() {
  const launcher = useLauncherDevice();
  const [dismissed, setDismissed] = useState<string | null>(null);

  const readyVersion = launcher.update?.state === "ready" ? launcher.update.version : null;
  const key = launcher.legacy ? "legacy" : readyVersion ? `ready-${readyVersion}` : null;
  if (!launcher.inLauncher || !key || dismissed === key) return null;

  return (
    <div
      role="status"
      className="fixed bottom-3 left-3 z-40 flex max-w-[calc(100vw-1.5rem)] flex-wrap items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 shadow-md"
    >
      {launcher.legacy ? (
        <>
          <span>StoreOS Launcher รุ่นนี้อัปเดตตัวเองไม่ได้</span>
          <a className="font-semibold underline" href="/download/windows-launcher">
            ดาวน์โหลดรุ่นใหม่
          </a>
        </>
      ) : (
        <>
          <span>มี Launcher รุ่นใหม่ {readyVersion} พร้อมติดตั้ง</span>
          <button
            type="button"
            onClick={installLauncherUpdate}
            className="min-h-9 rounded-md bg-amber-700 px-3 text-xs font-semibold text-white"
          >
            อัปเดตตอนนี้
          </button>
        </>
      )}
      <button
        type="button"
        onClick={() => setDismissed(key)}
        aria-label="ปิดแถบแจ้งอัปเดต"
        className="min-h-9 rounded-md px-2 text-xs font-semibold text-amber-900/70"
      >
        ปิด
      </button>
    </div>
  );
}
