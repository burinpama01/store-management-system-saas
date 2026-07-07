"use client";

import { useActionState, useState } from "react";
import {
  createChannelLinkAction,
  setCommissionAction,
  setShopStatusAction,
  syncMenuNowAction,
  updateLinkAction,
  type ConnectActionState,
} from "./actions";

interface LinkVM {
  id: string;
  channel: string;
  externalMerchantId: string;
  status: "active" | "paused" | "disconnected";
  autoAccept: boolean;
  commissionRate: number;
  storeId: string;
}

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

function CommissionForm({ linkId, current }: { linkId: string; current: number }) {
  const [state, formAction, pending] = useActionState(setCommissionAction, INITIAL);
  return (
    <form action={formAction} className="flex items-end gap-2">
      <input type="hidden" name="linkId" value={linkId} />
      <div>
        <label className="block text-xs text-gray-500 mb-1">%GP ที่ JDC หัก (คิดยอดสุทธิที่ร้านได้รับ)</label>
        <input
          name="commissionRate"
          type="number"
          min="0"
          max="100"
          step="0.5"
          defaultValue={current}
          className="w-28 rounded border border-gray-300 px-2 py-1 text-sm"
        />
      </div>
      <button
        type="submit"
        disabled={pending}
        className="rounded bg-gray-700 px-3 py-1.5 text-xs text-white hover:bg-gray-800 disabled:opacity-40"
      >
        {pending ? "..." : "บันทึก GP"}
      </button>
      {state.error && <span className="text-red-600 text-[11px]">{state.error}</span>}
      {state.ok && state.message && <span className="text-green-700 text-[11px]">{state.message}</span>}
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

      <div className="border-t border-gray-100 pt-2">
        <CommissionForm linkId={link.id} current={link.commissionRate} />
      </div>

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

export function ConnectManager({
  links,
  deliveryProductCount,
  featureEnabled,
  jdcConfigured,
}: {
  links: LinkVM[];
  deliveryProductCount: number;
  featureEnabled: boolean;
  jdcConfigured: boolean;
}) {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-gray-900">StoreOS Connect — เชื่อมเดลิเวอรี (JDC)</h1>
        <p className="text-sm text-gray-500">
          ตั้งค่าการเชื่อมร้านกับ JDC · ดูออเดอร์เดลิเวอรีที่เมนู “เดลิเวอรี”
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
    </div>
  );
}
