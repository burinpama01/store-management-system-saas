import type { PricedLine } from "./core";
import type { OnlineMenuProduct } from "./menu";

/** รายการตะกร้าในหน้าสั่ง (รูปเดียวกับ CartItem ใน OrderApp) */
export interface ReorderCartItem {
  key: string;
  productId: string;
  name: string;
  detail: string;
  unitPrice: number;
  variantId: string | null;
  modifierOptionIds: string[];
  quantity: number;
  note: string;
}

export interface ReorderResult {
  cart: ReorderCartItem[];
  /** จำนวนรายการที่ใส่ตะกร้าไม่ได้ (เมนูปิด/หมด/ขนาดหรือตัวเลือกบังคับเปลี่ยน) */
  skipped: number;
}

/**
 * สั่งอีกครั้ง: แปลง snapshot รายการของออเดอร์เดิม → ตะกร้าตามเมนูปัจจุบัน
 * - ราคาใช้ราคาปัจจุบันจากเมนู (server คิดใหม่ตอนสั่งอยู่แล้ว)
 * - เมนู/ขนาดที่ไม่มีแล้ว → ข้าม · ตัวเลือกที่ไม่มีแล้วตัดทิ้ง ถ้ากลุ่มบังคับเลือกไม่ครบ → ข้ามทั้งรายการ
 */
export function buildReorderCart(lines: PricedLine[], menu: OnlineMenuProduct[]): ReorderResult {
  const byId = new Map(menu.map((p) => [p.id, p]));
  const cart: ReorderCartItem[] = [];
  let skipped = 0;
  for (const line of lines) {
    const product = byId.get(line.productId);
    if (!product) {
      skipped += 1;
      continue;
    }
    let variant: OnlineMenuProduct["variants"][number] | null = null;
    if (line.variantId) {
      variant = product.variants.find((v) => v.id === line.variantId) ?? null;
      if (!variant) {
        skipped += 1;
        continue;
      }
    } else if (product.variants.length > 0) {
      // เดิมไม่มีขนาด แต่ตอนนี้เมนูมีให้เลือก — ไม่เดาให้ลูกค้า
      skipped += 1;
      continue;
    }
    const wanted = new Set(line.modifiers.map((m) => m.option.id));
    const options: { id: string; name: string; priceAdjustment: number }[] = [];
    let groupsOk = true;
    for (const g of product.groups) {
      const picked = g.options.filter((o) => wanted.has(o.id)).slice(0, g.selectionType === "single" ? 1 : g.maxSelections);
      if (picked.length < g.minSelections) {
        groupsOk = false;
        break;
      }
      options.push(...picked);
    }
    if (!groupsOk) {
      skipped += 1;
      continue;
    }
    const note = (line.note ?? "").trim().slice(0, 120);
    const sortedIds = options.map((o) => o.id).sort();
    const unitPrice = product.price + (variant?.priceAdjustment ?? 0) + options.reduce((s, o) => s + o.priceAdjustment, 0);
    const key = [product.id, variant?.id ?? "", ...sortedIds, note].join("|");
    const quantity = Math.max(1, Math.min(50, Math.floor(line.quantity)));
    const same = cart.find((c) => c.key === key);
    if (same) {
      same.quantity = Math.min(50, same.quantity + quantity);
      continue;
    }
    cart.push({
      key,
      productId: product.id,
      name: product.name,
      detail: [variant?.name, ...options.map((o) => o.name), note].filter(Boolean).join(" · "),
      unitPrice,
      variantId: variant?.id ?? null,
      modifierOptionIds: sortedIds,
      quantity,
      note,
    });
  }
  return { cart: cart.slice(0, 30), skipped: skipped + Math.max(0, cart.length - 30) };
}
