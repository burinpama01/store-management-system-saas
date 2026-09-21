"use client";

import { useState } from "react";
import {
  ANDROID_DOWNLOAD_PATH,
  ANDROID_NOTES,
  ANDROID_VERSION_NAME,
} from "@/modules/mobile/android-version";

/** จำการปิดแบนเนอร์ไว้ต่อรุ่น — ปิดแล้วต้องไม่เด้งซ้ำทุกครั้งที่เปลี่ยนหน้า */
const dismissKey = `storeos.app-update-dismissed.${ANDROID_VERSION_NAME}`;

const alreadyDismissed = () => {
  try {
    return window.localStorage.getItem(dismissKey) === "1";
  } catch {
    // โหมดส่วนตัว/ปิดคุกกี้อ่านไม่ได้ — แสดงแบนเนอร์ตามปกติ ดีกว่าเงียบไปเลย
    return false;
  }
};

/**
 * เตือนผู้ใช้แอป Android ว่ามีรุ่นใหม่ให้โหลด
 *
 * แอปไม่ได้อยู่บน Play Store จึงไม่มี auto-update และตัวแอปเองก็อัปเดตตัวเองไม่ได้
 * แต่มันเป็นเปลือกบางที่โหลดเว็บ production ทุกครั้ง — เว็บจึงเป็นที่เดียวที่บอกได้
 * และบอกได้ทันทีที่ deploy โดยไม่ต้องรอใครอัปเดต APK ก่อน
 *
 * รุ่นที่ติดตั้งอ่านจาก User-Agent ฝั่ง server (layout) แล้วส่งมาเป็น prop —
 * ไม่อ่าน navigator ตอน mount เพื่อไม่ให้ markup ฝั่ง server กับ client ต่างกัน
 * ได้ค่ามา = แปลว่าเป็นแอป Android ที่เก่ากว่ารุ่นล่าสุดแล้ว (layout กรองมาให้)
 */
export function AppUpdateNotice({ installedVersion }: { installedVersion: string }) {
  const [dismissed, setDismissed] = useState(alreadyDismissed);

  if (dismissed) return null;

  const dismiss = () => {
    try {
      window.localStorage.setItem(dismissKey, "1");
    } catch {
      // เก็บไม่ได้ก็ยังปิดให้ได้ในรอบนี้
    }
    setDismissed(true);
  };

  return (
    <div className="fixed inset-x-0 bottom-0 z-50 border-t border-[var(--border)] bg-[var(--surface)] p-4 shadow-lg md:inset-x-auto md:right-4 md:bottom-4 md:max-w-sm md:rounded-xl md:border">
      <p className="text-sm font-semibold">มีแอปเวอร์ชันใหม่</p>
      <p className="mt-1 text-xs text-[var(--muted-foreground)]">
        {installedVersion === "0" ? "เครื่องนี้ใช้รุ่นเก่า" : `เครื่องนี้เป็นรุ่น ${installedVersion}`}{" "}
        — รุ่นล่าสุดคือ {ANDROID_VERSION_NAME} ({ANDROID_NOTES})
      </p>
      <div className="mt-3 flex gap-2">
        <a
          href={ANDROID_DOWNLOAD_PATH}
          className="rounded-lg bg-[var(--primary)] px-3 py-2 text-sm font-medium text-[var(--primary-foreground)]"
        >
          ดาวน์โหลด
        </a>
        <button type="button" onClick={dismiss} className="rounded-lg px-3 py-2 text-sm">
          ไว้ทีหลัง
        </button>
      </div>
    </div>
  );
}
