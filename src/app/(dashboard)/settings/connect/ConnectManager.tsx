"use client";

import { useActionState, useState } from "react";
import {
  createChannelLinkAction,
  setShopStatusAction,
  syncMenuNowAction,
  updateDeliveryOrderStatusAction,
  updateLinkAction,
  type ConnectActionState,
} from "./actions";

type FulfillmentStatus =
  | "received"
  | "accepted"
  | "preparing"
  | "ready"
  | "completed"
  | "cancelled";

interface LinkVM {
  id: string;
  channel: string;
  externalMerchantId: string;
  status: "active" | "paused" | "disconnected";
  autoAccept: boolean;
  storeId: string;
}

interface OrderVM {
  id: string;
  externalOrderId: string;
  fulfillmentStatus: FulfillmentStatus;
  lastStatusOrigin: string | null;
  orderNumber: string | null;
  total: number | null;
  receivedAt: string;
}

const STATUS_LABEL: Record<FulfillmentStatus, string> = {
  received: "รับเข้าใหม่",
  accepted: "รับออเดอร์แล้ว",
  preparing: "กำลังทำ",
  ready: "พร้อมรับ",
  completed: "เสร็จสิ้น",
  cancelled: "ยกเลิก",
};

const NEXT_ACTIONS: Record<FulfillmentStatus, { next: FulfillmentStatus; label: string; danger?: boolean }[]> = {
  received: [
    { next: "accepted", label: "รับออเดอร์" },
    { next: "cancelled", label: "ยกเลิก", danger: true },
  ],
  accepted: [{ next: "preparing", label: "กำลังทำ" }],
  preparing: [{ next: "ready", label: "พร้อมรับ" }],
  ready: [], // พร้อมรับแล้ว — คนขับเข้ารับ, JDC ปิดงานเอง (in_transit → completed)
  completed: [],
  cancelled: [],
};

const INITIAL: ConnectActionState = { error: null };

type ServerAction = (s: ConnectActionState, f: FormData) => Promise<ConnectActionState>;

/** ปุ่มที่ส่ง server action พร้อม hidden fields + แสดง error/สถานะ inline */
function ActionButton({
  action,
  fields,
  children,
  className,
}: {
  action: ServerAction;
  fields: Record<string, string>;
  children: React.ReactNode;
  className: string;
}) {
  const [state, formAction, pending] = useActionState(action, INITIAL);
  return (
    <form action={formAction} className="inline-flex flex-col">
      {Object.entries(fields).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <button type="submit" disabled={pending} className={className}>
        {pending ? "..." : children}
      </button>
      {state.error && <span className="text-red-600 text-[11px] mt-1">{state.error}</span>}
      {state.ok && state.message && (
        <span className="text-green-700 text-[11px] mt-1">{state.message}</span>
      )}
    </form>
  );
}

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <label className="block text-xs text-gray-500 mb-1">{label}</label>
      <div className="flex gap-2">
        <input
          readOnly
          value={value}
          className="flex-1 rounded border border-gray-200 bg-gray-50 px-2 py-1 text-xs font-mono"
        />
        <button
          type="button"
          onClick={() => {
            navigator.clipboard?.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          className="rounded bg-gray-700 px-2 py-1 text-xs text-white hover:bg-gray-800"
        >
          {copied ? "คัดลอกแล้ว" : "คัดลอก"}
        </button>
      </div>
    </div>
  );
}

function CreateLinkForm() {
  const [state, formAction, pending] = useActionState(createChannelLinkAction, INITIAL);
  return (
    <form action={formAction} className="grid gap-3 max-w-lg">
      <div>
        <label className="block text-xs text-gray-500 mb-1">merchant_id ของร้านฝั่ง JDC</label>
        <input
          name="merchantId"
          required
          placeholder="เช่น 8f3a1c2e-..."
          className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
        />
      </div>
      <label className="flex items-center gap-2 cursor-pointer">
        <input type="checkbox" name="autoAccept" value="1" />
        <span className="text-sm text-gray-700">รับออเดอร์อัตโนมัติ (ไม่ต้องกดรับที่ POS)</span>
      </label>
      {state.error && (
        <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">
          {state.error}
        </div>
      )}
      {state.ok && state.message && (
        <div className="text-sm text-green-700 bg-green-50 border border-green-200 rounded px-3 py-2">
          {state.message}
        </div>
      )}
      <button
        type="submit"
        disabled={pending}
        className="justify-self-start px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded disabled:opacity-40"
      >
        {pending ? "กำลังเชื่อม..." : "เชื่อมช่องทาง JDC"}
      </button>
    </form>
  );
}

function LinkCard({ link, deliveryProductCount }: { link: LinkVM; deliveryProductCount: number }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <span className="text-sm font-semibold text-gray-900">ช่องทาง: {link.channel.toUpperCase()}</span>
          <span
            className={`ml-2 rounded px-2 py-0.5 text-xs ${
              link.status === "active"
                ? "bg-green-100 text-green-700"
                : "bg-gray-200 text-gray-600"
            }`}
          >
            {link.status === "active" ? "ใช้งาน" : link.status === "paused" ? "พัก" : "ตัดการเชื่อม"}
          </span>
        </div>
        <span className="text-xs text-gray-400">เมนูเดลิเวอรี {deliveryProductCount} รายการ</span>
      </div>

      <div className="grid gap-2">
        <CopyField label="merchant_id (JDC) ของร้านนี้" value={link.externalMerchantId} />
      </div>
      <p className="text-xs text-gray-400">
        การเชื่อมระบบ (Webhook URL, JDC key, webhook secret) ตั้งครั้งเดียวโดยผู้ดูแลแพลตฟอร์ม —
        ร้านค้ามีหน้าที่แค่ใส่ merchant_id ของร้านในแอป JDC
      </p>

      <div className="flex flex-wrap gap-2 pt-2 border-t border-gray-100">
        <ActionButton
          action={syncMenuNowAction}
          fields={{ linkId: link.id }}
          className="rounded bg-blue-600 px-3 py-1.5 text-xs text-white hover:bg-blue-700"
        >
          Sync เมนูทั้งหมด
        </ActionButton>
        <ActionButton
          action={setShopStatusAction}
          fields={{ linkId: link.id, isOpen: "1" }}
          className="rounded bg-green-600 px-3 py-1.5 text-xs text-white hover:bg-green-700"
        >
          เปิดรับ JDC
        </ActionButton>
        <ActionButton
          action={setShopStatusAction}
          fields={{ linkId: link.id, isOpen: "0" }}
          className="rounded bg-gray-500 px-3 py-1.5 text-xs text-white hover:bg-gray-600"
        >
          ปิดรับ JDC
        </ActionButton>
        <ActionButton
          action={updateLinkAction}
          fields={{ linkId: link.id, intent: link.autoAccept ? "autoaccept_off" : "autoaccept_on" }}
          className="rounded border border-gray-300 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50"
        >
          {link.autoAccept ? "ปิด auto-accept" : "เปิด auto-accept"}
        </ActionButton>
        <ActionButton
          action={updateLinkAction}
          fields={{ linkId: link.id, intent: link.status === "active" ? "pause" : "resume" }}
          className="rounded border border-gray-300 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50"
        >
          {link.status === "active" ? "พักการเชื่อม" : "เปิดใช้งาน"}
        </ActionButton>
      </div>
    </div>
  );
}

function OrderRow({ order, canManage }: { order: OrderVM; canManage: boolean }) {
  const actions = NEXT_ACTIONS[order.fulfillmentStatus];
  return (
    <div className="flex items-center justify-between rounded border border-gray-200 px-3 py-2">
      <div>
        <span className="text-sm font-medium text-gray-900">
          {order.orderNumber ?? `#${order.externalOrderId.slice(0, 8)}`}
        </span>
        {order.total != null && <span className="ml-2 text-xs text-gray-500">฿{order.total}</span>}
        <span className="ml-2 rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600">
          {STATUS_LABEL[order.fulfillmentStatus]}
        </span>
        {order.lastStatusOrigin && (
          <span className="ml-1 text-[10px] text-gray-400">({order.lastStatusOrigin})</span>
        )}
      </div>
      {canManage && actions.length > 0 && (
        <div className="flex gap-2">
          {actions.map((a) => (
            <ActionButton
              key={a.next}
              action={updateDeliveryOrderStatusAction}
              fields={{ connectOrderId: order.id, next: a.next }}
              className={`rounded px-3 py-1 text-xs text-white ${
                a.danger ? "bg-red-500 hover:bg-red-600" : "bg-blue-600 hover:bg-blue-700"
              }`}
            >
              {a.label}
            </ActionButton>
          ))}
        </div>
      )}
    </div>
  );
}

export function ConnectManager({
  links,
  orders,
  deliveryProductCount,
  featureEnabled,
  jdcConfigured,
  canManageOrders,
}: {
  links: LinkVM[];
  orders: OrderVM[];
  deliveryProductCount: number;
  featureEnabled: boolean;
  jdcConfigured: boolean;
  canManageOrders: boolean;
}) {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-gray-900">StoreOS Connect — เชื่อมเดลิเวอรี (JDC)</h1>
        <p className="text-sm text-gray-500">
          ดันเมนูขึ้น JDC · รับออเดอร์เข้า POS · sync สถานะสองทาง · เปิด-ปิดร้าน
        </p>
      </div>

      {!featureEnabled && (
        <div className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded px-3 py-2">
          ฟีเจอร์นี้ต้องใช้แพ็กเกจ Enterprise (API Integration) — การ sync/ส่งข้อมูลจะถูกปฏิเสธจนกว่าจะอัปเกรด
        </div>
      )}
      {!jdcConfigured && (
        <div className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded px-3 py-2">
          ผู้ดูแลแพลตฟอร์มยังไม่ได้ตั้งค่า JDC (URL / webhook secret) — การส่งเมนู/สถานะไป JDC และการรับ webhook จะยังไม่ทำงานจนกว่าจะตั้งที่ตั้งค่าระบบส่วนกลาง
        </div>
      )}

      {links.length === 0 ? (
        <section className="rounded-lg border border-gray-200 bg-white p-4">
          <h2 className="text-sm font-semibold text-gray-900 mb-1">เชื่อมร้านกับ JDC</h2>
          <p className="text-xs text-gray-500 mb-3">
            ขอ merchant_id จากหน้าตั้งค่าในแอป JDC แล้วนำมากรอกที่นี่ (ผูกด้วยมือ)
          </p>
          <CreateLinkForm />
        </section>
      ) : (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-gray-900">ช่องทางที่เชื่อม</h2>
          {links.map((l) => (
            <LinkCard key={l.id} link={l} deliveryProductCount={deliveryProductCount} />
          ))}
        </section>
      )}

      <section className="rounded-lg border border-gray-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-gray-900 mb-3">
          ออเดอร์เดลิเวอรีล่าสุด ({orders.length})
        </h2>
        {orders.length === 0 ? (
          <p className="text-xs text-gray-400">ยังไม่มีออเดอร์จาก JDC</p>
        ) : (
          <div className="space-y-2">
            {orders.map((o) => (
              <OrderRow key={o.id} order={o} canManage={canManageOrders} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
