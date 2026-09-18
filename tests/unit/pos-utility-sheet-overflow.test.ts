import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// 2026-09-18 — "ระบบตั๋วล้นจอ" บนโน้ตบุ๊กร้าน: แผ่น PosUtilitySheet ต้องไม่สูงเกินจอ
// และเนื้อหาต้องเลื่อนภายในแผ่น (flex child ที่ไม่มี min-h-0 จะสูงเท่าเนื้อหาแล้วล้น)

const source = readFileSync("src/app/pos/PosTerminal.tsx", "utf8");
const sheet = source.slice(source.indexOf("function PosUtilitySheet("), source.indexOf("function TicketPanel("));

describe("PosUtilitySheet ไม่ล้นจอ", () => {
  it("มีเพดานความสูงแบบ inline (ไม่พึ่ง class arbitrary อย่างเดียว)", () => {
    expect(sheet).toContain('style={{ maxHeight: "min(88dvh, calc(100vh - 1.5rem))" }}');
  });

  it("ส่วนเนื้อหาหดได้และเลื่อนในแผ่นเอง", () => {
    expect(sheet).toContain("min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto");
  });
});
