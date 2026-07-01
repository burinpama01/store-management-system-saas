// ฟังก์ชันบริสุทธิ์สำหรับสร้าง payload เมนู + คำนวณ sync hash (แยกจาก DB เพื่อทดสอบง่าย)
import { createHash } from "node:crypto";
import type { ConnectMenuItemPayload } from "./types";

export interface ProductForDelivery {
  id: string;
  name: string;
  description: string | null;
  image_url: string | null;
  base_price: number;
  delivery_price: number | null;
  is_active: boolean;
  available_for_delivery: boolean;
  delivery_out_of_stock: boolean;
}

/** ราคาเดลิเวอรี = delivery_price ถ้าตั้งไว้ ไม่งั้นใช้ base_price */
export function resolveDeliveryPrice(p: Pick<ProductForDelivery, "base_price" | "delivery_price">): number {
  return p.delivery_price != null ? p.delivery_price : p.base_price;
}

/** สร้าง payload เมนู 1 รายการสำหรับส่งไป JDC */
export function buildMenuItemPayload(
  product: ProductForDelivery,
  categoryName: string | null,
): ConnectMenuItemPayload {
  return {
    external_ref: product.id,
    name: product.name,
    description: product.description,
    price: resolveDeliveryPrice(product),
    image_url: product.image_url,
    is_available: product.is_active && !product.delivery_out_of_stock, // ร้านกดของหมด → false
    category: categoryName,
    preparation_time: null,
  };
}

/** hash เสถียรของ payload (กันดันซ้ำเมื่อข้อมูลไม่เปลี่ยน) */
export function computeMenuSyncHash(payload: ConnectMenuItemPayload): string {
  const stable = JSON.stringify([
    payload.external_ref,
    payload.name,
    payload.description ?? "",
    payload.price,
    payload.image_url ?? "",
    payload.is_available,
    payload.category ?? "",
    payload.preparation_time ?? "",
  ]);
  return createHash("sha256").update(stable, "utf8").digest("hex").slice(0, 32);
}
