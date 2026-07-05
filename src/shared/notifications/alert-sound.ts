"use client";

import { useEffect } from "react";

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

/** ปลดล็อกเสียงเมื่อผู้ใช้แตะหน้าจอครั้งแรก (เรียกได้หลายครั้ง ผูก listener ครั้งเดียว) */
export function ensureAudioUnlocked() {
  if (unlockBound || typeof window === "undefined") return;
  unlockBound = true;
  const resume = () => {
    const ctx = getCtx();
    if (ctx && ctx.state === "suspended") void ctx.resume();
  };
  ["pointerdown", "keydown", "touchstart"].forEach((evt) =>
    window.addEventListener(evt, resume, { passive: true }),
  );
}

export type AlertPattern = "qr" | "connect";

/** เล่นเสียงเตือนหนึ่งชุด (เสียงสูงต่ำต่างกันตามชนิดออเดอร์) */
export function playAlertChime(pattern: AlertPattern) {
  const ctx = getCtx();
  if (!ctx) return;
  if (ctx.state === "suspended") void ctx.resume();

  // connect = โทนต่ำสองจังหวะ, qr = โทนสูงสามจังหวะไล่ขึ้น
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
 * เล่นเสียงเตือนซ้ำต่อเนื่องขณะที่ `active` เป็น true (มี dialog ค้างอยู่)
 * หยุดทันทีเมื่อปิด dialog — ให้พนักงานไม่พลาดออเดอร์เร่งด่วน
 */
export function useRepeatingAlert(active: boolean, pattern: AlertPattern) {
  useEffect(() => {
    ensureAudioUnlocked();
  }, []);

  useEffect(() => {
    if (!active) return;
    playAlertChime(pattern);
    vibrate(pattern);
    const id = window.setInterval(() => {
      playAlertChime(pattern);
      vibrate(pattern);
    }, REPEAT_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [active, pattern]);
}
