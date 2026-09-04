// P2 (v0.44.1) — บริบทของบทสนทนาเสียง 1 รอบ (pure reducer, memory-only)
//
// ปัญหาที่แก้: คนพูดต่อเนื่องแบบมีบริบท ไม่พูดชื่อสินค้าซ้ำทุกประโยค
//   "ลาเต้"        → ระบบถาม "เพิ่ม ลาเต้ 1 แก้วใช่ไหม?"
//   "เอาสองแก้ว"   → แก้จำนวนของสิ่งที่กำลังถามอยู่ ไม่ใช่คำสั่งใหม่
//   "ใช่"          → ยืนยัน
//
// กติกาความปลอดภัย:
//   - คำตอบตามบริบทใช้ allowlist แบบตรงตัว และถูกตรวจ "ก่อน" parser ทั่วไป
//     เพื่อไม่ให้ "ไม่" (=ข้าม) ไปชนกับ pattern อื่นที่แปลว่าอย่างอื่น
//   - state อยู่ในหน่วยความจำของรอบเดียว ห้าม persist และห้ามมี transcript อยู่ในนั้น
//   - มีอายุสัมบูรณ์ 90 วินาที กันบริบทค้างข้ามลูกค้าคนถัดไป
//
// (P8 Windows Standby จะเพิ่ม state `confirm_standby` ทีหลัง — Phase 1 push-to-talk
//  ยังไม่มีผู้ผลิต state นั้น จึงยังไม่ประกาศไว้ให้เป็นโค้ดตาย)

import type { VoiceQueueItem } from "./command-queue";
import { VOICE_MAX_QUANTITY, VOICE_MIN_QUANTITY, normalizeThaiTranscript } from "./parser";

/** อายุสูงสุดของบริบทหนึ่งชุด — เกินนี้ถือว่าเป็นลูกค้าคนใหม่ */
export const VOICE_CONVERSATION_MAX_AGE_MS = 90_000;

export type VoiceConversationState =
  | { readonly kind: "idle" }
  | { readonly kind: "confirm_bare_menu"; readonly productId: string; readonly productName: string; readonly quantity: number }
  | { readonly kind: "queue"; readonly queueId: string; readonly activeIndex: number; readonly items: readonly VoiceQueueItem[] }
  | { readonly kind: "await_option"; readonly queueId: string; readonly itemId: string }
  | { readonly kind: "completed" }
  | { readonly kind: "cancelled" };

export type VoiceConversationEvent =
  | { readonly type: "propose_bare_menu"; readonly productId: string; readonly productName: string }
  | { readonly type: "quantity_reply"; readonly quantity: number }
  | { readonly type: "affirm" }
  | { readonly type: "decline" }
  | { readonly type: "cancel_all" }
  | { readonly type: "queue_started"; readonly queueId: string; readonly items: readonly VoiceQueueItem[] }
  | { readonly type: "queue_advanced"; readonly activeIndex: number; readonly items: readonly VoiceQueueItem[] }
  | { readonly type: "await_option"; readonly queueId: string; readonly itemId: string }
  | { readonly type: "queue_finished" }
  | { readonly type: "reset" };

export const IDLE_CONVERSATION: VoiceConversationState = { kind: "idle" };

/**
 * คำตอบตามบริบทที่รับรู้ได้ — allowlist ตรงตัวล้วน ไม่มี fuzzy
 * ต้องเรียก "ก่อน" parseVoiceCommand เสมอ (ดู hybrid-parser)
 */
export type VoiceContextualReply =
  | { readonly kind: "affirm" }
  | { readonly kind: "decline" }
  | { readonly kind: "cancel_all" }
  | { readonly kind: "quantity"; readonly quantity: number };

const AFFIRM = /^(?:ใช่|ยืนยัน|ตกลง|โอเค|ok|okay|yes|ถูกต้อง|เอาเลย)$/;
const DECLINE = /^(?:ไม่|ไม่ใช่|ข้าม|ไม่เอา|no|skip)$/;
const CANCEL_ALL = /^(?:ยกเลิกทั้งหมด|ยกเลิกทั้งชุด|หยุดทั้งหมด|เลิกทั้งหมด|cancel all)$/;

/** "เอาสองแก้ว" / "สอง" / "2 แก้ว" / "เอา 3" — ตัวเลขล้วนหรือมีคำลักษณนามต่อท้าย */
const QUANTITY_REPLY = /^(?:เอา|ขอ|เป็น)?\s*(\d+)\s*(?:แก้ว|ที่|อัน|ชิ้น|กล่อง|ถ้วย|จาน|ขวด)?$/;

/**
 * ตีความคำพูดเป็น "คำตอบของบริบทที่ค้างอยู่"
 * คืน null เมื่อไม่ใช่คำตอบ → ผู้เรียกต้องส่งต่อให้ parser ปกติ
 * บริบท idle/completed/cancelled ไม่รับคำตอบใด ๆ (กันคำว่า "ไม่" ลอย ๆ ไปสั่งงาน)
 */
export function matchContextualReply(
  transcript: string,
  state: VoiceConversationState,
): VoiceContextualReply | null {
  if (state.kind === "idle" || state.kind === "completed" || state.kind === "cancelled") return null;
  const text = normalizeThaiTranscript(transcript);
  if (!text) return null;

  if (CANCEL_ALL.test(text)) return { kind: "cancel_all" };
  if (AFFIRM.test(text)) return { kind: "affirm" };
  if (DECLINE.test(text)) return { kind: "decline" };

  // จำนวนรับเฉพาะตอนที่มี "สิ่งที่ค้างอยู่ให้แก้จำนวน" เท่านั้น
  if (state.kind === "confirm_bare_menu") {
    const quantity = QUANTITY_REPLY.exec(text);
    if (quantity) {
      const value = Number(quantity[1]);
      if (Number.isInteger(value) && value >= VOICE_MIN_QUANTITY && value <= VOICE_MAX_QUANTITY) {
        return { kind: "quantity", quantity: value };
      }
    }
  }
  return null;
}

/** บริบทหมดอายุหรือยัง (เรียกก่อนใช้ทุกครั้ง — ผู้เรียกเป็นคนถือ startedAt) */
export function isConversationExpired(startedAt: number, now: number): boolean {
  return now - startedAt >= VOICE_CONVERSATION_MAX_AGE_MS;
}

export function reduceConversation(
  state: VoiceConversationState,
  event: VoiceConversationEvent,
): VoiceConversationState {
  if (event.type === "reset") return IDLE_CONVERSATION;
  if (event.type === "cancel_all") return { kind: "cancelled" };

  switch (state.kind) {
    case "idle":
    case "completed":
    case "cancelled":
      // เริ่มบริบทใหม่ได้จาก 2 ทางเท่านั้น: ข้อเสนอเมนูลอย ๆ หรือคิวจาก AI
      if (event.type === "propose_bare_menu") {
        return {
          kind: "confirm_bare_menu",
          productId: event.productId,
          productName: event.productName,
          quantity: 1,
        };
      }
      if (event.type === "queue_started") {
        return { kind: "queue", queueId: event.queueId, activeIndex: 0, items: event.items };
      }
      return state;

    case "confirm_bare_menu":
      if (event.type === "quantity_reply") {
        const quantity = Math.min(Math.max(event.quantity, VOICE_MIN_QUANTITY), VOICE_MAX_QUANTITY);
        return { ...state, quantity };
      }
      if (event.type === "affirm") return { kind: "completed" };
      if (event.type === "decline") return { kind: "cancelled" };
      if (event.type === "propose_bare_menu") {
        // พูดชื่อเมนูใหม่ทับข้อเสนอเดิม = เปลี่ยนใจ ไม่ใช่ซ้อนบริบท
        return {
          kind: "confirm_bare_menu",
          productId: event.productId,
          productName: event.productName,
          quantity: 1,
        };
      }
      if (event.type === "queue_started") {
        return { kind: "queue", queueId: event.queueId, activeIndex: 0, items: event.items };
      }
      return state;

    case "queue":
      if (event.type === "queue_advanced") {
        return { ...state, activeIndex: event.activeIndex, items: event.items };
      }
      if (event.type === "await_option") {
        return { kind: "await_option", queueId: event.queueId, itemId: event.itemId };
      }
      if (event.type === "queue_finished") return { kind: "completed" };
      return state;

    case "await_option":
      if (event.type === "queue_advanced") {
        return { kind: "queue", queueId: state.queueId, activeIndex: event.activeIndex, items: event.items };
      }
      if (event.type === "queue_finished") return { kind: "completed" };
      if (event.type === "decline") {
        // "ข้าม" ระหว่างเลือกตัวเลือก = ข้ามรายการนี้ ผู้เรียกจะยิง queue_advanced ตามมา
        return state;
      }
      return state;

    default:
      return state;
  }
}
