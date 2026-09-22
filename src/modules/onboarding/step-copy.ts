// ข้อความของแต่ละขั้นเตรียมร้าน (F1/F5) — จุดเดียวที่เก็บ copy ให้หน้า /onboarding
// และ cron แจ้งเตือน activation ใช้ร่วมกัน เพื่อไม่ให้ข้อความสองที่เพี้ยนกัน
// businessMode มีผลแค่ถ้อยคำ ไม่มีผลกับตรรกะว่าขั้นไหนต้องทำ (ดู readiness.ts)
import type { ReadinessStepId } from "./readiness";
import type { BusinessMode } from "./setup-profile";

export type StepCopy = Readonly<{
  href: string;
  title: string;
  desc: string;
  /** ข้อความแจ้งเตือน (แจ้งทาง LINE/Telegram/push ไม่มีลิงก์กดได้ จึงบอกเส้นทางเป็นคำ) */
  nudge: string;
}>;

/** คำเรียกรายการที่ขาย — ร้านอาหารเรียก "เมนู" ร้านขายของเรียก "สินค้า" งานบริการเรียก "บริการ" */
function catalogNoun(mode: BusinessMode | null): string {
  if (mode === "retail") return "สินค้า";
  if (mode === "service") return "บริการ";
  return "เมนูสินค้า";
}

export function getStepCopy(step: ReadinessStepId, mode: BusinessMode | null): StepCopy {
  const noun = catalogNoun(mode);
  switch (step) {
    case "store-profile":
      return {
        href: "/settings/store",
        title: "ตั้งค่าข้อมูลร้าน",
        desc: "กรอกชื่อร้าน ที่อยู่ และเบอร์โทรให้ครบ",
        nudge: "ร้านของคุณยังไม่ได้กรอกชื่อ/ที่อยู่/เบอร์โทรให้ครบ — กรอกเสร็จจะพร้อมออกใบเสร็จ เปิดที่ StoreOS > ตั้งค่า > ร้านค้า",
      };
    case "catalog":
      return {
        href: "/catalog",
        title: `เพิ่ม${noun}`,
        desc: `สร้างหมวดหมู่ ${noun} ตัวเลือก และราคาเพื่อเริ่มขาย`,
        nudge: `ยังไม่มี${noun}ในระบบ — เพิ่มรายการแรกที่ StoreOS > เมนูสินค้า แล้วเริ่มขายได้เลย`,
      };
    case "table":
      return {
        href: "/settings/tables",
        title: "ตั้งค่าโต๊ะ",
        desc: "เพิ่มโต๊ะและ QR ประจำโต๊ะสำหรับลูกค้าสั่งเอง",
        nudge: "ร้านใช้โต๊ะแต่ยังไม่มีโต๊ะในระบบ — เพิ่มโต๊ะที่ StoreOS > ตั้งค่า > โต๊ะ & QR",
      };
    case "printer":
      return {
        href: "/settings/print-hub",
        title: "เชื่อมเครื่องพิมพ์",
        desc: "ตั้งค่าเครื่องพิมพ์ใบเสร็จ/สลิปของร้าน",
        nudge: "ยังไม่มีเครื่องพิมพ์ที่ตั้งค่า — เชื่อมได้ที่ StoreOS > ตั้งค่า > Print Hub หรืออุปกรณ์นี้",
      };
    case "first-paid-order":
      return {
        href: "/pos",
        title: "ปิดบิลขายจริงบิลแรก",
        desc: "เปิดบิลที่ POS แล้วรับเงินให้สำเร็จ 1 บิล — นับเป็นร้านที่เริ่มขายได้จริง",
        nudge: "เหลือขั้นสุดท้าย! เปิดบิลที่ POS แล้วรับเงิน 1 บิล = ร้านพร้อมขายจริง",
      };
  }
}

/** ค่าแนะนำเริ่มต้นของ 2 คำถามที่เหลือ เมื่อผู้ใช้เลือกประเภทร้าน */
export function recommendedAnswers(mode: BusinessMode): { usesTables: boolean; needsPrinting: boolean } {
  if (mode === "restaurant") return { usesTables: true, needsPrinting: true };
  if (mode === "retail") return { usesTables: false, needsPrinting: true };
  return { usesTables: false, needsPrinting: false };
}
