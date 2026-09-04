import { describe, expect, it } from "vitest";
import {
  activeQueueItem,
  createVoiceQueue,
  isQueueComplete,
  reduceVoiceQueue,
  summarizeQueue,
  type VoiceCommandQueue,
} from "@/modules/voice-pos/command-queue";
import type { AiVoiceCommand } from "@/modules/voice-pos/ai-intent-schema";

const cmd = (productPhrase: string): AiVoiceCommand => ({
  intent: "pos.add_item",
  productPhrase,
  quantity: 1,
  optionPhrases: [],
});

const queueOf = (...names: string[]) => createVoiceQueue("q1", names.map(cmd));

const applyAll = (queue: VoiceCommandQueue, events: Parameters<typeof reduceVoiceQueue>[1][]) =>
  events.reduce(reduceVoiceQueue, queue);

describe("voice command queue reducer", () => {
  it("ทำงานทีละรายการ — active มีได้หนึ่งเดียวเสมอ", () => {
    const queue = queueOf("ลาเต้", "อเมริกาโน่", "มัจฉะ");
    expect(activeQueueItem(queue)?.command.productPhrase).toBe("ลาเต้");
    const resolving = reduceVoiceQueue(queue, { type: "start_resolving" });
    expect(resolving.items.filter((item) => item.status === "resolving")).toHaveLength(1);
    expect(activeQueueItem(resolving)?.command.productPhrase).toBe("ลาเต้");
  });

  it("ข้ามรายการกลาง: ของก่อนหน้ายังอยู่ และเดินต่อรายการถัดไป", () => {
    const queue = applyAll(queueOf("ลาเต้", "อเมริกาโน่", "มัจฉะ"), [
      { type: "apply", note: "เพิ่ม ลาเต้" },
      { type: "await_input", note: "เลือกความหวาน" },
      { type: "skip" },
    ]);

    expect(queue.items[0].status).toBe("applied");
    expect(queue.items[0].note).toBe("เพิ่ม ลาเต้");
    expect(queue.items[1].status).toBe("skipped");
    expect(activeQueueItem(queue)?.command.productPhrase).toBe("มัจฉะ");
  });

  it("จบคิวเมื่อทุกรายการถึงสถานะสุดท้าย", () => {
    const queue = applyAll(queueOf("ลาเต้", "อเมริกาโน่"), [
      { type: "apply", note: "เพิ่ม ลาเต้" },
      { type: "block", note: "ไม่พบสินค้า" },
    ]);
    expect(isQueueComplete(queue)).toBe(true);
    expect(activeQueueItem(queue)).toBeNull();
    expect(summarizeQueue(queue)).toEqual({ applied: 1, skipped: 0, blocked: 1 });
  });

  it("ยกเลิกทั้งชุดหยุดเฉพาะที่ยังไม่ commit", () => {
    const queue = applyAll(queueOf("ลาเต้", "อเมริกาโน่", "มัจฉะ"), [
      { type: "apply", note: "เพิ่ม ลาเต้" },
      { type: "cancel_all" },
    ]);
    expect(queue.items[0].status).toBe("applied");
    expect(queue.items[1].status).toBe("skipped");
    expect(queue.items[2].status).toBe("skipped");
    expect(queue.cancelled).toBe(true);
    expect(activeQueueItem(queue)).toBeNull();
  });

  it("เหตุการณ์ที่มาหลังคิวจบแล้วไม่เปลี่ยนอะไร", () => {
    const done = applyAll(queueOf("ลาเต้"), [{ type: "apply", note: "เพิ่ม ลาเต้" }]);
    expect(reduceVoiceQueue(done, { type: "apply", note: "ซ้ำ" })).toEqual(done);
    expect(reduceVoiceQueue(done, { type: "skip" })).toEqual(done);
  });

  it("await_input ไม่เดินหน้าคิว (รอผู้ใช้เลือกก่อน)", () => {
    const queue = reduceVoiceQueue(queueOf("ลาเต้", "มัจฉะ"), { type: "await_input", note: "เลือกขนาด" });
    expect(queue.activeIndex).toBe(0);
    expect(activeQueueItem(queue)?.status).toBe("awaiting_input");
  });
});
