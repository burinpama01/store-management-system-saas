// บริการ sync เมนู StoreOS → JDC (Flow 1): สร้าง payload, diff ด้วย sync_hash, push, อัปเดต map
import { pushMenuUpsert } from "./jdc-client";
import { buildMenuItemPayload, computeMenuSyncHash } from "./menu-payload";
import {
  getDeliveryProducts,
  getMenuMapForLink,
  recordEvent,
  upsertMenuMap,
  type ChannelLink,
} from "./repository";
import type { ConnectMenuItemPayload } from "./types";

export interface MenuSyncResult {
  ok: boolean;
  total: number;
  pushed: number;
  skipped: number;
  error?: string;
}

/**
 * @param fullSync true = ส่งทุกเมนู (initial load / reconcile) + ให้ JDC ปิด is_available เมนูที่หายไป
 *                 false = ส่งเฉพาะที่ hash เปลี่ยน
 */
export async function syncMenuForLink(
  link: ChannelLink,
  fullSync: boolean,
): Promise<MenuSyncResult> {
  const products = await getDeliveryProducts(link.storeId);
  const existing = await getMenuMapForLink(link.id);

  const toPush: { productId: string; payload: ConnectMenuItemPayload; hash: string }[] = [];
  let skipped = 0;
  for (const p of products) {
    const payload = buildMenuItemPayload(p, p.categoryName);
    const hash = computeMenuSyncHash(payload);
    const prev = existing.get(p.id);
    if (!fullSync && prev && prev.syncHash === hash) {
      skipped++;
      continue;
    }
    toPush.push({ productId: p.id, payload, hash });
  }

  if (toPush.length === 0) {
    return { ok: true, total: products.length, pushed: 0, skipped };
  }

  const res = await pushMenuUpsert(link, toPush.map((t) => t.payload), fullSync);
  await recordEvent({
    linkId: link.id,
    direction: "outbound",
    topic: "menu.upsert",
    payload: { count: toPush.length, fullSync },
    status: res.ok ? "sent" : "failed",
    lastError: res.ok ? null : `HTTP ${res.status}: ${res.body.slice(0, 300)}`,
  });

  if (!res.ok) {
    return {
      ok: false,
      total: products.length,
      pushed: 0,
      skipped,
      error: `ส่งเมนูไป JDC ไม่สำเร็จ (HTTP ${res.status})`,
    };
  }

  const now = new Date().toISOString();
  for (const t of toPush) {
    await upsertMenuMap(link.id, t.productId, {
      syncHash: t.hash,
      lastSyncedAt: now,
      lastError: null,
    });
  }
  return { ok: true, total: products.length, pushed: toPush.length, skipped };
}
