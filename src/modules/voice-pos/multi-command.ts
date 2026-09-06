// สั่งหลายเมนูในประโยคเดียว โดยไม่ต้องพึ่ง AI
//
// ทำไมต้องมี: คนสั่งของพูดรวดเดียว ("เพิ่มลาเต้สองแก้วกับชาเย็นหนึ่งแก้ว")
// ของเดิมแตกเป็นหลายคำสั่งได้เฉพาะเส้นทาง AI ซึ่งจะวิ่งก็ต่อเมื่อ parser ปกติ "ฟังไม่ออกเลย" —
// พอมันฟังออกเมนูแรก ก็หยุดแค่นั้นและเมนูที่เหลือหายไปเงียบ ๆ
// (ยิ่งกว่านั้น flag ของ AI ยังปิดอยู่ทุกร้าน ทางนั้นจึงไม่เคยทำงานจริงเลย)
//
// อีกเหตุผลเชิงเทคนิค: parser แปลงคำจำนวนไทยเฉพาะที่ "ท้ายประโยค" เท่านั้น
// ("สอง" กลางประโยคไม่ถูกแปลง เพราะ "หมูสามชั้น" ต้องไม่กลายเป็น "หมู 3 ชั้น")
// การตัดเป็นท่อนก่อนแล้วค่อย parse จึงทำให้แต่ละท่อนมีจำนวนอยู่ท้ายประโยคของตัวเอง
//
// กติกาความปลอดภัย: ชื่อเมนูจริงมีคำเชื่อมอยู่ข้างในได้ ("ข้าวหมูกรอบกับไข่ดาว")
// การตัดผิดแปลว่าลูกค้าได้ของผิดรายการ ซึ่งแย่กว่าการไม่รองรับประโยคยาว
// จึงยอมรับว่าเป็น "หลายรายการ" ก็ต่อเมื่อทุกท่อนชี้ไปที่สินค้าที่มีจริงในเมนู
// และประโยคเต็มไม่ได้เป็นชื่อสินค้าอยู่แล้ว

import { AI_VOICE_MAX_COMMANDS, type AiVoiceCommand } from "./ai-intent-schema";
import type { VoiceParseResult } from "./types";

/**
 * คำเชื่อมที่ใช้ตัดประโยค
 *
 * เลือกเฉพาะคำที่คนไทยใช้คั่น "รายการ" จริง ๆ ไม่รวมคำอย่าง "อีก" ซึ่งเป็นส่วนหนึ่ง
 * ของคำสั่งเดียว ("เพิ่มอีกสองแก้ว") — ตัดตรงนั้นจะทำให้จำนวนเพี้ยน
 */
const SEPARATORS: readonly string[] = ["แล้วก็", "พร้อมกับ", "และ", "กับ", "แล้ว", ","];

/** คำนำหน้าคำสั่งเพิ่มของ parser — ท่อนหลังมักละไว้ ("...กับชาเย็นหนึ่งแก้ว") */
const LEAD_VERBS: readonly string[] = ["เพิ่ม", "ใส่", "สั่ง"];

/** ตัดประโยคเป็นท่อน ๆ ตามคำเชื่อม (ยังไม่ตัดสินว่าเชื่อถือได้ไหม) */
export function splitVoiceSegments(transcript: string): string[] {
  let parts = [transcript];
  for (const separator of SEPARATORS) {
    parts = parts.flatMap((part) => part.split(separator));
  }
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

/** intent ที่แปลงเป็นคำสั่งในคิวได้ — ตะกร้าเท่านั้น (นำทาง/ล้างคำค้นไม่ใช่การสั่งของ) */
function toQueueCommand(result: VoiceParseResult): AiVoiceCommand | null {
  if (result.decision !== "execute") return null;

  const intent = result.intent;
  switch (intent.type) {
    case "pos.add_item":
      return { intent: "pos.add_item", productPhrase: intent.productPhrase, quantity: intent.quantity, optionPhrases: [] };
    case "pos.set_quantity":
      return { intent: "pos.set_quantity", productPhrase: intent.productPhrase, quantity: intent.quantity, optionPhrases: [] };
    case "pos.increase_item":
      return { intent: "pos.increase_item", productPhrase: intent.productPhrase, quantity: intent.delta, optionPhrases: [] };
    case "pos.decrease_item":
      return { intent: "pos.decrease_item", productPhrase: intent.productPhrase, quantity: intent.delta, optionPhrases: [] };
    case "pos.remove_item":
      return { intent: "pos.remove_item", productPhrase: intent.productPhrase, quantity: null, optionPhrases: [] };
    default:
      return null;
  }
}

export interface MultiCommandDeps {
  /** parser เดิม (ฉีดเข้ามาเพื่อไม่ให้โมดูลนี้ผูกกับ options ของผู้เรียก) */
  readonly parse: (text: string) => VoiceParseResult;
  /** ชื่อที่ได้ยินชี้ไปที่สินค้าที่มีจริงหรือไม่ — จับแบบหลวมได้ (คนพูดไม่ตรงชื่อเป๊ะ) */
  readonly isKnownProduct: (phrase: string) => boolean;
  /**
   * ชื่อที่ได้ยิน "เป็นชื่อสินค้าทั้งชื่อ" หรือไม่ — ต้องเข้มกว่า isKnownProduct
   *
   * ใช้กับประโยคเต็มเท่านั้น: ตัวจับคู่ของระบบจับแบบคำขึ้นต้น
   * "ลาเต้สองแก้วและชาเย็น" จึงชี้ไป "ลาเต้" ได้ — ถ้าใช้ตัวหลวมตรงนี้
   * ประโยคหลายเมนูทุกประโยคจะถูกตัดสินว่าเป็นสินค้าชิ้นเดียวเสมอ
   */
  readonly isExactProduct: (phrase: string) => boolean;
}

export interface MultiCommandBatch {
  readonly commands: readonly AiVoiceCommand[];
  /** ป้ายสำหรับให้ผู้ใช้ยืนยันก่อนแตะตะกร้า — ไม่มีคำพูดดิบอยู่ในนั้น */
  readonly label: string;
}

/**
 * ตีความประโยคเป็น "หลายคำสั่ง" — คืน null เมื่อไม่ใช่ (ผู้เรียกใช้เส้นทางเดิมต่อ)
 */
export function buildMultiCommandBatch(
  transcript: string,
  deps: MultiCommandDeps,
): MultiCommandBatch | null {
  const segments = splitVoiceSegments(transcript);
  if (segments.length < 2 || segments.length > AI_VOICE_MAX_COMMANDS) return null;

  // ประโยคเต็มเป็นชื่อสินค้าที่มีอยู่จริง = คำเชื่อมนั้นเป็นส่วนหนึ่งของชื่อเมนู
  // ("เพิ่มข้าวหมูกรอบกับไข่ดาว") — รายการเดียวชนะเสมอ
  const whole = toQueueCommand(deps.parse(transcript));
  if (whole?.productPhrase && deps.isExactProduct(whole.productPhrase)) return null;

  // ท่อนหลังมักละคำกริยาไว้ จึงยืมคำกริยาของท่อนแรกมาใช้ต่อ
  const leadVerb = LEAD_VERBS.find((verb) => transcript.trimStart().startsWith(verb)) ?? null;

  const commands: AiVoiceCommand[] = [];
  for (const [index, segment] of segments.entries()) {
    let command = toQueueCommand(deps.parse(segment));
    if (!command && index > 0 && leadVerb) {
      command = toQueueCommand(deps.parse(`${leadVerb}${segment}`));
    }
    // ท่อนไหนแปลไม่ได้ = การตัดครั้งนี้ไม่น่าเชื่อถือ ทิ้งทั้งชุด
    if (!command?.productPhrase) return null;
    if (!deps.isKnownProduct(command.productPhrase)) return null;
    commands.push(command);
  }

  return { commands, label: describeBatch(commands) };
}

/** ป้ายของทั้งชุด เช่น "2 รายการ: ลาเต้ 2, ชาเย็น 1" */
export function describeBatch(commands: readonly AiVoiceCommand[]): string {
  const parts = commands.map((command) => {
    const quantity = command.quantity ?? 1;
    const name = command.productPhrase ?? "";
    switch (command.intent) {
      case "pos.add_item":
        return `${name} ${quantity}`;
      case "pos.set_quantity":
        return `${name} เป็น ${quantity}`;
      case "pos.increase_item":
        return `${name} +${quantity}`;
      case "pos.decrease_item":
        return `${name} -${quantity}`;
      case "pos.remove_item":
        return `เอา ${name} ออก`;
      default:
        return name;
    }
  });
  return `${commands.length} รายการ: ${parts.join(", ")}`;
}
