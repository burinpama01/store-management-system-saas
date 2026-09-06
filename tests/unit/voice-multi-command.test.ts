// สั่งหลายเมนูในประโยคเดียวต้องขึ้นครบทุกรายการ
// อาการที่ผู้ใช้เจอจากเครื่องจริง: "พูดหลายเมนูขึ้นแค่เมนูเดียว"
import { describe, expect, it } from "vitest";

import { buildMultiCommandBatch, splitVoiceSegments } from "@/modules/voice-pos/multi-command";
import { parseVoiceCommand } from "@/modules/voice-pos/parser";

/** เมนูสมมุติของร้าน — ด่านสุดท้ายที่กันการตัดประโยคผิดคือชื่อสินค้าจริง */
const MENU = ["ลาเต้", "ชาเย็น", "อเมริกาโน่", "ข้าวหมูกรอบกับไข่ดาว"];

/** เลียนแบบตัวจับคู่จริง: จับแบบ "คำขึ้นต้น" ไม่ใช่ตรงเป๊ะ */
const compact = (value: string) => value.replace(/\s+/g, "");
const deps = {
  parse: (text: string) => parseVoiceCommand(text),
  isKnownProduct: (phrase: string) =>
    MENU.some((name) => compact(phrase).startsWith(compact(name))),
  isExactProduct: (phrase: string) => MENU.some((name) => compact(name) === compact(phrase)),
};

describe("แยกประโยคเป็นหลายคำสั่ง", () => {
  it("ตัดตามคำเชื่อมที่คนไทยใช้คั่นรายการ", () => {
    expect(splitVoiceSegments("เพิ่มลาเต้ และ ชาเย็น")).toEqual(["เพิ่มลาเต้", "ชาเย็น"]);
    expect(splitVoiceSegments("เพิ่มลาเต้ แล้วก็ ชาเย็น")).toEqual(["เพิ่มลาเต้", "ชาเย็น"]);
  });

  it("สองเมนูพร้อมจำนวน ต้องได้ครบสองคำสั่ง", () => {
    const batch = buildMultiCommandBatch("เพิ่มลาเต้สองแก้วและชาเย็นหนึ่งแก้ว", deps);

    expect(batch?.commands).toEqual([
      { intent: "pos.add_item", productPhrase: "ลาเต้", quantity: 2, optionPhrases: [] },
      { intent: "pos.add_item", productPhrase: "ชาเย็น", quantity: 1, optionPhrases: [] },
    ]);
  });

  it("ท่อนหลังที่ละคำว่า 'เพิ่ม' ไว้ ต้องยืมคำกริยาของท่อนแรกมาใช้", () => {
    const batch = buildMultiCommandBatch("เพิ่มลาเต้กับอเมริกาโน่", deps);

    expect(batch?.commands.map((c) => c.productPhrase)).toEqual(["ลาเต้", "อเมริกาโน่"]);
  });

  it("สามเมนูก็ต้องได้ครบ", () => {
    const batch = buildMultiCommandBatch("เพิ่มลาเต้ ชาเย็น และ อเมริกาโน่".replace(" ชาเย็น", ", ชาเย็น"), deps);

    expect(batch?.commands).toHaveLength(3);
  });

  it("ชื่อเมนูที่มีคำเชื่อมอยู่ข้างใน ต้องไม่ถูกตัดเป็นสองรายการ", () => {
    // ถ้าตัดผิดตรงนี้ ลูกค้าจะได้ของผิด — ยอมไม่รองรับดีกว่าเดาผิด
    expect(buildMultiCommandBatch("เพิ่มข้าวหมูกรอบกับไข่ดาว", deps)).toBeNull();
  });

  it("ท่อนที่ไม่ใช่สินค้าในเมนู ทำให้ทั้งชุดตกไปใช้เส้นทางเดิม", () => {
    expect(buildMultiCommandBatch("เพิ่มลาเต้และอะไรสักอย่าง", deps)).toBeNull();
  });

  it("ประโยคเดียวรายการเดียว ไม่ใช่งานของโมดูลนี้", () => {
    expect(buildMultiCommandBatch("เพิ่มลาเต้สองแก้ว", deps)).toBeNull();
  });

  it("คำสั่งต้องห้ามปนอยู่ในท่อนใดก็ตาม = ทิ้งทั้งชุด", () => {
    expect(buildMultiCommandBatch("เพิ่มลาเต้และชำระเงิน", deps)).toBeNull();
  });
});
