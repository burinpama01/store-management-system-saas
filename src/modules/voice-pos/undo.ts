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
