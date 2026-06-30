// เรียก Edge Functions ฝั่ง JDC (เซ็น HMAC ด้วย webhook_secret ของ link)
// base URL เป็น config ระดับแพลตฟอร์ม (super-admin ตั้งที่ /system/settings) ไม่ใช่ต่อร้าน
import { getJdcFunctionsBaseUrl } from "@/modules/billing/platform-settings";
import { signConnectPayload } from "./hmac";
import type { ChannelLink } from "./repository";
import type { ConnectMenuItemPayload } from "./types";

export interface JdcCallResult {
  ok: boolean;
  status: number;
  body: string;
}

async function callJdc(
  link: ChannelLink,
  fnName: string,
  payload: unknown,
): Promise<JdcCallResult> {
  const baseRaw = await getJdcFunctionsBaseUrl();
  if (!baseRaw) {
    return { ok: false, status: 0, body: "ยังไม่ได้ตั้งค่า URL ของ JDC Edge Functions (ติดต่อผู้ดูแลแพลตฟอร์ม)" };
  }
  const base = baseRaw.replace(/\/+$/, "");
  const url = `${base}/${fnName}`;
  const raw = JSON.stringify(payload);
  const signature = signConnectPayload(raw, link.webhookSecret);
  const ts = Math.floor(Date.now() / 1000).toString();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Connect-Signature": signature,
        "X-Connect-Timestamp": ts,
      },
      body: raw,
    });
    const body = await res.text();
    return { ok: res.ok, status: res.status, body };
  } catch (e) {
    return { ok: false, status: 0, body: e instanceof Error ? e.message : "network error" };
  }
}

export function pushMenuUpsert(
  link: ChannelLink,
  items: ConnectMenuItemPayload[],
  fullSync: boolean,
): Promise<JdcCallResult> {
  return callJdc(link, "connect_upsert_menu", {
    merchant_id: link.externalMerchantId,
    items,
    full_sync: fullSync,
  });
}

export function pushOrderStatus(
  link: ChannelLink,
  bookingId: string,
  jdcStatus: string,
): Promise<JdcCallResult> {
  return callJdc(link, "connect_update_order_status", {
    booking_id: bookingId,
    status: jdcStatus,
  });
}

export function pushShopStatus(link: ChannelLink, isOpen: boolean): Promise<JdcCallResult> {
  return callJdc(link, "connect_set_shop_status", {
    merchant_id: link.externalMerchantId,
    is_open: isOpen,
  });
}
