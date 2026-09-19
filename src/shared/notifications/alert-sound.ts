"use client";

import { useEffect, useRef } from "react";
import {
  cancelAnnouncement,
  primeVoices,
  readVoicePreference,
  resolveVoiceEnabled,
  speakAnnouncement,
} from "./announce";

/**
 * เสียงแจ้งเตือนในแอปสำหรับออเดอร์ที่ต้องรีบรับ (QR / Connect):
 * เล่นเสียงดังซ้ำต่อเนื่องจนกว่าจะปิด dialog + สั่นเครื่อง (มือถือ)
 *
 * เบราว์เซอร์บล็อก AudioContext จนกว่าจะมี user gesture ครั้งแรก — เราผูก
 * listener ปลดล็อกไว้ครั้งเดียว เพื่อให้เสียงดังได้จริงเมื่อออเดอร์เข้า
 */

let sharedCtx: AudioContext | null = null;
let unlockBound = false;

function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtx) return null;
  if (!sharedCtx) {
    try {
      sharedCtx = new AudioCtx();
    } catch {
      return null;
    }
  }
  return sharedCtx;
}

/** ไฟล์เสียงออเดอร์ใหม่ (assets/AlertNewOrder.mp3, ~1.6 วิ) — เสิร์ฟจาก public/ */
export const ORDER_ALERT_SOUND_URL = "/sounds/alert-new-order.mp3";

let orderBuffer: AudioBuffer | null = null;
let orderBufferLoading: Promise<void> | null = null;

/**
 * โหลด + ถอดรหัสไฟล์เสียงออเดอร์ครั้งเดียว (ใช้ AudioContext ตัวเดียวกับ beep ที่ปลดล็อกแล้ว
 * จึงเล่นได้แม้ไม่ได้อยู่ใน user gesture — HTMLAudio.play() ทำไม่ได้)
 * โหลดล้ม = คืน null แล้วลองใหม่ครั้งหน้า; ผู้เรียกใช้ beep แทน ไม่มีทางเงียบ
 */
export function preloadOrderAlertSound(): Promise<void> {
  if (orderBuffer) return Promise.resolve();
  if (orderBufferLoading) return orderBufferLoading;
  const ctx = getCtx();
  if (!ctx || typeof fetch !== "function") return Promise.resolve();
  orderBufferLoading = fetch(ORDER_ALERT_SOUND_URL)
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.arrayBuffer();
    })
    .then((data) => ctx.decodeAudioData(data))
    .then((buffer) => {
      orderBuffer = buffer;
    })
    .catch((e: unknown) => {
      console.warn("[alert-sound] โหลดเสียงออเดอร์ไม่สำเร็จ ใช้ beep แทน", e);
    })
    .finally(() => {
      orderBufferLoading = null;
    });
  return orderBufferLoading;
}

/** เล่นไฟล์เสียงออเดอร์ — คืน false ถ้ายังไม่พร้อม (ให้ผู้เรียก beep แทน) */
function playOrderBuffer(): boolean {
  const ctx = getCtx();
  if (!ctx || !orderBuffer) return false;
  if (ctx.state === "suspended") void ctx.resume();
  try {
    const source = ctx.createBufferSource();
    const gain = ctx.createGain();
    source.buffer = orderBuffer;
    gain.gain.value = 1;
    source.connect(gain);
    gain.connect(ctx.destination);
    source.start();
    return true;
  } catch {
    return false;
  }
}

/** ปลดล็อกเสียงเมื่อผู้ใช้แตะหน้าจอครั้งแรก (เรียกได้หลายครั้ง ผูก listener ครั้งเดียว) */
export function ensureAudioUnlocked() {
  if (unlockBound || typeof window === "undefined") return;
  unlockBound = true;
  const resume = () => {
    const ctx = getCtx();
    if (ctx && ctx.state === "suspended") void ctx.resume();
    void preloadOrderAlertSound();
  };
  ["pointerdown", "keydown", "touchstart"].forEach((evt) =>
    window.addEventListener(evt, resume, { passive: true }),
  );
}

/**
 * order   = ออเดอร์ใหม่ (QR / บุฟเฟต์ / เดลิเวอรี) → ไฟล์ AlertNewOrder (สำรองด้วย beep แบบ qr)
 * qr      = beep สูงสามจังหวะ
 * connect = beep ต่ำสองจังหวะ (แจ้งเตือนทั่วไป)
 */
export type AlertPattern = "order" | "qr" | "connect";

/** ชนิดแจ้งเตือนที่เป็น "ออเดอร์ใหม่" — ใช้เสียงออเดอร์แทน beep ทั่วไป */
export const ORDER_ALERT_TYPES: ReadonlySet<string> = new Set([
  "new_qr_order",
  "new_buffet_order",
  "new_delivery_order",
]);

export function alertPatternForTypes(types: readonly string[]): AlertPattern {
  return types.some((type) => ORDER_ALERT_TYPES.has(type)) ? "order" : "connect";
}

/** เล่นเสียงเตือนหนึ่งชุด (เสียงสูงต่ำต่างกันตามชนิดออเดอร์) */
export function playAlertChime(pattern: AlertPattern) {
  if (pattern === "order") {
    if (playOrderBuffer()) return;
    // ไฟล์ยังไม่พร้อม — โหลดไว้สำหรับรอบถัดไป แล้ว beep รอบนี้ (ไม่มีทางเงียบ)
    void preloadOrderAlertSound();
  }
  const ctx = getCtx();
  if (!ctx) return;
  if (ctx.state === "suspended") void ctx.resume();

  // connect = โทนต่ำสองจังหวะ, qr/order (สำรอง) = โทนสูงสามจังหวะไล่ขึ้น
  const notes =
    pattern === "connect"
      ? [{ at: 0, freq: 620 }, { at: 0.26, freq: 780 }]
      : [{ at: 0, freq: 880 }, { at: 0.16, freq: 1040 }, { at: 0.32, freq: 1245 }];

  for (const note of notes) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = note.freq;
    // ramp กันเสียงป๊อกตอนตัด + ดังพอได้ยินข้ามห้อง
    const start = ctx.currentTime + note.at;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.32, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.2);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(start);
    osc.stop(start + 0.22);
  }
}

function vibrate(pattern: AlertPattern) {
  try {
    if (typeof navigator === "undefined" || typeof navigator.vibrate !== "function") return;
    navigator.vibrate(pattern === "connect" ? [200, 100, 200] : [120, 80, 120, 80, 120]);
  } catch {
    /* บางเบราว์เซอร์ไม่รองรับ */
  }
}

const REPEAT_INTERVAL_MS = 3500;

/**
 * แจ้งเตือนหนึ่งครั้ง (toast ที่ไม่มี dialog ค้าง): พูดถ้าเปิดเสียงพูดไว้และพูดได้ ไม่งั้น beep
 * คืนค่า true เมื่อพูดออกไปจริง — ผู้เรียกไม่ต้องเล่นเสียงซ้ำเอง
 */
export function playAlertOrSpeak(
  pattern: AlertPattern,
  announcement: string | null,
  voiceEnabledByStore: boolean,
): boolean {
  const voiceOn = resolveVoiceEnabled(voiceEnabledByStore, readVoicePreference());
  const spoken = voiceOn && announcement ? speakAnnouncement(announcement) : false;
  if (!spoken) playAlertChime(pattern);
  return spoken;
}

export interface RepeatingAlertOptions {
  /**
   * ข้อความที่จะอ่านออกเสียงแทน beep (ระบบสร้างเอง ไม่ใช่ข้อมูลลูกค้า)
   * ไม่ส่งมา = ใช้ beep อย่างเดียวเหมือนเดิม
   */
  readonly announcement?: string | null;
  /** ค่าเริ่มต้นระดับร้าน (stores.notification_voice_enabled) — เครื่องปรับทับได้ */
  readonly voiceEnabledByStore?: boolean;
}

/**
 * เล่นเสียงเตือนซ้ำต่อเนื่องขณะที่ `active` เป็น true (มี dialog ค้างอยู่)
 * หยุดทันทีเมื่อปิด dialog — ให้พนักงานไม่พลาดออเดอร์เร่งด่วน
 *
 * เมื่อเปิดเสียงพูดไว้ จะ**พูดซ้ำทุกรอบเหมือน beep** จนกว่าจะปิด dialog
 * (ประโยคสั้น ~2 วิ สั้นกว่าคาบซ้ำ 3.5 วิ จึงไม่ตัดประโยคตัวเองกลางคัน)
 * ถ้าเครื่องพูดไม่ได้ (ไม่มีเสียงไทย) รอบนั้นจะ beep แทน ไม่มีทางเงียบ
 */
export function useRepeatingAlert(
  active: boolean,
  pattern: AlertPattern,
  options: RepeatingAlertOptions = {},
) {
  const { announcement = null, voiceEnabledByStore = false } = options;
  // เก็บไว้ใน ref: ข้อความเปลี่ยนกลางรอบ (ออเดอร์ใบถัดไป) ต้องไม่รีสตาร์ท interval
  // — ถ้าใส่ใน dependency คาบเสียงจะรีเซ็ตทุกครั้งที่จำนวนออเดอร์เปลี่ยน
  const announcementRef = useRef(announcement);
  useEffect(() => {
    announcementRef.current = announcement;
  }, [announcement]);

  useEffect(() => {
    ensureAudioUnlocked();
    primeVoices();
    // โหลดไฟล์เสียงล่วงหน้า — ถ้า AudioContext ยังถูกล็อก การถอดรหัสยังทำได้ เล่นได้หลังแตะจอ
    if (pattern === "order") void preloadOrderAlertSound();
  }, [pattern]);

  useEffect(() => {
    if (!active) return;

    const ring = () => {
      playAlertOrSpeak(pattern, announcementRef.current ?? null, voiceEnabledByStore);
      vibrate(pattern);
    };

    ring();
    const id = window.setInterval(ring, REPEAT_INTERVAL_MS);
    return () => {
      window.clearInterval(id);
      // ปิด dialog แล้วต้องเงียบทันที ไม่ปล่อยให้ประโยคสุดท้ายพูดค้างต่อ
      cancelAnnouncement();
    };
  }, [active, pattern, voiceEnabledByStore]);
}
