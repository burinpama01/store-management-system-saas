import type { TemplateInput, TemplateItemInput } from "./types";

/**
 * คลังแม่แบบเช็กลิสต์ตามประเภทร้าน — เลือกรวมกันได้ (เช่น อาหาร + กาแฟ + ของสด)
 *
 * กติกา (คำตอบเจ้าของข้อ 2: เจ้าของปรับแต่งเอง):
 *   - ทุกชุดสร้างแบบ "ปิดใช้" และยังไม่มีผู้รับผิดชอบ — เจ้าของตรวจ/แก้ก่อนเปิด
 *   - ไม่ฝังช่วงอุณหภูมิ/เกณฑ์ความปลอดภัยอาหาร: ข้อวัดค่ามีหน่วยแต่ช่วงว่าง ให้ร้านกำหนดตาม SOP
 *   - ชื่อเช็กลิสต์ไม่ซ้ำกันในผลลัพธ์ (หลายครัว = แยกชุดต่อครัว)
 */

export type StorePackId =
  | "restaurant"
  | "cafe"
  | "bar"
  | "grocery"
  | "convenience"
  | "multi_kitchen"
  | "fresh"
  | "expiry";

export interface StorePack {
  id: StorePackId;
  label: string;
  description: string;
  kind: "store" | "addon";
}

export const STORE_PACKS: StorePack[] = [
  { id: "restaurant", label: "ร้านอาหาร", description: "เปิด / ระหว่างวัน / ปิดครัว — ข้าวและอาหารเหลือ, แก๊ส, ของพร้อมขาย", kind: "store" },
  { id: "cafe", label: "ร้านกาแฟ / เครื่องดื่ม", description: "เปิด-ปิดบาร์กาแฟ — นม, น้ำแข็ง, เครื่องชง, ไซรัป/ผลไม้", kind: "store" },
  { id: "bar", label: "ร้านเหล้า / ผับ / บาร์", description: "เปิดบาร์ / ปิดร้านกลางคืน — ตู้เบียร์, ขวดเปิดแล้ว, ความปลอดภัยลูกค้า, ล็อกร้าน", kind: "store" },
  { id: "grocery", label: "ร้านของชำ", description: "เปิด-ปิดร้าน — เติมชั้นวาง, ของหมดต้องสั่ง, ตู้แช่", kind: "store" },
  { id: "convenience", label: "ร้านสะดวกซื้อ / มินิมาร์ท", description: "เปิดร้าน / ตรวจระหว่างกะ / ส่งกะ-ปิดร้าน — หมุนเวียนสินค้า, ตู้แช่, ความสะอาด", kind: "store" },
  { id: "multi_kitchen", label: "มีหลายครัว", description: "แยกเช็กลิสต์เปิด/ระหว่างวัน/ปิด ต่อครัว ตามชื่อที่ตั้ง", kind: "addon" },
  { id: "fresh", label: "มีวัตถุดิบของสด", description: "รับของสด + ตรวจตู้เย็น/ช่องแช่แข็ง, ใช้ของเก่าก่อน, ทิ้งของเสีย", kind: "addon" },
  { id: "expiry", label: "มีสินค้าที่หมดอายุ", description: "ตรวจวันหมดอายุ, เอาของหมดอายุออก, จัดของใกล้หมดไว้หน้า", kind: "addon" },
];

export const MAX_KITCHENS = 6;
export const MAX_KITCHEN_NAME_LENGTH = 40;

export interface StarterSelection {
  packs: StorePackId[];
  /** ใช้เมื่อเลือก multi_kitchen — เช่น ["ครัวร้อน", "ครัวเย็น"] */
  kitchenNames: string[];
}

export type StarterTemplate = TemplateInput & { packId: StorePackId };

const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];

function item(label: string, overrides: Partial<TemplateItemInput> = {}): TemplateItemInput {
  return {
    label,
    description: null,
    critical: false,
    valueType: "check",
    unit: null,
    minValue: null,
    maxValue: null,
    photoRule: "never",
    ...overrides,
  };
}

/** ข้อวัดอุณหภูมิ: หน่วย °C แต่ไม่ฝังช่วง — ร้านใส่ช่วงเอง */
function tempItem(label: string, critical = true): TemplateItemInput {
  return item(label, {
    critical,
    valueType: "number",
    unit: "°C",
    photoRule: "on_fail",
    description: "วัดด้วยเครื่องวัดจริง — ร้านกำหนดช่วงที่ผ่านในหน้าแก้ไข",
  });
}

function template(
  packId: StorePackId,
  name: string,
  area: string,
  phase: TemplateInput["phase"],
  requireBeforeClockOut: boolean,
  items: TemplateItemInput[],
): StarterTemplate {
  return {
    packId,
    name,
    area,
    phase,
    dueTime: null,
    daysOfWeek: EVERY_DAY,
    requireBeforeClockOut,
    assigneeUserIds: [],
    isActive: false,
    sortOrder: 0,
    items,
  };
}

function kitchenTemplates(packId: StorePackId, kitchen: string): StarterTemplate[] {
  return [
    template(packId, `เปิด${kitchen}`, kitchen, "open", false, [
      tempItem("อุณหภูมิตู้เย็นในครัว"),
      item("ตรวจวัตถุดิบ/วันหมดอายุ/กลิ่นผิดปกติ", { critical: true, photoRule: "on_fail" }),
      item("เตรียมของพร้อมขายครบตามเมนู"),
      item("ความสะอาดพื้นที่ เขียง มีด และอุปกรณ์"),
      item("แก๊ส/เตา/เครื่องดูดควันทำงานปกติ", { critical: true }),
    ]),
    template(packId, `ระหว่างวัน · ${kitchen}`, kitchen, "mid", false, [
      item("ของใกล้หมด แจ้งเตรียมเพิ่ม/สั่งซื้อแล้ว"),
      item("อาหารที่เตรียมไว้เก็บถูกที่ ปิดฝา"),
      item("ล้างมือ/เปลี่ยนถุงมือตามรอบ"),
      item("ทิ้งขยะ/เศษอาหารระหว่างวัน"),
    ]),
    template(packId, `ปิด${kitchen}`, kitchen, "close", true, [
      item("จัดการข้าวและอาหารเหลือตามวิธีที่ร้านกำหนด", { critical: true, photoRule: "always" }),
      item("แยกของเสีย/ทิ้งตามที่ร้านกำหนด"),
      item("ปิดฝา ติดฉลากวันที่ เก็บเข้าตู้ตามอุณหภูมิ", { critical: true }),
      tempItem("อุณหภูมิตู้เย็นก่อนปิด"),
      item("ล้างอุปกรณ์และพื้นที่"),
      item("ปิดแก๊ส/ไฟเตา", { critical: true }),
      item("ตรวจของสำหรับวันถัดไป และแจ้งของที่ต้องซื้อ"),
    ]),
  ];
}

const PACK_BUILDERS: Record<Exclude<StorePackId, "restaurant" | "multi_kitchen">, () => StarterTemplate[]> = {
  cafe: () => [
    template("cafe", "เปิดบาร์กาแฟ", "บาร์กาแฟ", "open", false, [
      item("ตรวจนมและของแช่เย็น (วันหมดอายุ/กลิ่น)", { critical: true, photoRule: "on_fail" }),
      tempItem("อุณหภูมิตู้แช่นม"),
      item("น้ำและน้ำแข็งสะอาด", { critical: true }),
      item("เครื่องชง/เครื่องบด/เครื่องปั่นทำงานปกติ"),
      item("กาแฟ ไซรัป ผลไม้ แก้ว หลอด พร้อมขาย"),
    ]),
    template("cafe", "ปิดบาร์กาแฟ", "บาร์กาแฟ", "close", true, [
      item("เก็บนม/ผลไม้ที่เปิดใช้ ตามที่ร้านกำหนด", { critical: true }),
      item("ล้างเครื่องชง หัวชง และเหยือกนม"),
      item("ทิ้งน้ำแข็งเหลือ/ล้างถังน้ำแข็ง"),
      item("ตรวจสต๊อกสำคัญ และแจ้งของที่ต้องซื้อ"),
    ]),
  ],
  bar: () => [
    template("bar", "เปิดบาร์", "บาร์", "open", false, [
      tempItem("อุณหภูมิตู้เบียร์/ตู้แช่เครื่องดื่ม", false),
      item("น้ำแข็งพอและสะอาด", { critical: true }),
      item("แก้ว/อุปกรณ์ชงสะอาดพร้อมใช้"),
      item("เครื่องดื่มและขวดสำรองพร้อมขาย"),
      item("ทางหนีไฟ/ไฟฉุกเฉิน/ถังดับเพลิงพร้อม", { critical: true }),
      item("ป้ายห้ามจำหน่ายผู้อายุต่ำกว่า 20 ปี ติดชัดเจน"),
    ]),
    template("bar", "ปิดร้านกลางคืน", "บาร์", "close", true, [
      item("ไม่มีลูกค้าค้างในร้าน/ห้องน้ำ", { critical: true }),
      item("นับขวดเปิดแล้ว/สต๊อกเหล้าที่ร้านกำหนด"),
      item("ล้างแก้วและอุปกรณ์ เก็บขวดเปิดแล้วตามที่ร้านกำหนด"),
      item("ปิดเครื่องเสียง ไฟ และอุปกรณ์ไฟฟ้าที่ไม่ใช้"),
      item("ล็อกตู้เหล้าและประตูร้าน", { critical: true, photoRule: "always" }),
    ]),
  ],
  grocery: () => [
    template("grocery", "เปิดร้านของชำ", "หน้าร้าน", "open", false, [
      item("เติมสินค้าขายดีบนชั้นวาง"),
      tempItem("อุณหภูมิตู้แช่เครื่องดื่ม/ของสด", false),
      item("ตรวจสินค้าเสียหาย/บวม/รั่ว แยกออก"),
      item("เงินทอนพร้อม"),
      item("หน้าร้านและทางเดินสะอาด"),
    ]),
    template("grocery", "ปิดร้านของชำ", "หน้าร้าน", "close", true, [
      item("จดสินค้าหมด/ใกล้หมดที่ต้องสั่ง"),
      item("เก็บสินค้าหน้าร้านเข้าร้าน"),
      item("ตู้แช่ยังเปิดอยู่ ประตูตู้ปิดสนิท", { critical: true }),
      item("ปิดไฟ/อุปกรณ์ที่ไม่ใช้ และล็อกร้าน", { critical: true }),
    ]),
  ],
  convenience: () => [
    template("convenience", "เปิดร้านสะดวกซื้อ", "หน้าร้าน", "open", false, [
      tempItem("อุณหภูมิตู้แช่เย็น"),
      tempItem("อุณหภูมิตู้แช่แข็ง"),
      item("เติมสินค้าชั้นวางและตู้แช่"),
      item("เครื่อง POS/เครื่องพิมพ์ใบเสร็จพร้อม"),
      item("พื้นร้านและทางเข้าสะอาด"),
    ]),
    template("convenience", "ตรวจระหว่างกะ", "หน้าร้าน", "mid", false, [
      item("หมุนสินค้าเก่าออกด้านหน้า (FIFO)"),
      item("เติมสินค้าที่ขาดชั้น"),
      item("ห้องน้ำ/ถังขยะสะอาด"),
      item("ตู้แช่ปิดสนิท ไม่มีน้ำแข็งเกาะผิดปกติ"),
    ]),
    template("convenience", "ส่งกะ / ปิดร้าน", "หน้าร้าน", "close", true, [
      item("นับเงินในลิ้นชักและปิดรอบเงินสด"),
      item("จดสินค้าหมด/ใกล้หมดที่ต้องสั่ง"),
      item("ตู้แช่ยังเปิดอยู่ ประตูตู้ปิดสนิท", { critical: true }),
      item("ส่งงานค้างให้กะถัดไป/ล็อกร้าน", { critical: true }),
    ]),
  ],
  fresh: () => [
    template("fresh", "รับและตรวจของสด", "วัตถุดิบ", "other", false, [
      tempItem("อุณหภูมิของสดตอนรับ"),
      item("กลิ่น สี สภาพบรรจุภัณฑ์ปกติ — ไม่ปกติให้ตีกลับ", { critical: true, photoRule: "on_fail" }),
      item("ติดฉลากวันที่รับ"),
      item("แยกของดิบกับของสุก/พร้อมกิน", { critical: true }),
      item("เก็บเข้าตู้ทันทีหลังรับ"),
    ]),
    template("fresh", "ตรวจตู้เย็นและช่องแช่แข็ง", "วัตถุดิบ", "mid", false, [
      tempItem("อุณหภูมิตู้เย็น"),
      tempItem("อุณหภูมิช่องแช่แข็ง"),
      item("ใช้ของเก่าก่อน (FIFO) จัดของเก่าไว้หน้า"),
      item("ทิ้งของเสีย/เกินวันที่ร้านกำหนด และบันทึก", { critical: true, photoRule: "on_fail" }),
      item("ตู้สะอาด ไม่มีน้ำหยด/ของหกค้าง"),
    ]),
  ],
  expiry: () => [
    template("expiry", "ตรวจวันหมดอายุสินค้า", "สต๊อก", "mid", false, [
      item("ตรวจสินค้าใกล้หมดอายุตามระยะที่ร้านกำหนด"),
      item("เอาสินค้าหมดอายุออกจากชั้นขาย", { critical: true, photoRule: "on_fail" }),
      item("บันทึกของทิ้ง/ส่งคืนผู้ขาย"),
      item("จัดของใกล้หมดอายุไว้ด้านหน้า (FEFO)"),
      item("ติดป้ายลดราคาตามนโยบายร้าน (ถ้ามี)"),
    ]),
  ],
};

export function normalizeKitchenNames(names: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of names) {
    const name = raw.trim().replace(/\s+/g, " ").slice(0, MAX_KITCHEN_NAME_LENGTH);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    result.push(name);
    if (result.length >= MAX_KITCHENS) break;
  }
  return result;
}

export function isStorePackId(value: unknown): value is StorePackId {
  return typeof value === "string" && STORE_PACKS.some((pack) => pack.id === value);
}

/** รวมแม่แบบจากชุดที่เลือก — เรียงตามลำดับ STORE_PACKS, ชื่อไม่ซ้ำ, sortOrder ต่อเนื่อง */
export function buildStarterTemplates(selection: StarterSelection): StarterTemplate[] {
  const packs = new Set(selection.packs.filter(isStorePackId));
  const result: StarterTemplate[] = [];
  let kitchensBuilt = false;

  for (const pack of STORE_PACKS) {
    if (!packs.has(pack.id)) continue;
    if (pack.id === "restaurant" || pack.id === "multi_kitchen") {
      // ครัวสร้างครั้งเดียวไม่ว่าลำดับ pack: หลายครัว = ชุดต่อชื่อครัว, ไม่งั้นใช้ "ครัว"
      if (kitchensBuilt) continue;
      kitchensBuilt = true;
      const kitchens = packs.has("multi_kitchen") ? normalizeKitchenNames(selection.kitchenNames) : [];
      const names = kitchens.length > 0 ? kitchens : ["ครัว"];
      for (const kitchen of names) result.push(...kitchenTemplates(packs.has("restaurant") ? "restaurant" : "multi_kitchen", kitchen));
      continue;
    }
    result.push(...PACK_BUILDERS[pack.id]());
  }

  const seen = new Set<string>();
  return result
    .filter((entry) => (seen.has(entry.name) ? false : (seen.add(entry.name), true)))
    .map((entry, index) => ({ ...entry, sortOrder: index }));
}

/** ค่าเริ่มต้นจากโปรไฟล์ร้านที่ตั้งตอนสมัคร */
export function suggestPacks(businessMode: string | null | undefined): StorePackId[] {
  if (businessMode === "restaurant") return ["restaurant"];
  if (businessMode === "retail") return ["grocery"];
  return [];
}
