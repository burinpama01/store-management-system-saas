// P1 (v0.44.0) — คิวคำสั่งเสียงแบบหลายรายการ (pure reducer, ไม่มี React/side effect)
//
// ทำไมต้องเป็นคิว: คนพูดทีเดียวว่า "ลาเต้สองแก้ว อเมริกาโน่ร้อนหนึ่ง" = 2 คำสั่ง
// ถ้าเปิด dialog ตัวเลือกพร้อมกันสองอันจะกดผิดใบแน่นอน กติกาจึงเป็น
//   - ทำงานทีละ item เท่านั้น (active ได้หนึ่งเดียว)
//   - commit ราย item: ข้าม item ที่ 2 ต้องไม่ย้อน item ที่ 1 และต้องไปต่อ item ที่ 3
//   - ยกเลิกทั้งชุด = หยุดเฉพาะสิ่งที่ยังไม่ commit ของที่ลงตะกร้าไปแล้วยังอยู่
//     (คนละเรื่องกับ Undo 6 วินาที ซึ่งย้อน "ตะกร้าทั้งใบ" กลับไปก่อนคำสั่งนั้น)

import type { AiVoiceCommand } from "./ai-intent-schema";

export type VoiceQueueItemStatus =
  | "pending"
  | "resolving"
  | "awaiting_input"
  | "applied"
  | "skipped"
  | "blocked";

export interface VoiceQueueItem {
  readonly id: string;
  readonly command: AiVoiceCommand;
  readonly status: VoiceQueueItemStatus;
  /** ข้อความอธิบายผล (สร้างจากข้อมูลในระบบ ไม่ใช่ free-text ของโมเดล) */
  readonly note: string;
}

export interface VoiceCommandQueue {
  readonly id: string;
  readonly items: readonly VoiceQueueItem[];
  /** ตำแหน่งที่กำลังทำงาน — เท่ากับ items.length เมื่อจบทั้งคิว */
  readonly activeIndex: number;
  readonly cancelled: boolean;
}

export type VoiceQueueEvent =
  | { readonly type: "start_resolving" }
  | { readonly type: "await_input"; readonly note: string }
  | { readonly type: "apply"; readonly note: string }
  | { readonly type: "skip"; readonly note?: string }
  | { readonly type: "block"; readonly note: string }
  | { readonly type: "cancel_all" };

const TERMINAL: ReadonlySet<VoiceQueueItemStatus> = new Set(["applied", "skipped", "blocked"]);

export function isTerminalQueueStatus(status: VoiceQueueItemStatus): boolean {
  return TERMINAL.has(status);
}

export function createVoiceQueue(
  queueId: string,
  commands: readonly AiVoiceCommand[],
): VoiceCommandQueue {
  return {
    id: queueId,
    items: commands.map((command, index) => ({
      id: `${queueId}-${index}`,
      command,
      status: "pending" as const,
      note: "",
    })),
    activeIndex: 0,
    cancelled: false,
  };
}

/** item ที่กำลังทำงานอยู่ (null = จบคิวแล้ว หรือถูกยกเลิก) */
export function activeQueueItem(queue: VoiceCommandQueue): VoiceQueueItem | null {
  if (queue.cancelled) return null;
  return queue.items[queue.activeIndex] ?? null;
}

export function isQueueComplete(queue: VoiceCommandQueue): boolean {
  return queue.cancelled || queue.activeIndex >= queue.items.length;
}

/** สรุปผลไว้ประกาศตอนจบ — ไม่มีคำพูดของผู้ใช้อยู่ในนี้ */
export function summarizeQueue(queue: VoiceCommandQueue): {
  readonly applied: number;
  readonly skipped: number;
  readonly blocked: number;
} {
  let applied = 0;
  let skipped = 0;
  let blocked = 0;
  for (const item of queue.items) {
    if (item.status === "applied") applied += 1;
    else if (item.status === "skipped") skipped += 1;
    else if (item.status === "blocked") blocked += 1;
  }
  return { applied, skipped, blocked };
}

function replaceActive(
  queue: VoiceCommandQueue,
  patch: Pick<VoiceQueueItem, "status" | "note">,
  advance: boolean,
): VoiceCommandQueue {
  const items = queue.items.map((item, index) =>
    index === queue.activeIndex ? { ...item, ...patch } : item,
  );
  return {
    ...queue,
    items,
    activeIndex: advance ? queue.activeIndex + 1 : queue.activeIndex,
  };
}

/**
 * reducer เดียวของคิว — ทุก transition ต้องผ่านที่นี่
 * เหตุการณ์ที่มาถึงตอนคิวจบ/ถูกยกเลิกแล้ว จะไม่เปลี่ยนอะไร (idempotent)
 */
export function reduceVoiceQueue(
  queue: VoiceCommandQueue,
  event: VoiceQueueEvent,
): VoiceCommandQueue {
  if (event.type === "cancel_all") {
    // ของที่ commit ไปแล้วคงสถานะเดิม ที่เหลือกลายเป็น skipped ทั้งหมด
    const items = queue.items.map((item) =>
      isTerminalQueueStatus(item.status)
        ? item
        : { ...item, status: "skipped" as const, note: item.note || "ยกเลิกคำสั่งที่เหลือ" },
    );
    return { ...queue, items, activeIndex: items.length, cancelled: true };
  }

  if (isQueueComplete(queue)) return queue;

  switch (event.type) {
    case "start_resolving":
      return replaceActive(queue, { status: "resolving", note: "" }, false);
    case "await_input":
      return replaceActive(queue, { status: "awaiting_input", note: event.note }, false);
    case "apply":
      return replaceActive(queue, { status: "applied", note: event.note }, true);
    case "skip":
      return replaceActive(queue, { status: "skipped", note: event.note ?? "ข้ามรายการนี้" }, true);
    case "block":
      return replaceActive(queue, { status: "blocked", note: event.note }, true);
    default:
      return queue;
  }
}
