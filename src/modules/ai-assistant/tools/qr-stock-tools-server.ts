// deps จริงของ tool QR และสต็อก
//
// จุดสำคัญของไฟล์นี้คือ **จำนวนคงเหลือ**: ต้องผ่าน availableVariantStock() ซึ่งคิด
// stock pool ให้แล้ว ไม่ใช่อ่าน stockQuantity ตรง ๆ — ตัวเลขผิดในการ์ดยืนยันแย่กว่า
// ไม่มีการ์ดเลย เพราะคนจะกดยืนยันโดยเชื่อเลขนั้น

import { availableVariantStock, type Product } from "@/modules/catalog/types";
import { listProducts, updateProduct } from "@/modules/catalog/repository";
import { listKitchenStations, assignProductKitchenStation } from "@/modules/qr-ordering/kitchen-stations";
import { getStore, updateStore } from "@/modules/stores/repository";
import { setVariantStock } from "@/modules/stock/repository";
import type { QrToolDeps } from "./qr-tools";
import type { StockToolDeps, StockVariantRef } from "./stock-tools";

async function loadProducts(storeId: string): Promise<readonly Product[]> {
  const result = await listProducts(storeId, { includeInactive: true });
  if (result.error) throw new Error("Assistant catalog unavailable");
  return result.data ?? [];
}

export function createServerQrToolDeps(): QrToolDeps {
  return {
    listProducts: loadProducts,
    async listStations(storeId) {
      const result = await listKitchenStations(storeId);
      if (result.error) throw new Error("Assistant kitchen stations unavailable");
      return (result.data ?? []).map((station) => ({ id: station.id, name: station.name }));
    },
    async setProductQrVisibility(productId, storeId, visible) {
      const result = await updateProduct(productId, storeId, { availableForQr: visible });
      if (result.error) throw new Error("Assistant QR visibility write failed");
    },
    async assignProductStation(productId, storeId, stationId) {
      const result = await assignProductKitchenStation(productId, storeId, stationId);
      if (result.error) throw new Error("Assistant kitchen station assign failed");
    },
    async getStoreQrEnabled(storeId) {
      const result = await getStore(storeId);
      if (result.error || !result.data) throw new Error("Assistant store unavailable");
      return result.data.qrOrderingEnabled === true;
    },
    async setStoreQrEnabled(storeId, enabled) {
      const store = await getStore(storeId);
      if (store.error || !store.data) throw new Error("Assistant store unavailable");
      const result = await updateStore(storeId, store.data.organizationId, { qrOrderingEnabled: enabled });
      if (result.error) throw new Error("Assistant store QR switch write failed");
    },
  };
}

function toVariantRefs(products: readonly Product[], match: (product: Product) => boolean): StockVariantRef[] {
  return products.filter(match).flatMap((product) =>
    product.variants.map((variant) => ({
      variantId: variant.id,
      productId: product.id,
      productName: product.name,
      variantName: variant.name,
      // คิด stock pool แล้ว — undefined = ตัวเลือกนี้ไม่ได้นับสต็อก
      available: availableVariantStock(variant),
      trackStock: variant.trackStock === true,
    })),
  );
}

export function createServerStockToolDeps(): StockToolDeps {
  return {
    async findVariants(storeId, query) {
      const products = await loadProducts(storeId);
      const needle = query.trim().toLowerCase();
      if (!needle) return [];
      const exact = toVariantRefs(products, (product) => product.name.toLowerCase() === needle);
      if (exact.length > 0) return exact;
      return toVariantRefs(products, (product) => product.name.toLowerCase().includes(needle)).slice(0, 12);
    },
    async getVariant(storeId, variantId) {
      const products = await loadProducts(storeId);
      return toVariantRefs(products, () => true).find((variant) => variant.variantId === variantId) ?? null;
    },
    async setVariantStock(variantId, storeId, quantity) {
      const result = await setVariantStock(variantId, storeId, quantity);
      if (!result.ok) throw new Error("Assistant stock write failed");
    },
  };
}
