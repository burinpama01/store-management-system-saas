import { describe, it, expect, vi } from "vitest";
import {
  pickThaiVoice,
  resolveVoiceEnabled,
  speakAnnouncement,
} from "@/shared/notifications/announce";
import {
  deliveryAnnouncement,
  qrOrderAnnouncement,
  toastAnnouncement,
} from "@/shared/notifications/announcement-text";

interface FakeUtterance {
  text: string;
  lang: string;
  rate: number;
  volume: number;
  voice?: unknown;
}

/** window ปลอมที่มี speechSynthesis — คุมรายการเสียงได้เพื่อจำลองเครื่องร้านแต่ละแบบ */
function fakeWindow(voices: Array<{ lang: string; name: string }>) {
  const spoken: FakeUtterance[] = [];
  const cancel = vi.fn();
  const win = {
    speechSynthesis: {
      speak: (u: unknown) => spoken.push(u as FakeUtterance),
      cancel,
      getVoices: () => voices,
    },
    SpeechSynthesisUtterance: class {
      text: string;
      lang = "";
      rate = 1;
      volume = 1;
      voice?: unknown;
      constructor(text: string) {
        this.text = text;
      }
    },
  };
  return { win, spoken, cancel };
}

const THAI = { lang: "th-TH", name: "Microsoft Pattara" };
const ENGLISH = { lang: "en-US", name: "Microsoft David" };

describe("เลือกเสียงไทย", () => {
  it("หยิบเสียงที่ lang ขึ้นต้นด้วย th", () => {
    expect(pickThaiVoice([ENGLISH, THAI])?.name).toBe("Microsoft Pattara");
  });

  it("ไม่มีเสียงไทย = null (ห้ามหยิบเสียงอังกฤษมาอ่านไทย)", () => {
    expect(pickThaiVoice([ENGLISH])).toBeNull();
    expect(pickThaiVoice([])).toBeNull();
  });
});

describe("speakAnnouncement", () => {
  it("พูดด้วยเสียงไทยและคืน true", () => {
    const { win, spoken, cancel } = fakeWindow([ENGLISH, THAI]);
    const ok = speakAnnouncement("ออเดอร์เดลิเวอรีเข้าใหม่", { window: win });

    expect(ok).toBe(true);
    expect(spoken).toHaveLength(1);
    expect(spoken[0].text).toBe("ออเดอร์เดลิเวอรีเข้าใหม่");
    expect(spoken[0].lang).toBe("th-TH");
    expect(spoken[0].voice).toBe(THAI);
    // ต้องตัดประโยคเก่าทิ้งก่อน ไม่งั้นออเดอร์ที่เข้าติด ๆ กันจะพูดทับกัน
    expect(cancel).toHaveBeenCalled();
  });

  it("เครื่องไม่มีเสียงไทย = ไม่พูดและคืน false (ผู้เรียกต้อง beep แทน)", () => {
    const { win, spoken } = fakeWindow([ENGLISH]);
    expect(speakAnnouncement("ออเดอร์โต๊ะ 4 เข้าใหม่", { window: win })).toBe(false);
    expect(spoken).toHaveLength(0);
  });

  it("เบราว์เซอร์ไม่รองรับ speechSynthesis = คืน false ไม่ throw", () => {
    expect(speakAnnouncement("ทดสอบ", { window: {} })).toBe(false);
    expect(speakAnnouncement("ทดสอบ", { window: null })).toBe(false);
  });

  it("ข้อความว่าง = ไม่พูด", () => {
    const { win, spoken } = fakeWindow([THAI]);
    expect(speakAnnouncement("   ", { window: win })).toBe(false);
    expect(spoken).toHaveLength(0);
  });

  it("speak โยน error = คืน false ไม่ทำให้ตัวเรียกพัง", () => {
    const win = {
      speechSynthesis: {
        speak: () => {
          throw new Error("audio device busy");
        },
        cancel: () => {},
        getVoices: () => [THAI],
      },
      SpeechSynthesisUtterance: class {
        text: string;
        lang = "";
        rate = 1;
        volume = 1;
        constructor(text: string) {
          this.text = text;
        }
      },
    };
    expect(speakAnnouncement("ทดสอบ", { window: win })).toBe(false);
  });
});

describe("ค่าตั้ง 2 ชั้น (ร้าน + เครื่อง)", () => {
  it("เครื่องไม่ได้ตั้งเอง = ตามค่าของร้าน", () => {
    expect(resolveVoiceEnabled(true, "store")).toBe(true);
    expect(resolveVoiceEnabled(false, "store")).toBe(false);
  });

  it("เครื่องที่ตั้งเองมีสิทธิ์ขาดเหนือร้านทั้งสองทาง", () => {
    // เครื่องติดลูกค้าปิดได้แม้ร้านเปิด
    expect(resolveVoiceEnabled(true, "off")).toBe(false);
    // เครื่องในครัวเปิดได้แม้ร้านยังไม่เปิด
    expect(resolveVoiceEnabled(false, "on")).toBe(true);
  });
});

describe("ประโยคที่อ่านออกเสียง", () => {
  it("ออเดอร์ QR บอกเลขโต๊ะ", () => {
    expect(qrOrderAnnouncement("4", 1)).toBe("ออเดอร์โต๊ะ 4 เข้าใหม่");
  });

  it("ไม่มีเลขโต๊ะ = อ่าน 'คิวอาร์' เป็นคำไทย (เสียงไทยอ่าน QR ไม่ออก)", () => {
    expect(qrOrderAnnouncement(undefined, 1)).toBe("ออเดอร์คิวอาร์เข้าใหม่");
  });

  it("มีคิวค้างหลายใบ = บอกจำนวน", () => {
    expect(qrOrderAnnouncement("4", 3)).toBe("ออเดอร์โต๊ะ 4 เข้าใหม่ รออยู่ 3 รายการ");
    expect(deliveryAnnouncement(2)).toBe("ออเดอร์เดลิเวอรีเข้าใหม่ 2 รายการ");
  });

  it("เดลิเวอรีใบเดียว = ประโยคสั้น", () => {
    expect(deliveryAnnouncement(1)).toBe("ออเดอร์เดลิเวอรีเข้าใหม่");
  });

  it("toast อ่านแค่ชนิดแจ้งเตือน ไม่อ่านเนื้อข้อความ", () => {
    expect(toastAnnouncement("เรียกพนักงาน", 1)).toBe("เรียกพนักงาน");
    expect(toastAnnouncement("เรียกพนักงาน", 2)).toBe("เรียกพนักงาน 2 รายการ");
  });

  it("ไม่มีประโยคไหนหลุดยอดเงินหรือเลขบิลออกลำโพงหน้าร้าน", () => {
    const sentences = [
      qrOrderAnnouncement("4", 2),
      qrOrderAnnouncement(undefined, 1),
      deliveryAnnouncement(3),
      toastAnnouncement("ชำระเงิน", 1),
    ];
    for (const sentence of sentences) {
      expect(sentence).not.toMatch(/฿|บาท|#/);
    }
  });
});
