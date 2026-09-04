import { describe, expect, it } from "vitest";
import {
  IDLE_CONVERSATION,
  VOICE_CONVERSATION_MAX_AGE_MS,
  isConversationExpired,
  matchContextualReply,
  reduceConversation,
  type VoiceConversationState,
} from "@/modules/voice-pos/conversation";

const bareMenu: VoiceConversationState = {
  kind: "confirm_bare_menu",
  productId: "latte",
  productName: "ลาเต้",
  quantity: 1,
};

describe("voice conversation reducer", () => {
  it("เสนอเมนูลอย ๆ แล้วแก้จำนวนได้โดยไม่ต้องพูดชื่อซ้ำ", () => {
    const proposed = reduceConversation(IDLE_CONVERSATION, {
      type: "propose_bare_menu",
      productId: "latte",
      productName: "ลาเต้",
    });
    expect(proposed).toMatchObject({ kind: "confirm_bare_menu", productId: "latte", quantity: 1 });

    expect(reduceConversation(proposed, { type: "quantity_reply", quantity: 2 })).toMatchObject({
      kind: "confirm_bare_menu",
      productId: "latte",
      quantity: 2,
    });
  });

  it("ยืนยัน/ปฏิเสธจบบริบท", () => {
    expect(reduceConversation(bareMenu, { type: "affirm" })).toEqual({ kind: "completed" });
    expect(reduceConversation(bareMenu, { type: "decline" })).toEqual({ kind: "cancelled" });
  });

  it("พูดชื่อเมนูใหม่ทับข้อเสนอเดิม = เปลี่ยนใจ ไม่ซ้อนบริบท", () => {
    const next = reduceConversation(bareMenu, {
      type: "propose_bare_menu",
      productId: "americano",
      productName: "อเมริกาโน่",
    });
    expect(next).toMatchObject({ kind: "confirm_bare_menu", productId: "americano", quantity: 1 });
  });

  it("จำนวนถูกบีบให้อยู่ในช่วง 1–99", () => {
    expect(reduceConversation(bareMenu, { type: "quantity_reply", quantity: 0 })).toMatchObject({ quantity: 1 });
    expect(reduceConversation(bareMenu, { type: "quantity_reply", quantity: 500 })).toMatchObject({ quantity: 99 });
  });

  it("reset/cancel ล้างบริบทเสมอ ไม่ว่าอยู่สถานะไหน", () => {
    expect(reduceConversation(bareMenu, { type: "reset" })).toEqual(IDLE_CONVERSATION);
    expect(reduceConversation({ kind: "queue", queueId: "q", activeIndex: 1, items: [] }, { type: "cancel_all" }))
      .toEqual({ kind: "cancelled" });
  });

  it("คิวเดินหน้าและเข้าสู่โหมดรอเลือกตัวเลือกได้", () => {
    const queue = reduceConversation(IDLE_CONVERSATION, { type: "queue_started", queueId: "q1", items: [] });
    expect(queue).toMatchObject({ kind: "queue", queueId: "q1", activeIndex: 0 });
    const awaiting = reduceConversation(queue, { type: "await_option", queueId: "q1", itemId: "q1-0" });
    expect(awaiting).toMatchObject({ kind: "await_option", itemId: "q1-0" });
    expect(reduceConversation(awaiting, { type: "queue_advanced", activeIndex: 1, items: [] }))
      .toMatchObject({ kind: "queue", activeIndex: 1 });
    expect(reduceConversation(queue, { type: "queue_finished" })).toEqual({ kind: "completed" });
  });
});

describe("contextual reply allowlist", () => {
  it("รับ ใช่/ไม่/ยกเลิกทั้งหมด เฉพาะตอนมีบริบทค้างอยู่", () => {
    expect(matchContextualReply("ใช่", bareMenu)).toEqual({ kind: "affirm" });
    expect(matchContextualReply("ไม่", bareMenu)).toEqual({ kind: "decline" });
    expect(matchContextualReply("ยกเลิกทั้งหมด", bareMenu)).toEqual({ kind: "cancel_all" });

    // ไม่มีบริบท = ไม่ใช่คำตอบ ต้องปล่อยให้ parser ปกติจัดการ (กัน "ไม่" ลอย ๆ สั่งงาน)
    expect(matchContextualReply("ใช่", IDLE_CONVERSATION)).toBeNull();
    expect(matchContextualReply("ไม่", { kind: "completed" })).toBeNull();
  });

  it("อ่านจำนวนได้หลายรูปแบบ เฉพาะตอนกำลังยืนยันเมนู", () => {
    expect(matchContextualReply("เอาสองแก้ว", bareMenu)).toEqual({ kind: "quantity", quantity: 2 });
    expect(matchContextualReply("3", bareMenu)).toEqual({ kind: "quantity", quantity: 3 });
    expect(matchContextualReply("เอา 4 ที่", bareMenu)).toEqual({ kind: "quantity", quantity: 4 });
    // อยู่ในคิว ไม่ได้กำลังยืนยันเมนู → ตัวเลขลอย ๆ ไม่ใช่คำตอบ
    expect(matchContextualReply("สอง", { kind: "queue", queueId: "q", activeIndex: 0, items: [] })).toBeNull();
  });

  it("จำนวนนอกช่วงไม่ถือเป็นคำตอบ", () => {
    expect(matchContextualReply("เอา 0 แก้ว", bareMenu)).toBeNull();
    expect(matchContextualReply("เอา 100 แก้ว", bareMenu)).toBeNull();
  });

  it("คำสั่งจริงไม่ถูกกลืนเป็นคำตอบตามบริบท", () => {
    expect(matchContextualReply("ลาเต้สองแก้ว", bareMenu)).toBeNull();
    expect(matchContextualReply("ไปหน้ารายงาน", bareMenu)).toBeNull();
  });

  it("บริบทหมดอายุที่ 90 วินาที", () => {
    expect(isConversationExpired(1_000, 1_000 + VOICE_CONVERSATION_MAX_AGE_MS - 1)).toBe(false);
    expect(isConversationExpired(1_000, 1_000 + VOICE_CONVERSATION_MAX_AGE_MS)).toBe(true);
  });
});
