// deps จริงของ tool เมนู — ใช้ resolver ชุดเดียวกับหน้าขาย
//
// สำคัญที่ต้องเป็นชุดเดียวกัน: ร้านสอน alias ไว้ว่า "อเม" = Iced Americano ผ่านหน้าขาย
// ถ้า tool หลังร้านใช้ตัวหาเมนูคนละตัว พนักงานจะเจอว่าคำเดียวกันใช้ได้ที่หนึ่งแต่ไม่ได้
// อีกที่หนึ่ง ซึ่งอธิบายไม่ได้เลยจากมุมคนหน้าร้าน

import { createProduct, getProduct, listCategories, listProducts, updateProduct } from "@/modules/catalog/repository";
import { listVoiceAliases } from "@/modules/voice-pos/alias-repository";
import { resolveVoiceProductPhrase } from "@/modules/voice-pos/cart";
import type { CatalogToolDeps } from "./catalog-tools";

export function createServerCatalogToolDeps(): CatalogToolDeps {
  return {
    async resolveProduct(storeId, query) {
      const [products, aliasRows] = await Promise.all([
        listProducts(storeId, { includeInactive: true }),
        listVoiceAliases(storeId),
      ]);
      if (products.error) throw new Error("Assistant catalog unavailable");
      const aliases = (aliasRows.data ?? [])
        .filter((alias) => alias.isActive && alias.intentType === "product" && typeof alias.slots.product_id === "string")
        .map((alias) => ({ aliasText: alias.aliasText, productId: alias.slots.product_id as string }));
      const resolution = resolveVoiceProductPhrase(query, products.data ?? [], aliases);
      if (resolution.status === "not_found") return { status: "not_found" };
      if (resolution.status === "ambiguous") {
        return {
          status: "ambiguous",
          candidates: resolution.candidates.slice(0, 8).map((product) => ({ id: product.id, name: product.name })),
        };
      }
      return { status: "found", product: resolution.selection.product };
    },
    async getProduct(productId, storeId) {
      const result = await getProduct(productId);
      // getProduct ไม่กรองร้าน — ตรวจซ้ำที่นี่ กัน id ของร้านอื่นถูกยื่นมาทาง answers
      if (result.error || !result.data || result.data.storeId !== storeId) return null;
      return result.data;
    },
    async listCategories(storeId) {
      const result = await listCategories(storeId);
      if (result.error) throw new Error("Assistant categories unavailable");
      return (result.data ?? []).map((category) => ({ id: category.id, name: category.name }));
    },
    async updateProduct(productId, storeId, patch) {
      const result = await updateProduct(productId, storeId, patch);
      if (result.error) throw new Error("Assistant catalog write failed");
    },
    async createProduct(input) {
      // สร้างเป็นเมนูขายหน้าร้านก่อนเสมอ ไม่เปิด QR ให้เอง — การเปิด QR ต้องผูกสถานีครัว
      // ซึ่งเป็นการตัดสินใจของคน สั่งแยกทีหลังได้ด้วย "เปิด QR ทุกเมนู"
      const result = await createProduct({
        storeId: input.storeId,
        organizationId: input.organizationId,
        categoryId: input.categoryId,
        name: input.name,
        basePrice: input.basePrice,
        availableForPos: true,
        availableForQr: false,
      });
      if (result.error || !result.data) throw new Error("Assistant catalog create failed");
      return { id: result.data.id };
    },
  };
}
