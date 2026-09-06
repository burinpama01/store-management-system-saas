// W8 — แปลรหัสปัญหาของเครื่องเป็นคำแนะนำที่ทำตามได้จริง
//
// ทำไมต้องแยกเป็นโมดูล: ข้อความ error ดิบจาก Windows อ่านไม่รู้เรื่องสำหรับคนหน้าร้าน
// ("Cannot perform this operation while the recognizer is doing recognition.")
// และการส่งข้อความดิบมาแสดงยังเสี่ยงพาเส้นทางไฟล์/ชื่อเครื่องมาโชว์บนหน้าจอด้วย
// ฝั่งเครื่องจึงส่งมาแค่ "รหัส" แล้วหน้าเว็บเป็นคนแปลเป็นภาษาคน

import type { VoiceHostFaultCode } from "./standby-contract";

export interface HostRepairGuide {
  /** อาการที่ผู้ใช้กำลังเจอ พูดจากมุมของเขา ไม่ใช่มุมของระบบ */
  readonly problem: string;
  /** ขั้นตอนที่ทำเองได้ที่หน้าร้าน */
  readonly steps: readonly string[];
  /** ยังขายของได้ตามปกติไหม — ทุกกรณีต้องตอบว่าได้ */
  readonly fallback: string;
}

const GUIDES: Record<VoiceHostFaultCode, HostRepairGuide> = {
  no_recognizer: {
    problem: "เครื่องนี้ยังไม่มีชุดรู้จำเสียงของ Windows",
    steps: [
      "เปิด Settings → Time & language → Language & region",
      "เลือกภาษา English (United States) → Language options → ติดตั้ง Speech recognition",
      "ปิดแล้วเปิดเครื่องหนึ่งครั้ง แล้วกด “ตรวจอีกครั้ง”",
    ],
    fallback: "ระหว่างนี้ยังกดปุ่มไมค์เพื่อพูดคำสั่งได้ตามปกติ",
  },
  microphone_denied: {
    problem: "Windows ไม่อนุญาตให้โปรแกรมใช้ไมโครโฟน",
    steps: [
      "เปิด Settings → Privacy & security → Microphone",
      "เปิด “Let apps access your microphone” และ “Let desktop apps access your microphone”",
      "กลับมากด “ตรวจอีกครั้ง”",
    ],
    fallback: "ระหว่างนี้ยังกดปุ่มไมค์เพื่อพูดคำสั่งได้ตามปกติ",
  },
  audio_device_busy: {
    problem: "มีโปรแกรมอื่นถือไมโครโฟนอยู่",
    steps: [
      "ปิดโปรแกรมที่ใช้ไมค์อยู่ เช่น โปรแกรมประชุมออนไลน์หรือโปรแกรมอัดเสียง",
      "กด “ตรวจอีกครั้ง”",
    ],
    fallback: "ระหว่างนี้ยังกดปุ่มไมค์เพื่อพูดคำสั่งได้ตามปกติ",
  },
  audio_input_missing: {
    problem: "หาไมโครโฟนไม่เจอ",
    steps: [
      "ตรวจว่าเสียบไมค์แน่นดีแล้ว",
      "เปิด Settings → System → Sound แล้วตั้งไมค์ที่ใช้เป็นอุปกรณ์เริ่มต้น",
      "กด “ตรวจอีกครั้ง”",
    ],
    fallback: "ระหว่างนี้ยังกดปุ่มไมค์เพื่อพูดคำสั่งได้ตามปกติ",
  },
  pronunciation_fallback: {
    problem: "เครื่องนี้อ่านคำปลุกภาษาไทยได้ไม่ดีเท่าที่ควร",
    steps: [
      "ใช้คำปลุกภาษาอังกฤษ “Hello OS” ซึ่งจับได้แม่นกว่าบนเครื่องนี้",
      "หรือพูดคำปลุกภาษาไทยให้ช้าและชัดขึ้นเล็กน้อย",
    ],
    fallback: "คำปลุกยังใช้งานได้ เพียงแต่ต้องพูดชัดกว่าปกติ",
  },
  engine_error: {
    problem: "ระบบเสียงบนเครื่องขัดข้อง",
    steps: [
      "ปิดแล้วเปิดโปรแกรม StoreOS Launcher ใหม่หนึ่งครั้ง",
      "ถ้ายังไม่หาย ให้ปิดเปิดเครื่องแล้วกด “ตรวจอีกครั้ง”",
    ],
    fallback: "ระหว่างนี้ยังกดปุ่มไมค์เพื่อพูดคำสั่งได้ตามปกติ",
  },
};

export function describeHostFault(code: VoiceHostFaultCode | null): HostRepairGuide | null {
  return code ? GUIDES[code] : null;
}
