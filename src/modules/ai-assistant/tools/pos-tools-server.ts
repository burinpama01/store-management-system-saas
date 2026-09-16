// PR2 — composition root ของ POS tools ฝั่ง server: โหลด catalog/alias จาก repository เดิม
// ที่หน้าขายและ Voice POS ใช้ (ชุดเดียวกัน) — ไฟล์นี้ import supabase ผ่าน repository เท่านั้น
// ห้ามให้ business tools (pos-tools.ts) import มาที่นี่

import { listProducts } from "@/modules/catalog/repository";
import { listVoiceAliases } from "@/modules/voice-pos/alias-repository";
import type { PosToolDeps, PosToolCatalog } from "./pos-tools";

export function createServerPosToolDeps(): PosToolDeps {
  return {
    async loadCatalog(storeId: string): Promise<PosToolCatalog> {
      const [productsResult, aliasesResult] = await Promise.all([
        listProducts(storeId, { includeInactive: false }),
        listVoiceAliases(storeId),
      ]);
      if (productsResult.error) throw new Error("Assistant catalog unavailable");
      const aliases = (aliasesResult.data ?? [])
        .filter((alias) => alias.isActive && alias.intentType === "product" && typeof alias.slots.product_id === "string")
        .map((alias) => ({ aliasText: alias.aliasText, productId: alias.slots.product_id as string }));
      return { products: productsResult.data ?? [], aliases };
    },
  };
}
