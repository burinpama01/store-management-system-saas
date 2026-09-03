// U22 — ตัวเสนอ "คำเรียกเมนู" อัตโนมัติ (pure ล้วน ไม่มี AI ไม่มี network)
//
// ปัญหาจริงจากหน้าร้าน: เมนูตั้งชื่อเป็นภาษาอังกฤษ ("Matcha latte", "Espresso")
// แต่พนักงานพูดไทย ("มัจฉะลาเต้", "เอสเพรสโซ") — เทียบตัวอักษรยังไงก็ไม่มีวันตรงกัน
//
// วิธีแก้: อ่านชื่อเมนู แล้ว "เสนอ" คำที่พนักงานน่าจะพูด จากพจนานุกรมที่เขียนไว้ตายตัว
// แล้วให้คนตรวจก่อนบันทึกเสมอ — ระบบไม่บันทึกเองและไม่เรียนรู้จากเสียงที่ได้ยิน
//
// ข้อบังคับ: ทุกคำที่เสนอมาจากกฎที่อธิบายได้ ไม่มีการเดาแบบสุ่ม และผลลัพธ์คงที่ทุกครั้ง

/** คำอังกฤษ → คำที่คนไทยพูด (คำแรกคือคำที่ใช้บ่อยที่สุด) */
const EN_TO_TH: ReadonlyArray<readonly [string, readonly string[]]> = [
  // วลี 2 คำต้องมาก่อนคำเดี่ยว เพราะจับคู่จากยาวไปสั้น
  ["green tea", ["ชาเขียว"]],
  ["thai tea", ["ชาไทย", "ชาเย็น"]],
  ["sparkling water", ["น้ำโซดา", "สปาร์กลิ้ง"]],
  ["iced coffee", ["กาแฟเย็น"]],
  ["orange juice", ["น้ำส้ม"]],
  ["americano", ["อเมริกาโน่"]],
  ["cappuccino", ["คาปูชิโน่"]],
  ["espresso", ["เอสเพรสโซ", "เอสเปรสโซ"]],
  ["macchiato", ["มัคคิอาโต้"]],
  ["affogato", ["อาฟโฟกาโต้"]],
  ["chocolate", ["ช็อกโกแลต", "ช็อคโกแลต"]],
  ["strawberry", ["สตรอว์เบอร์รี", "สตรอเบอร์รี"]],
  ["cheesecake", ["ชีสเค้ก"]],
  ["smoothies", ["สมูทตี้"]],
  ["smoothie", ["สมูทตี้"]],
  ["caramel", ["คาราเมล"]],
  ["vanilla", ["วานิลลา"]],
  ["hazelnut", ["เฮเซลนัท"]],
  ["coconut", ["มะพร้าว"]],
  ["matcha", ["มัจฉะ", "มัทฉะ"]],
  ["mocha", ["มอคค่า", "ม็อคค่า"]],
  ["latte", ["ลาเต้"]],
  ["cocoa", ["โกโก้"]],
  ["coffee", ["กาแฟ"]],
  ["honey", ["น้ำผึ้ง"]],
  ["lemon", ["มะนาว"]],
  ["orange", ["ส้ม"]],
  ["apple", ["แอปเปิ้ล"]],
  ["peach", ["พีช"]],
  ["milk", ["นม"]],
  ["soda", ["โซดา"]],
  ["water", ["น้ำ"]],
  ["tea", ["ชา"]],
  ["ice", ["น้ำแข็ง"]],
  ["hot", ["ร้อน"]],
  ["cold", ["เย็น"]],
  ["oat", ["โอ๊ต"]],
  ["set", ["ชุด"]],
];

/** คำขยายที่ตัดออกแล้วยังสื่อถึงเมนูเดิม (ใช้สร้าง "คำเรียกสั้น") */
const DROPPABLE_TOKENS: readonly string[] = ["pure", "soft", "special", "premium", "signature", "original", "ชุด", "โปร"];

/** จำนวนคำเรียกสูงสุดที่เสนอต่อ 1 เมนู — มากกว่านี้คนตรวจไม่ไหว */
export const MAX_ALIAS_SUGGESTIONS_PER_PRODUCT = 3;

export interface VoiceAliasSuggestion {
  readonly productId: string;
  readonly productName: string;
  /** คำที่เสนอให้พนักงานพูด */
  readonly aliasText: string;
  /** เหตุผลที่เสนอ — แสดงให้คนตรวจตัดสินใจ */
  readonly reason: "แปลจากชื่ออังกฤษ" | "คำเรียกสั้น" | "ตัดคำประกอบ";
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/** ตัดสิ่งที่ไม่ใช่ชื่อเมนูออก: ราคา/ตัวเลข/วงเล็บ/เครื่องหมาย */
function stripDecorations(name: string): string {
  return name
    .replace(/\([^)]*\)/g, " ")
    .replace(/[+/|,]/g, " ")
    .replace(/\d+(\.\d+)?%?/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasThai(value: string): boolean {
  return /[฀-๿]/.test(value);
}

function hasLatin(value: string): boolean {
  return /[a-z]/i.test(value);
}

/**
 * แปลชื่อเมนูอังกฤษเป็นคำที่คนไทยพูด
 * คืนได้หลายคำเมื่อมีคำพ้อง (เช่น matcha = มัจฉะ/มัทฉะ) แต่ไม่เกิน 2 ชุด
 */
function translateToThai(name: string): string[] {
  let rest = normalize(stripDecorations(name));
  if (!rest) return [];

  const parts: string[][] = [];
  let matchedAny = false;
  let guard = 0;

  while (rest.length > 0 && guard < 24) {
    guard += 1;
    rest = rest.trim();
    if (!rest) break;

    const hit = EN_TO_TH.find(([en]) => rest.startsWith(en));
    if (hit) {
      parts.push([...hit[1]]);
      rest = rest.slice(hit[0].length);
      matchedAny = true;
      continue;
    }
    // คำไทยที่ปนอยู่ในชื่อ — เก็บไว้ตามเดิม
    const thaiRun = /^[฀-๿]+/.exec(rest);
    if (thaiRun) {
      parts.push([thaiRun[0]]);
      rest = rest.slice(thaiRun[0].length);
      continue;
    }
    // คำอังกฤษที่ไม่มีในพจนานุกรม → แปลไม่ได้ทั้งชื่อ (ไม่เดา)
    const word = /^[a-z]+/.exec(rest);
    if (word) {
      if (DROPPABLE_TOKENS.includes(word[0])) {
        rest = rest.slice(word[0].length);
        continue;
      }
      return [];
    }
    rest = rest.slice(1);
  }

  if (!matchedAny || parts.length === 0) return [];

  // ชุดหลัก = คำแรกของทุกส่วน ; ชุดรอง = ใช้คำพ้องตัวที่สองถ้ามี
  const primary = parts.map((options) => options[0]).join("");
  const secondary = parts.map((options) => options[1] ?? options[0]).join("");
  return secondary && secondary !== primary ? [primary, secondary] : [primary];
}

/** คำเรียกสั้นของชื่อไทย: ตัดคำประกอบหน้า/หลังออก เช่น "ชุดหมูจุ่ม+ผัก 99" → "หมูจุ่ม" */
function shortThaiForms(name: string): string[] {
  const cleaned = stripDecorations(name).trim();
  if (!cleaned || !hasThai(cleaned)) return [];

  const forms = new Set<string>();
  const firstChunk = cleaned.split(" ")[0]?.trim();
  if (firstChunk && firstChunk !== cleaned) forms.add(firstChunk);

  let dropped = firstChunk ?? cleaned;
  for (const token of DROPPABLE_TOKENS) {
    if (dropped.startsWith(token) && dropped.length > token.length + 1) {
      dropped = dropped.slice(token.length);
      forms.add(dropped);
    }
  }
  return [...forms].filter((form) => form.length >= 3 && form !== cleaned);
}

/**
 * เสนอคำเรียกของเมนูหนึ่งรายการ — คืน [] เมื่อไม่มีอะไรน่าเสนอ
 * (ชื่อไทยล้วนที่พูดได้อยู่แล้วไม่ต้องมี alias)
 */
export function suggestAliasesForProduct(product: {
  readonly id: string;
  readonly name: string;
}): VoiceAliasSuggestion[] {
  const out: VoiceAliasSuggestion[] = [];
  const seen = new Set<string>();
  const push = (aliasText: string, reason: VoiceAliasSuggestion["reason"]) => {
    const text = aliasText.trim();
    const key = normalize(text);
    if (!text || text.length < 2 || seen.has(key) || key === normalize(product.name)) return;
    seen.add(key);
    out.push({ productId: product.id, productName: product.name, aliasText: text, reason });
  };

  if (hasLatin(product.name)) {
    for (const translated of translateToThai(product.name)) push(translated, "แปลจากชื่ออังกฤษ");
  }
  for (const short of shortThaiForms(product.name)) push(short, "คำเรียกสั้น");
  if (stripDecorations(product.name) !== product.name.trim()) {
    push(stripDecorations(product.name), "ตัดคำประกอบ");
  }

  return out.slice(0, MAX_ALIAS_SUGGESTIONS_PER_PRODUCT);
}

/**
 * เสนอคำเรียกของทั้งเมนู — ข้ามคำที่ร้านมีอยู่แล้ว และข้ามคำที่ชนกันเอง
 * (คำเรียกหนึ่งคำต้องชี้ไปเมนูเดียวเท่านั้น ไม่งั้นพูดแล้วกำกวม)
 */
export function suggestVoiceAliases(
  products: ReadonlyArray<{ readonly id: string; readonly name: string; readonly isActive?: boolean }>,
  existingAliasTexts: readonly string[] = [],
): VoiceAliasSuggestion[] {
  const taken = new Set(existingAliasTexts.map((text) => normalize(text)));
  const productNames = new Set(products.map((product) => normalize(product.name)));
  const byAlias = new Map<string, VoiceAliasSuggestion[]>();

  for (const product of products) {
    if (product.isActive === false) continue;
    for (const suggestion of suggestAliasesForProduct(product)) {
      const key = normalize(suggestion.aliasText);
      if (taken.has(key) || productNames.has(key)) continue;
      byAlias.set(key, [...(byAlias.get(key) ?? []), suggestion]);
    }
  }

  return [...byAlias.values()]
    .filter((group) => group.length === 1)
    .map((group) => group[0])
    .sort((a, b) => a.productName.localeCompare(b.productName, "th"));
}
