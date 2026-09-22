// ตัวแปลคำสั่งของผู้ช่วยหลังร้าน — ข้อความ/เสียง → tool หลังร้าน
//
// ## ทำไมต้องมีไฟล์นี้
// ก่อนหน้านี้แผงหลังร้านส่งข้อความเข้า orchestrator ของหน้าขาย ซึ่งรู้จักแค่ `pos.*`
// ⇒ "เพิ่มเมนูอาหารต้ม" ถูกตีเป็น "เพิ่มสินค้าลงตะกร้า" แล้วล้มเพราะไม่มีตะกร้า
// (ออกมาเป็น CONTEXT_UNAVAILABLE = "เซสชันหมดอายุ" ซึ่งไม่เกี่ยวอะไรเลย)
//
// ## เส้นแบ่งที่ต้องชัด
// หลังร้าน "เพิ่มเมนู X" = **เพิ่มรายการใหม่เข้าระบบ** ไม่ใช่เพิ่มลงตะกร้า
// การเพิ่มลงตะกร้าเป็นงานของหน้า POS — คำสั่งแนวนั้นต้องถูกตีกลับพร้อมบอกให้ไปสั่งที่ POS
// ไม่ใช่เงียบหรือเดาไปทำอย่างอื่น
//
// ## เป็น deterministic ล้วน ไม่เรียก AI
// คำสั่งหลังร้านมีรูปประโยคจำกัดและเป็นเรื่องข้อมูลจริงของร้าน — กติกาที่อ่านออกด้วยตา
// เชื่อถือได้กว่าและไม่มีค่า inference ต่อคำสั่ง ถ้าแปลไม่ได้ต้องตอบว่าไม่รองรับ
// ไม่ใช่ส่งต่อให้โมเดลเดา

/** ผลของการแปล — สามทางเท่านั้น ไม่มีทาง "เดาแล้วลองดู" */
export type BackOfficeIntent =
  | { readonly kind: "tool"; readonly tool: string; readonly args: Record<string, unknown> }
  /** เป็นคำสั่งหน้าขาย ไม่ใช่งานหลังร้าน — บอกให้ไปสั่งที่ POS */
  | { readonly kind: "pos_command"; readonly hint: string }
  | { readonly kind: "unsupported" };

const norm = (value: string) => value.trim().replace(/\s+/g, " ");

/** ตัวเลขอาจมาพร้อมจุลภาคจากตัวถอดเสียง ("1,200") */
function readNumber(raw: string | undefined): number | null {
  if (!raw) return null;
  const value = Number(raw.replace(/,/g, ""));
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/** ตัดคำลงท้ายที่ไม่ใช่ชื่อจริงของสินค้าออก ("...หน่อย", "...ให้ที") */
function cleanName(raw: string): string {
  return norm(raw)
    .replace(/(ให้)?(หน่อย|ที|ด้วย|ครับ|ค่ะ|คะ)\s*$/u, "")
    .replace(/^(ชื่อ|ว่า)\s*/u, "")
    .trim();
}

/**
 * หน่วยนับที่บอกว่าเป็นคำสั่งขายหน้าร้าน ("ลาเต้ 2 แก้ว")
 *
 * ใช้แยก "เพิ่มลาเต้ 2 แก้ว" (ตะกร้า) ออกจาก "เพิ่มเมนูลาเต้" (แคตตาล็อก) — คำว่า
 * เมนู/สินค้า เป็นตัวชี้ฝั่งแคตตาล็อก ส่วนหน่วยนับเป็นตัวชี้ฝั่งตะกร้า
 */
const CART_UNIT = /\d+\s*(แก้ว|ที่|จาน|ชิ้น|ขวด|ถ้วย|กล่อง|ถุง)/u;
const CART_VERB = /^(คิดเงิน|เช็คบิล|ชำระเงิน|เปิดโต๊ะ|ปิดบิล|ลบออก|เอาออก|ล้างตะกร้า)/u;

const POS_HINT = "คำสั่งขายหน้าร้าน (ตะกร้า/คิดเงิน) ต้องสั่งที่หน้า POS — ผู้ช่วยนี้ใช้จัดการข้อมูลหลังร้าน";

export function parseBackOfficeCommand(input: string): BackOfficeIntent {
  const text = norm(input);
  if (!text) return { kind: "unsupported" };

  // ── งานหน้าขายที่หลุดมา: ตีกลับพร้อมบอกทางที่ถูก ────────────────────────────
  if (CART_VERB.test(text)) return { kind: "pos_command", hint: POS_HINT };

  // ── เปิด/ปิด QR ทั้งร้าน ────────────────────────────────────────────────────
  const qr = /(เปิด|ปิด)\s*(?:การสั่ง)?\s*(?:qr|คิวอาร์)\s*(?:order|ออเดอร์)?\s*(ทุกเมนู|ทั้งหมด|ทุกรายการ)?/iu.exec(text);
  if (qr) {
    return { kind: "tool", tool: "qr.bulk_set_visibility", args: { scope: "all", visible: qr[1] === "เปิด" } };
  }

  // ── สต็อก: "ปรับสต็อกข้าวผัดเป็น 25" / "สต็อกข้าวผัดเหลือ 25" ────────────────
  const stock = /(?:ปรับ|ตั้ง|แก้|เปลี่ยน)?\s*(?:สต็อก|สต๊อก|สตอก)\s*(.+?)\s*(?:เป็น|เหลือ|=)?\s*(\d[\d,]*)\s*$/u.exec(text);
  if (stock) {
    const quantity = readNumber(stock[2]);
    const product = cleanName(stock[1]);
    if (quantity !== null && product) {
      return { kind: "tool", tool: "stock.adjust", args: { product, quantity } };
    }
  }

  // ── ราคา: "แก้ราคาอเมริกาโน่เย็นเป็น 60" ────────────────────────────────────
  const price = /(?:แก้|เปลี่ยน|ตั้ง|ปรับ)\s*ราคา\s*(.+?)\s*(?:เป็น|=|ราคา)?\s*(\d[\d,]*)\s*(?:บาท)?\s*$/u.exec(text);
  if (price) {
    const value = readNumber(price[2]);
    const product = cleanName(price[1]);
    if (value !== null && value > 0 && product) {
      return { kind: "tool", tool: "catalog.update_price", args: { product, price: value } };
    }
  }

  // ── ของหมด / กลับมามีขาย / ซ่อน / แสดง ─────────────────────────────────────
  const soldOut = /^(.+?)\s*(?:สินค้า)?หมด(?:แล้ว|วันนี้)?\s*$/u.exec(text);
  if (soldOut) {
    const product = cleanName(soldOut[1].replace(/^(ของ|เมนู|สินค้า)\s*/u, ""));
    if (product) return { kind: "tool", tool: "catalog.set_availability", args: { product, state: "out_of_stock" } };
  }
  const backInStock = /^(.+?)\s*(?:กลับ)?มี(?:ขาย|แล้ว|ของ)(?:แล้ว)?\s*$/u.exec(text);
  if (backInStock) {
    const product = cleanName(backInStock[1].replace(/^(ของ|เมนู|สินค้า)\s*/u, ""));
    if (product) return { kind: "tool", tool: "catalog.set_availability", args: { product, state: "back_in_stock" } };
  }
  const hide = /^(?:ซ่อน|ปิดขาย)\s*(?:เมนู|สินค้า)?\s*(.+)$/u.exec(text);
  if (hide) {
    const product = cleanName(hide[1]);
    if (product) return { kind: "tool", tool: "catalog.set_availability", args: { product, state: "hide" } };
  }
  const show = /^(?:แสดง|เปิดขาย)\s*(?:เมนู|สินค้า)?\s*(.+)$/u.exec(text);
  if (show) {
    const product = cleanName(show[1]);
    if (product) return { kind: "tool", tool: "catalog.set_availability", args: { product, state: "show" } };
  }

  // ── เพิ่มเมนูใหม่เข้าระบบ (ไม่ใช่เพิ่มลงตะกร้า) ──────────────────────────────
  // ต้องมีคำว่า เมนู/สินค้า/รายการ เป็นตัวชี้ ไม่งั้น "เพิ่มลาเต้ 2 แก้ว" จะถูกดูดมาผิดฝั่ง
  const create = /^(?:เพิ่ม|สร้าง|ลง)\s*(?:เมนู|สินค้า|รายการ)\s*(?:ใหม่)?\s*(.+)$/u.exec(text);
  if (create) {
    const rest = create[1];
    const priced = /^(.+?)\s*(?:ราคา)\s*(\d[\d,]*)\s*(?:บาท)?\s*$/u.exec(rest);
    const name = cleanName(priced ? priced[1] : rest);
    const value = priced ? readNumber(priced[2]) : null;
    if (name) {
      return {
        kind: "tool",
        tool: "catalog.create_product",
        args: value !== null ? { name, price: value } : { name },
      };
    }
  }

  // ── บัญชี: รายรับ / รายจ่าย ────────────────────────────────────────────────
  // จับตัวเลขท้ายประโยคเป็นยอดเสมอ ("ลงค่าน้ำแข็ง 450")
  const money = /^(.*?)\s*(\d[\d,]*)\s*(?:บาท)?\s*$/u.exec(text);
  if (money) {
    const amount = readNumber(money[2]);
    let head = norm(money[1]);
    const income = /(รายรับ|รายได้|เงินเข้า)/u.test(head);
    const expenseWord = /(รายจ่าย|ค่าใช้จ่าย|จ่าย|ซื้อ|ลง|บันทึก|เงินออก)/u.test(head);
    if (amount !== null && amount > 0 && (income || expenseWord)) {
      head = head
        .replace(/^(ลง|บันทึก|เพิ่ม|ใส่)\s*/u, "")
        .replace(/^(รายรับ|รายได้|เงินเข้า|รายจ่าย|ค่าใช้จ่าย|เงินออก)\s*(อื่น|อื่นๆ|อื่น ๆ)?\s*/u, "")
        .replace(/^(ค่า)\s+/u, "ค่า");
      const note = cleanName(head);
      if (note) {
        return {
          kind: "tool",
          tool: "accounting.create_transaction",
          args: { type: income ? "income" : "expense", amount, note },
        };
      }
    }
    // มีตัวเลข + หน่วยนับขายของ = คำสั่งตะกร้า ไม่ใช่งานหลังร้าน
    if (CART_UNIT.test(text)) return { kind: "pos_command", hint: POS_HINT };
  }

  if (CART_UNIT.test(text)) return { kind: "pos_command", hint: POS_HINT };
  return { kind: "unsupported" };
}
