// เรียก Edge Functions ฝั่ง JDC
// JDC ออก key/secret ชุดเดียวทั้งระบบ (เก็บใน platform_settings) → URL + JDC connection key
// (header X-JDC-Connection-Key ตาม contract ฝั่ง JDC) + เซ็น HMAC ด้วย shared webhook secret
// + X-Connect-Event-Id กัน replay (JDC เก็บ event id ที่รับแล้ว). ผูกร้านด้วย merchant_id ใน payload
import { randomUUID } from "node:crypto";
import {
  getJdcApiKey,
  getJdcFunctionsBaseUrl,
  getJdcWebhookSecret,
} from "@/modules/billing/platform-settings";
import { signConnectPayload } from "./hmac";
import type { ChannelLink } from "./repository";
import type { ConnectMenuItemPayload } from "./types";

export interface JdcCallResult {
  ok: boolean;
  status: number;
  body: string;
}

async function callJdc(fnName: string, payload: unknown): Promise<JdcCallResult> {
  const [baseRaw, secret, apiKey] = await Promise.all([
    getJdcFunctionsBaseUrl(),
    getJdcWebhookSecret(),
    getJdcApiKey(),
  ]);
  if (!baseRaw) {
    return { ok: false, status: 0, body: "ยังไม่ได้ตั้งค่า URL ของ JDC Edge Functions (ผู้ดูแลแพลตฟอร์ม)" };
  }
  if (!secret) {
    return { ok: false, status: 0, body: "ยังไม่ได้ตั้งค่า webhook secret ของ JDC (ผู้ดูแลแพลตฟอร์ม)" };
  }
  if (!apiKey) {
    return { ok: false, status: 0, body: "ยังไม่ได้ตั้งค่า JDC connection key (ผู้ดูแลแพลตฟอร์ม)" };
  }
  const base = baseRaw.replace(/\/+$/, "");
  const url = `${base}/${fnName}`;
  const raw = JSON.stringify(payload);
  const signature = signConnectPayload(raw, secret);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    // contract ฝั่ง JDC (connect-auth.ts): ต้องมี connection key + event id + signature + timestamp
    "X-JDC-Connection-Key": apiKey,
    "X-Connect-Event-Id": randomUUID(),
    "X-Connect-Signature": signature,
    "X-Connect-Timestamp": Math.floor(Date.now() / 1000).toString(),
  };
  try {
    const res = await fetch(url, { method: "POST", headers, body: raw });
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
  return callJdc("connect_upsert_menu", {
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
  return callJdc("connect_update_order_status", {
    merchant_id: link.externalMerchantId,
    booking_id: bookingId,
    status: jdcStatus,
  });
}

export function pushShopStatus(link: ChannelLink, isOpen: boolean): Promise<JdcCallResult> {
  return callJdc("connect_set_shop_status", {
    merchant_id: link.externalMerchantId,
    is_open: isOpen,
  });
}
