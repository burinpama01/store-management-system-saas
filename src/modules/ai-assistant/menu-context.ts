// AI Live — "รู้จักเมนูของร้าน" (2026-09-17)
//
// เดิม model ไม่เห็นอะไรเลยจนกว่าจะเรียก tool: ไม่รู้ว่ามีเมนูอะไร มีตัวเลือกอะไร หรือกลุ่มไหน
// มีค่าเริ่มต้นอยู่แล้ว จึงถามเกินจำเป็นและเดาชื่อเพี้ยน ไฟล์นี้สรุปเมนูจริงของร้านเป็น 3 แบบ:
//   1) describeProductOptions — ตัวเลือกของสินค้าหนึ่งตัว (ให้ tool ค้นหาตอบ model)
//   2) buildMenuInstructions  — รายการเมนูย่อ ๆ ต่อท้าย instructions ของเซสชัน
//   3) buildTranscriptionPrompt — ชื่อเมนู/ตัวเลือกให้ตัวถอดเสียง (ช่วยให้ข้อความที่บันทึกสะกดตรง)
//
// "ค่าเริ่มต้น" ใช้ buildDefaultModifierSelections ตัวเดียวกับหน้าขาย — ต้องตรงกับที่ระบบใส่จริง
// (รวมกฎสำรองตามชื่อกลุ่ม เช่น ความหวาน → 100%) ไม่ใช่แค่ flag isDefault
// pure ทั้งไฟล์: ไม่มี network/DB — ทดสอบได้ตรง ๆ

import type { Product } from "@/modules/catalog/types";
import { buildDefaultModifierSelections } from "@/modules/pos/default-modifiers";

export interface ProductOptionGroup {
  readonly group: string;
  /** ต้องได้ค่าก่อนใส่ตะกร้า (ตัวเลือกสินค้า หรือกลุ่มบังคับ) */
  readonly required: boolean;
  /** เลือกได้หลายอัน */
  readonly multiple: boolean;
  readonly options: readonly string[];
  /** ค่าที่ระบบใส่ให้เองถ้าไม่พูด — มีค่า = ไม่ต้องถามผู้ใช้ */
  readonly defaults: readonly string[];
}

/** ชื่อกลุ่มสมมุติของ variant — ตรงกับที่ tool ตอบใน choices อยู่แล้ว */
export const VARIANT_GROUP_NAME = "ตัวเลือกสินค้า";

const MAX_OPTIONS_PER_GROUP = 12;

export function describeProductOptions(product: Product): ProductOptionGroup[] {
  const groups: ProductOptionGroup[] = [];
  const variants = product.variants.filter((variant) => variant.isActive).map((variant) => variant.name);
  if (variants.length > 0) {
    // variant ไม่มีค่าเริ่มต้นในระบบ — ต้องพูดเสมอ
    groups.push({ group: VARIANT_GROUP_NAME, required: true, multiple: false, options: variants.slice(0, MAX_OPTIONS_PER_GROUP), defaults: [] });
  }
  const defaults = buildDefaultModifierSelections(product.modifierGroups);
  for (const group of product.modifierGroups) {
    const options = group.options.filter((option) => option.isActive).map((option) => option.name);
    if (options.length === 0) continue;
    groups.push({
      group: group.name,
      // ตรงกับ resolver (voice-pos/cart.ts): บังคับเฉพาะกลุ่ม isRequired
      required: group.isRequired,
      multiple: group.selectionType !== "single",
      options: options.slice(0, MAX_OPTIONS_PER_GROUP),
      defaults: (defaults[group.id] ?? []).map((option) => option.name),
    });
  }
  return groups;
}

function sellable(products: readonly Product[]): Product[] {
  return products
    .filter((product) => product.isActive && product.availableForPos)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "th"));
}

function describeGroupLine(group: ProductOptionGroup): string {
  const tags = [group.required ? "ต้องเลือก" : "ไม่บังคับ"];
  if (group.multiple) tags.push("เลือกได้หลายอัน");
  if (group.defaults.length > 0) tags.push(`ค่าเริ่มต้น ${group.defaults.join("+")}`);
  return `${group.group} (${tags.join(", ")}): ${group.options.join("/")}`;
}

/** เพดานความยาวของรายการเมนูใน instructions — ร้านเมนูเยอะไม่ให้ token บวมไม่จำกัด */
export const MENU_INSTRUCTIONS_MAX_CHARS = 8000;

/**
 * รายการเมนูสำหรับ instructions — คืน null เมื่อไม่มีเมนูขาย
 * ถ้ายาวเกินเพดาน ตัดท้ายแล้วบอก model ให้ใช้ tool ค้นหาเมนูที่ไม่อยู่ในรายการ
 */
export function buildMenuInstructions(products: readonly Product[], maxChars = MENU_INSTRUCTIONS_MAX_CHARS): string | null {
  const items = sellable(products);
  if (items.length === 0) return null;
  const header = [
    "เมนูของร้านตอนนี้ (ชื่อตรงตามระบบ ใช้ชื่อเหล่านี้ตอนเรียก tool):",
    "กลุ่มที่มี \"ค่าเริ่มต้น\" ไม่ต้องถามผู้ใช้ ถ้าผู้ใช้ไม่พูดระบบใส่ค่าเริ่มต้นให้เอง ถามเฉพาะกลุ่ม \"ต้องเลือก\" ที่ไม่มีค่าเริ่มต้น",
  ].join("\n");
  const lines: string[] = [];
  let length = header.length;
  let omitted = 0;
  for (const product of items) {
    const groups = describeProductOptions(product);
    const parts = [`- ${product.name}${product.outOfStock === true ? " [ของหมด]" : ""}`];
    for (const group of groups) parts.push(describeGroupLine(group));
    const line = parts.join(" | ");
    if (length + line.length + 1 > maxChars) {
      omitted += 1;
      continue;
    }
    lines.push(line);
    length += line.length + 1;
  }
  if (omitted > 0) lines.push(`(ยังมีอีก ${omitted} เมนูที่ไม่ได้แสดง — ถ้าผู้ใช้พูดชื่อที่ไม่อยู่ในรายการ ให้เรียก pos_search_product ก่อน)`);
  return `${header}\n${lines.join("\n")}`;
}

/** เพดาน prompt ของตัวถอดเสียง — prompt ยาวเกินไปถอดช้าลงและถูกตัดทิ้ง */
export const TRANSCRIPTION_PROMPT_MAX_CHARS = 900;

/** ชื่อเมนูและชื่อตัวเลือก (ไม่ซ้ำ) ให้ตัวถอดเสียงภาษาไทยสะกดคำเฉพาะของร้านได้ตรง */
export function buildTranscriptionPrompt(products: readonly Product[], maxChars = TRANSCRIPTION_PROMPT_MAX_CHARS): string | null {
  const words = new Set<string>();
  const items = sellable(products);
  for (const product of items) words.add(product.name.trim());
  for (const product of items) {
    for (const group of describeProductOptions(product)) for (const option of group.options) words.add(option.trim());
  }
  const prefix = "บทสนทนาสั่งอาหารและเครื่องดื่มหน้าร้านภาษาไทย คำที่อาจได้ยิน: ";
  let text = prefix;
  for (const word of words) {
    if (!word) continue;
    const next = text === prefix ? `${text}${word}` : `${text}, ${word}`;
    if (next.length > maxChars) break;
    text = next;
  }
  return text === prefix ? null : text;
}
