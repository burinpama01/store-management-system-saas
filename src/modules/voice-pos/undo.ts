// U15 — Undo 6 วินาที (R2) · state machine ล้วน ไม่มี React/timer ในไฟล์นี้
// สัญญา: 1 token ต่อ 1 การเปลี่ยนแปลง; การเปลี่ยนแปลงใหม่ทำให้ token เดิมใช้ไม่ได้ทันที
//        หมดเวลาแล้ว undo ไม่ได้ และ snapshot ต้องคืนตะกร้า "ใบเดิมเป๊ะ"

import type { Cart } from "@/modules/pos/types";

export const VOICE_UNDO_WINDOW_MS = 6000;

export interface VoiceUndoToken {
  readonly id: string;
  /** ตะกร้าก่อนการเปลี่ยนแปลง — ใช้คืนค่าแบบ snapshot ทั้งใบ */
  readonly previousCart: Cart;
  /** ข้อความอธิบายสิ่งที่ย้อนได้ (ไม่มีคำพูดของผู้ใช้) */
  readonly label: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  /** ต่อเวลาไปแล้วหรือยัง — ต่อได้ครั้งเดียวเท่านั้น (ดู refreshVoiceUndoToken) */
  readonly refreshed?: boolean;
}

export function createVoiceUndoToken(input: {
  readonly id: string;
  readonly previousCart: Cart;
  readonly label: string;
  readonly now: number;
  readonly windowMs?: number;
}): VoiceUndoToken {
  const windowMs = input.windowMs ?? VOICE_UNDO_WINDOW_MS;
  return {
    id: input.id,
    previousCart: input.previousCart,
    label: input.label,
    createdAt: input.now,
    expiresAt: input.now + windowMs,
  };
}

/**
 * เริ่มนับหน้าต่างเวลาใหม่ตอน "ไมค์เปิดให้พูดได้จริง"
 *
 * ทำไมต้องมี: หลังสั่งเสร็จ ระบบจะพูดผลออกลำโพงก่อนแล้วค่อยเปิดไมค์ต่อ
 * ถ้านับเวลาตั้งแต่ตอนแก้ตะกร้า เวลาส่วนใหญ่จะหมดไปกับเสียงของระบบเอง
 * คนที่มือไม่ว่างจึงพูดว่า "ย้อนกลับ" ไม่ทัน (เป็นสาเหตุเดียวกับที่ทำให้การ์ด
 * ยืนยัน 8 วินาทีของเดิมใช้งานจริงไม่ได้)
 *
 * ต่อได้ครั้งเดียว: ถ้าต่อได้เรื่อย ๆ ทุกครั้งที่เปิดไมค์ ตะกร้าที่แก้ไปนานแล้ว
 * จะย้อนได้อยู่ตลอดกะ ซึ่งอันตรายกว่าการย้อนไม่ทัน
 */
export function refreshVoiceUndoToken(
  token: VoiceUndoToken | null,
  now: number,
  windowMs: number = VOICE_UNDO_WINDOW_MS,
): VoiceUndoToken | null {
  if (!token || token.refreshed) return token;
  if (!isVoiceUndoTokenValid(token, now)) return token;
  return { ...token, expiresAt: now + windowMs, refreshed: true };
}

export function isVoiceUndoTokenValid(token: VoiceUndoToken | null, now: number): boolean {
  if (!token) return false;
  return now < token.expiresAt;
}

export type VoiceUndoResult =
  | { readonly status: "restored"; readonly cart: Cart; readonly announcement: string }
  | { readonly status: "expired"; readonly announcement: string };

/** ใช้ token คืนตะกร้า — หมดอายุ/ไม่มี token = ไม่คืนอะไรเลย (ไม่ throw) */
export function consumeVoiceUndoToken(token: VoiceUndoToken | null, now: number): VoiceUndoResult {
  if (!isVoiceUndoTokenValid(token, now) || !token) {
    return { status: "expired", announcement: "หมดเวลาย้อนกลับแล้ว — แก้ตะกร้าบนหน้าจอได้" };
  }
  return { status: "restored", cart: token.previousCart, announcement: "ย้อนกลับแล้ว" };
}
