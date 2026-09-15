"use client";

import { useActionState, useState, useTransition, type ReactNode } from "react";
import type { GatewayPayment, PaymentProviderConfigPublic } from "@/modules/payments/types";
import type {
  TrueMoneyManualTestResult,
  TrueMoneyOpenApiTestResult,
} from "@/modules/payments/types";
import {
  saveTrueMoneyManualConfigAction,
  disableTrueMoneyManualConfigAction,
  testTrueMoneyManualConnectionAction,
  cancelTrueMoneyPendingAction,
  recordTrueMoneyExternalRefundAction,
  saveTrueMoneyOpenApiConfigAction,
  testTrueMoneyOpenApiConnectionAction,
  disableTrueMoneyOpenApiConfigAction,
} from "./actions";

type InputMode = "emv" | "ewallet";

const PENDING_LIKE = new Set(["CREATED", "PENDING", "REQUIRES_ACTION", "PROCESSING"]);

function statusBadgeClass(status: string): string {
  if (status === "PAID") return "bg-green-100 text-green-800";
  if (status === "CANCELLED" || status === "FAILED" || status === "EXPIRED") {
    return "bg-gray-100 text-gray-600";
  }
  if (status.startsWith("REFUND")) return "bg-purple-100 text-purple-800";
  if (PENDING_LIKE.has(status)) return "bg-amber-100 text-amber-800";
  return "bg-blue-100 text-blue-800";
}

function formatThb(amount: number): string {
  return amount.toLocaleString("th-TH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function shortId(id: string | null): string {
  if (!id) return "—";
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString("th-TH", {
      dateStyle: "short",
      timeStyle: "short",
    });
  } catch {
    return iso;
  }
}

function MerchantGuide() {
  const sections: { title: string; body: ReactNode }[] = [
    {
      title: "1) ภาพรวม BYO — เงินเข้าบัญชีร้านโดยตรง",
      body: (
        <>
          <p>
            ระบบนี้ให้ร้านเชื่อมบัญชีรับเงินของตัวเอง ลูกค้าจ่ายแล้วเงินเข้าวอลเล็ต/บัญชีร้านโดยตรง
            StoreOS ไม่ถือเงินแทนร้าน
          </p>
          <p className="mt-1">
            ต่างจากหน้า &quot;แพ็กเกจ&quot; ที่เป็นค่าสมาชิก StoreOS (Stripe) — คนละเรื่องกันโดยสิ้นเชิง
          </p>
        </>
      ),
    },
    {
      title: "2) โหมด Manual (Shop QR) vs Open API",
      body: (
        <>
          <p>
            <strong>Manual / Shop QR:</strong> POS แสดง QR ล็อกยอด พนักงานเช็คสลิปแล้วกดยืนยันเอง —
            ใช้ได้ทันที ไม่ต้องรอสิทธิ์ Open API
          </p>
          <p className="mt-1">
            <strong>Open API:</strong> แอป TrueMoney ยิง webhook มาที่ StoreOS เมื่อมีเงินเข้า
            ระบบกระทบยอดอัตโนมัติได้เมื่อตั้งค่าครบ — เปิดใช้ได้หลังร้านมีสิทธิ์ในแอป
          </p>
          <p className="mt-1 text-amber-800">
            โหมด Manual จะไม่ถูกแสดงว่า &quot;เชื่อม API แล้ว&quot; แม้จะเปิด Open API ควบคู่กัน
          </p>
        </>
      ),
    },
    {
      title: "3) เงื่อนไขเปิด Open API ในแอป TrueMoney",
      body: (
        <>
          <p>
            โดยทั่วไปต้องมีการรับโอน/เติมเข้าบัญชี TrueMoney มากกว่าประมาณ 50 ครั้งต่อเดือน
            (นับเป็นรายการ ไม่ใช่ยอดบาท) — การโอนจากแอปธนาคารมักนับรวม
            แต่การกดยืนยันรับเงินใน StoreOS ไม่ได้นับเป็นเงื่อนไขของแอป
          </p>
          <p className="mt-1">
            บางแหล่งเคยกล่าวถึงเกณฑ์ 100 ครั้ง — ให้ยึดข้อความในแอป TrueMoney ของร้านคุณเป็นหลัก
            และดูตัวเลขทางการที่แอปแสดง
          </p>
        </>
      ),
    },
    {
      title: "4) หา Webhook / Secret จากไหน",
      body: (
        <>
          <p>
            เปิดแอป TrueMoney → เมนูบริการ Webhook และ API ของทรูมันนี่ (ลิงก์ทางลัดที่รู้จัก:{" "}
            <a
              className="underline"
              href="https://tmn.app.link/PFCCLT"
              target="_blank"
              rel="noreferrer"
            >
              tmn.app.link/PFCCLT
            </a>
            ) → รับการแจ้งเตือนรับเงิน/เติมเงิน → คัดลอก Secret
          </p>
          <p className="mt-1 font-semibold text-red-700">
            Secret ไม่ใช่รหัส PIN 6 หลักของวอลเล็ต — อย่าใส่ PIN ในช่องนี้
          </p>
        </>
      ),
    },
    {
      title: "5) เอา URL จาก StoreOS ไปใส่ตรงไหน",
      body: (
        <p>
          คัดลอก Webhook URL ที่แสดงในแผง TrueMoney Open API ด้านล่าง
          (รูปแบบประมาณ https://โดเมนร้าน/api/payments/webhooks/truemoney?storeId=…)
          แล้วนำไปวางในช่อง URL ตอนตั้งค่า webhook ในแอป TrueMoney
        </p>
      ),
    },
    {
      title: "6) ใส่ Secret ตรงไหนใน StoreOS",
      body: (
        <p>
          วางในช่อง Webhook Secret ของแผง &quot;TrueMoney Open API&quot; → กดทดสอบเชื่อมต่อ →
          บันทึก → เปิดใช้เมื่อร้านพร้อมและมีสิทธิ์ในแอปแล้ว
        </p>
      ),
    },
    {
      title: "7) หลังเชื่อมต่อแล้วใช้ที่ POS ยังไง",
      body: (
        <p>
          โหมด Manual (Shop QR) ยังใช้คู่กันได้สำหรับเคสที่ต้องยืนยันด้วยสลิป
          Open API ช่วยกระทบยอดอัตโนมัติเมื่อ webhook เข้า — อย่าสับสนว่า Manual คือการเชื่อม API
        </p>
      ),
    },
    {
      title: "8) ความปลอดภัย",
      body: (
        <ul className="list-disc space-y-1 pl-4">
          <li>ห้ามแชร์ Webhook Secret ให้ใคร หรือแปะในแชท/สกรีนช็อตสาธารณะ</li>
          <li>URL webhook ในแอปอาจมีอายุ — ถ้าหมดอายุให้สร้างใหม่แล้วอัปเดตใน StoreOS</li>
          <li>ถ้าสงสัยว่า Secret หลุด ให้หมุน Secret ในแอป แล้วบันทึกค่าใหม่ที่นี่ทันที</li>
        </ul>
      ),
    },
    {
      title: "9) แก้ปัญหาเบื้องต้น",
      body: (
        <ul className="list-disc space-y-1 pl-4">
          <li>ยังเลือกเมนู webhook ในแอปไม่ได้ → มักยังไม่ครบเงื่อนไขสิทธิ์ Open API</li>
          <li>
            ทดสอบเชื่อมต่อผ่าน แต่รายการไม่ขึ้น PAID อัตโนมัติ → ตรวจว่ายอดกับออร์เดอร์ pending
            ตรงกัน และร้านเปิดใช้ Open API แล้ว
          </li>
          <li>หน้าแพ็กเกจ / Stripe ล้มเหลว ไม่เกี่ยวกับ TrueMoney ของร้าน</li>
        </ul>
      ),
    },
  ];

  return (
    <div className="panel p-4 space-y-2">
      <p className="text-sm font-semibold text-[var(--color-text-primary)]">
        คู่มือร้าน: เชื่อม TrueMoney รับเงินเข้าบัญชีตัวเอง
      </p>
      <p className="text-xs text-[var(--color-text-muted)]">
        อ่านทีละข้อได้ — กดหัวข้อเพื่อขยาย/ย่อ
      </p>
      <div className="space-y-2">
        {sections.map((s) => (
          <details
            key={s.title}
            className="rounded-lg border border-[var(--border)] bg-white px-3 py-2"
          >
            <summary className="cursor-pointer text-xs font-semibold text-[var(--color-text-primary)]">
              {s.title}
            </summary>
            <div className="mt-2 text-xs leading-relaxed text-[var(--color-text-muted)]">
              {s.body}
            </div>
          </details>
        ))}
      </div>
    </div>
  );
}

export function PaymentIntegrationsManager({
  configs,
  recentPayments = [],
  storeId,
  webhookUrl,
}: {
  configs: PaymentProviderConfigPublic[];
  recentPayments?: GatewayPayment[];
  storeId: string;
  webhookUrl: string;
}) {
  const tm = configs.find((c) => c.providerKey === "truemoney" && c.mode === "manual");
  const tmApi = configs.find((c) => c.providerKey === "truemoney" && c.mode === "open_api");
  const [enabled, setEnabled] = useState(Boolean(tm?.isEnabled && !tm.disabledAt));
  const [inputMode, setInputMode] = useState<InputMode>("ewallet");
  const [displayName, setDisplayName] = useState(tm?.displayName || "TrueMoney Shop QR");
  const [eWalletId, setEWalletId] = useState("");
  const [staticEmvPayload, setStaticEmvPayload] = useState("");
  const [state, formAction, pending] = useActionState(saveTrueMoneyManualConfigAction, {
    error: null as string | null,
    ok: false,
  });
  const [disableError, setDisableError] = useState<string | null>(null);
  const [disabling, setDisabling] = useState(false);
  const [testResult, setTestResult] = useState<TrueMoneyManualTestResult | null>(null);
  const [testing, startTest] = useTransition();
  const [apiEnabled, setApiEnabled] = useState(
    Boolean(tmApi?.isEnabled && !tmApi.disabledAt),
  );
  const [apiDisplayName, setApiDisplayName] = useState(
    tmApi?.displayName || "TrueMoney Open API",
  );
  const [webhookSecret, setWebhookSecret] = useState("");
  const [apiState, apiFormAction, apiPending] = useActionState(
    saveTrueMoneyOpenApiConfigAction,
    { error: null as string | null, ok: false },
  );
  const [apiTestResult, setApiTestResult] = useState<TrueMoneyOpenApiTestResult | null>(null);
  const [apiTesting, startApiTest] = useTransition();
  const [apiDisableError, setApiDisableError] = useState<string | null>(null);
  const [apiDisabling, setApiDisabling] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyBusyId, setHistoryBusyId] = useState<string | null>(null);
  const [historyPending, startHistory] = useTransition();

  async function onDisable() {
    setDisabling(true);
    setDisableError(null);
    const res = await disableTrueMoneyManualConfigAction();
    setDisabling(false);
    if (res.error) setDisableError(res.error);
    else setEnabled(false);
  }

  function onTest() {
    setTestResult(null);
    const fd = new FormData();
    fd.set("inputMode", inputMode);
    fd.set("eWalletId", eWalletId);
    fd.set("staticEmvPayload", staticEmvPayload);
    fd.set("keepExistingPayload", tm?.hasStaticEmvPayload ? "1" : "0");
    startTest(async () => {
      const res = await testTrueMoneyManualConnectionAction(fd);
      setTestResult(res);
    });
  }

  function onApiTest() {
    setApiTestResult(null);
    const fd = new FormData();
    fd.set("webhookSecret", webhookSecret);
    startApiTest(async () => {
      const res = await testTrueMoneyOpenApiConnectionAction(fd);
      setApiTestResult(res);
    });
  }

  async function onApiDisable() {
    setApiDisabling(true);
    setApiDisableError(null);
    const res = await disableTrueMoneyOpenApiConfigAction();
    setApiDisabling(false);
    if (res.error) setApiDisableError(res.error);
    else setApiEnabled(false);
  }

  function copyWebhookUrl() {
    void navigator.clipboard?.writeText(webhookUrl);
  }

  function onCancelPending(payment: GatewayPayment) {
    const reason = window.prompt("เหตุผลที่ยกเลิกรายการนี้ (บังคับ):", "ลูกค้าไม่จ่าย / ทิ้งบิล");
    if (reason == null) return;
    if (reason.trim().length < 2) {
      setHistoryError("กรุณาระบุเหตุผลการยกเลิกอย่างน้อย 2 ตัวอักษร");
      return;
    }
    setHistoryError(null);
    setHistoryBusyId(payment.id);
    startHistory(async () => {
      const res = await cancelTrueMoneyPendingAction(payment.id, reason.trim());
      setHistoryBusyId(null);
      if (res.error) setHistoryError(res.error);
    });
  }

  function onExternalRefund(payment: GatewayPayment) {
    const note = window.prompt(
      "หมายเหตุการคืนเงินภายนอก (บังคับ)\n" +
        "หมายเหตุ: ไม่เรียก API TrueMoney — ใช้เมื่อพนักงานคืนเงินในแอป/วอลเล็ตแล้ว",
      "",
    );
    if (note == null) return;
    if (note.trim().length < 2) {
      setHistoryError("กรุณาระบุหมายเหตุอย่างน้อย 2 ตัวอักษร");
      return;
    }
    setHistoryError(null);
    setHistoryBusyId(payment.id);
    startHistory(async () => {
      const res = await recordTrueMoneyExternalRefundAction(payment.id, note.trim());
      setHistoryBusyId(null);
      if (res.error) setHistoryError(res.error);
    });
  }

  return (
    <div className="space-y-4">
      <div className="panel p-4 space-y-2">
        <h2 className="text-sm font-bold text-[var(--color-text-primary)]">
          ชำระเงินลูกค้า (Payment Gateway)
        </h2>
        <p className="text-xs text-[var(--color-text-muted)]">
          เชื่อมบัญชีรับเงินของร้านเอง — เงินเข้าบัญชีร้านโดยตรง StoreOS ไม่ถือเงินแทน
          ต่างจากหน้า &quot;แพ็กเกจ&quot; ที่เป็นค่าสมาชิก StoreOS
        </p>
      </div>

      <MerchantGuide />

      <div className="panel p-4 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-[var(--color-text-primary)]">
              TrueMoney Shop QR (ยืนยันด้วยพนักงาน)
            </p>
            <p className="mt-1 text-xs text-[var(--color-text-muted)]">
              โหมด Manual — ยังไม่ใช่ API เชื่อมต่ออัตโนมัติ POS จะล็อกยอดจากออร์เดอร์ลง QR
              แล้วให้พนักงานยืนยันหลังลูกค้าสแกนจ่าย
            </p>
            {tm?.hasStaticEmvPayload ? (
              <p className="mt-2 text-xs text-[var(--color-text-muted)]">
                Payload ที่บันทึก:{" "}
                <code className="rounded bg-[var(--surface-muted)] px-1">
                  {tm.staticEmvPayloadMasked}
                </code>
              </p>
            ) : (
              <p className="mt-2 text-xs text-amber-700">ยังไม่ได้บันทึก Shop QR</p>
            )}
          </div>
          <span
            className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${
              enabled ? "bg-green-100 text-green-800" : "bg-gray-100 text-gray-600"
            }`}
          >
            {enabled ? "เปิดใช้" : "ปิดอยู่"}
          </span>
        </div>

        <form action={formAction} className="space-y-3">
          <input type="hidden" name="inputMode" value={inputMode} />
          <input
            type="hidden"
            name="keepExistingPayload"
            value={tm?.hasStaticEmvPayload ? "1" : "0"}
          />

          <label className="block space-y-1">
            <span className="text-xs font-semibold text-[var(--color-text-primary)]">
              ชื่อที่แสดง (ไม่บังคับ)
            </span>
            <input
              type="text"
              name="displayName"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="TrueMoney Shop QR"
              className="w-full rounded-lg border border-[var(--border)] bg-white px-3 py-2 text-sm"
            />
          </label>

          <div className="space-y-2">
            <p className="text-xs font-semibold text-[var(--color-text-primary)]">วิธีตั้งค่า</p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setInputMode("emv")}
                className={`min-h-11 rounded-lg border px-3 text-xs font-semibold ${
                  inputMode === "emv"
                    ? "border-[var(--tenant-primary)] bg-[var(--tenant-primary)] text-white"
                    : "border-gray-300 bg-white text-gray-700"
                }`}
              >
                วาง EMV จาก QR
              </button>
              <button
                type="button"
                onClick={() => setInputMode("ewallet")}
                className={`min-h-11 rounded-lg border px-3 text-xs font-semibold ${
                  inputMode === "ewallet"
                    ? "border-[var(--tenant-primary)] bg-[var(--tenant-primary)] text-white"
                    : "border-gray-300 bg-white text-gray-700"
                }`}
              >
                ระบุ E-Wallet ID เอง
              </button>
            </div>
          </div>

          {inputMode === "ewallet" ? (
            <label className="block space-y-1">
              <span className="text-xs font-semibold text-[var(--color-text-primary)]">
                E-Wallet ID (TrueMoney Shop)
              </span>
              <input
                type="text"
                name="eWalletId"
                value={eWalletId}
                onChange={(e) => setEWalletId(e.target.value)}
                inputMode="numeric"
                autoComplete="off"
                placeholder="140000956879045"
                className="w-full rounded-lg border border-[var(--border)] bg-white px-3 py-2 font-mono text-sm"
              />
              <span className="block text-[11px] text-[var(--color-text-muted)]">
                ใส่เลข E-Wallet / รหัสร้านใน TrueMoney Shop (ตัวเลข 10–20 หลัก)
                ระบบจะสร้าง Shop QR ให้เอง — ไม่ต้องถอดรหัสจากรูป QR
              </span>
            </label>
          ) : (
            <label className="block space-y-1">
              <span className="text-xs font-semibold text-[var(--color-text-primary)]">
                TrueMoney Shop QR (EMV payload)
              </span>
              <textarea
                name="staticEmvPayload"
                rows={3}
                value={staticEmvPayload}
                onChange={(e) => setStaticEmvPayload(e.target.value)}
                placeholder={
                  tm?.hasStaticEmvPayload
                    ? "วาง payload ใหม่เพื่อแทนที่ (เว้นว่างไว้ของเดิม)"
                    : "วางสตริง EMV ที่ถอดจาก QR ร้าน เช่น 00020101021129..."
                }
                className="w-full rounded-lg border border-[var(--border)] bg-white px-3 py-2 font-mono text-xs"
              />
            </label>
          )}

          {inputMode === "ewallet" ? (
            <input type="hidden" name="staticEmvPayload" value="" />
          ) : (
            <input type="hidden" name="eWalletId" value="" />
          )}

          <label className="flex min-h-11 items-center gap-2 text-xs font-semibold">
            <input
              type="checkbox"
              name="isEnabled"
              value="1"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            เปิดใช้ที่ POS (Classic)
          </label>

          {state.error ? (
            <p className="rounded border border-red-200 bg-red-50 px-2 py-1.5 text-xs text-red-700">
              {state.error}
            </p>
          ) : null}
          {state.ok ? (
            <p className="rounded border border-green-200 bg-green-50 px-2 py-1.5 text-xs text-green-700">
              บันทึกแล้ว
            </p>
          ) : null}

          {testResult ? (
            testResult.ok ? (
              <div className="rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-800 space-y-1">
                <p className="font-semibold">ทดสอบเชื่อมต่อสำเร็จ</p>
                <p>{testResult.message}</p>
                <p>
                  โหมด: {testResult.mode} · ผู้ให้บริการ: {testResult.providerKey}
                  {testResult.eWalletIdMasked
                    ? ` · E-Wallet: ${testResult.eWalletIdMasked}`
                    : ""}
                </p>
                <p>
                  ความสามารถ: สร้าง QR ได้ · webhook ไม่มี · lookup ไม่มี · refund ไม่มี ·
                  ยืนยันด้วยพนักงานได้
                </p>
              </div>
            ) : (
              <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                <p className="font-semibold">ทดสอบเชื่อมต่อไม่สำเร็จ</p>
                <p>{testResult.error}</p>
              </div>
            )
          ) : null}

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={testing}
              onClick={onTest}
              className="min-h-11 rounded-lg border border-[var(--tenant-primary)] px-4 text-sm font-semibold text-[var(--tenant-primary)] disabled:opacity-50"
            >
              {testing ? "กำลังทดสอบ..." : "ทดสอบเชื่อมต่อ"}
            </button>
            <button
              type="submit"
              disabled={pending}
              className="min-h-11 rounded-lg bg-[var(--tenant-primary)] px-4 text-sm font-semibold text-white disabled:opacity-50"
            >
              {pending ? "กำลังบันทึก..." : "บันทึก TrueMoney"}
            </button>
            {tm?.hasStaticEmvPayload ? (
              <button
                type="button"
                disabled={disabling}
                onClick={onDisable}
                className="min-h-11 rounded-lg border border-gray-300 px-4 text-sm font-semibold text-gray-700 disabled:opacity-50"
              >
                {disabling ? "กำลังปิด..." : "ปิดใช้งาน"}
              </button>
            ) : null}
          </div>
          {disableError ? <p className="text-xs text-red-700">{disableError}</p> : null}
        </form>

        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          StoreOS ไม่สามารถยืนยันอัตโนมัติว่าเงินเข้าบัญชีแล้วในโหมดนี้ — พนักงานต้องตรวจสอบ
          สลิปโอนเงินจากลูกค้าก่อนกดยืนยันที่ POS (ไม่ใช่การเชื่อม API TrueMoney)
        </div>
      </div>

      <div className="panel p-4 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-[var(--color-text-primary)]">
              TrueMoney Open API (เตรียมไว้ — เปิดเมื่อมีสิทธิ์)
            </p>
            <p className="mt-1 text-xs text-[var(--color-text-muted)]">
              โหมด webhook อัตโนมัติ — ยังไม่เรียก API สร้างรายการชำระจนกว่าร้านจะมีสิทธิ์ในแอป
              และยืนยันเอกสารทางการแล้ว ค่าเริ่มต้นคือปิดใช้
            </p>
            {tmApi?.hasWebhookSecret ? (
              <p className="mt-2 text-xs text-[var(--color-text-muted)]">
                Secret ที่บันทึก:{" "}
                <code className="rounded bg-[var(--surface-muted)] px-1">
                  {tmApi.webhookSecretMasked}
                </code>
              </p>
            ) : (
              <p className="mt-2 text-xs text-amber-700">ยังไม่ได้บันทึก Webhook Secret</p>
            )}
          </div>
          <span
            className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${
              apiEnabled ? "bg-blue-100 text-blue-800" : "bg-gray-100 text-gray-600"
            }`}
          >
            {apiEnabled ? "เปิดใช้ (รอสิทธิ์)" : "ปิดอยู่"}
          </span>
        </div>

        <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2 text-xs space-y-1">
          <p className="font-semibold text-[var(--color-text-primary)]">Webhook URL สำหรับแอป TrueMoney</p>
          <code className="block break-all text-[11px]">{webhookUrl}</code>
          <button
            type="button"
            onClick={copyWebhookUrl}
            className="min-h-9 rounded border border-gray-300 bg-white px-2 text-[11px] font-semibold"
          >
            คัดลอก URL
          </button>
          <p className="text-[var(--color-text-muted)]">
            storeId ใน URL ({storeId.slice(0, 8)}…) เป็นตัวระบุร้านชั่วคราวจนกว่าเอกสารทางการจะระบุวิธีจับคู่ร้าน
          </p>
        </div>

        <form action={apiFormAction} className="space-y-3">
          <input
            type="hidden"
            name="keepExistingSecret"
            value={tmApi?.hasWebhookSecret ? "1" : "0"}
          />
          <label className="block space-y-1">
            <span className="text-xs font-semibold">ชื่อที่แสดง (ไม่บังคับ)</span>
            <input
              type="text"
              name="displayName"
              value={apiDisplayName}
              onChange={(e) => setApiDisplayName(e.target.value)}
              className="w-full rounded-lg border border-[var(--border)] bg-white px-3 py-2 text-sm"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-xs font-semibold">Webhook Secret จากแอป TrueMoney</span>
            <input
              type="password"
              name="webhookSecret"
              value={webhookSecret}
              onChange={(e) => setWebhookSecret(e.target.value)}
              autoComplete="off"
              placeholder={
                tmApi?.hasWebhookSecret
                  ? "เว้นว่างเพื่อใช้ Secret เดิม"
                  : "วาง Secret (ไม่ใช่ PIN 6 หลัก)"
              }
              className="w-full rounded-lg border border-[var(--border)] bg-white px-3 py-2 font-mono text-sm"
            />
          </label>
          <label className="flex min-h-11 items-center gap-2 text-xs font-semibold">
            <input
              type="checkbox"
              name="isEnabled"
              value="1"
              checked={apiEnabled}
              onChange={(e) => setApiEnabled(e.target.checked)}
            />
            เปิดใช้ Open API เมื่อร้านมีสิทธิ์แล้ว (ค่าเริ่มต้นแนะนำ: ปิด)
          </label>

          {apiState.error ? (
            <p className="rounded border border-red-200 bg-red-50 px-2 py-1.5 text-xs text-red-700">
              {apiState.error}
            </p>
          ) : null}
          {apiState.ok ? (
            <p className="rounded border border-green-200 bg-green-50 px-2 py-1.5 text-xs text-green-700">
              บันทึก Open API แล้ว
            </p>
          ) : null}

          {apiTestResult ? (
            apiTestResult.ok ? (
              <div className="rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-800 space-y-1">
                <p className="font-semibold">ทดสอบ Secret สำเร็จ (scaffold)</p>
                <p>{apiTestResult.message}</p>
                <p>Secret: {apiTestResult.webhookSecretMasked}</p>
                <p className="break-all">URL: {apiTestResult.webhookUrl}</p>
              </div>
            ) : (
              <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                <p className="font-semibold">ทดสอบไม่สำเร็จ</p>
                <p>{apiTestResult.error}</p>
              </div>
            )
          ) : null}

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={apiTesting}
              onClick={onApiTest}
              className="min-h-11 rounded-lg border border-[var(--tenant-primary)] px-4 text-sm font-semibold text-[var(--tenant-primary)] disabled:opacity-50"
            >
              {apiTesting ? "กำลังทดสอบ..." : "ทดสอบเชื่อมต่อ"}
            </button>
            <button
              type="submit"
              disabled={apiPending}
              className="min-h-11 rounded-lg bg-[var(--tenant-primary)] px-4 text-sm font-semibold text-white disabled:opacity-50"
            >
              {apiPending ? "กำลังบันทึก..." : "บันทึก Open API"}
            </button>
            {tmApi?.hasWebhookSecret ? (
              <button
                type="button"
                disabled={apiDisabling}
                onClick={onApiDisable}
                className="min-h-11 rounded-lg border border-gray-300 px-4 text-sm font-semibold text-gray-700 disabled:opacity-50"
              >
                {apiDisabling ? "กำลังปิด..." : "ปิดใช้งาน"}
              </button>
            ) : null}
          </div>
          {apiDisableError ? <p className="text-xs text-red-700">{apiDisableError}</p> : null}
        </form>

        <div className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900">
          เอกสารทางการของ endpoint/JWT ต้องยืนยันจากคู่มือในแอป TrueMoney เมื่อมีสิทธิ์ —
          StoreOS ยังไม่เรียก API สร้างรายการชำระในขั้นตอนนี้
        </div>
      </div>

      <div className="panel p-4 space-y-3">
        <div>
          <p className="text-sm font-semibold text-[var(--color-text-primary)]">
            ประวัติ TrueMoney (manual)
          </p>
          <p className="mt-1 text-xs text-[var(--color-text-muted)]">
            กระทบยอดด้วยมือ — ยกเลิกรายการค้าง หรือบันทึกว่าคืนเงินในแอป TrueMoney แล้ว
            (Phase A ไม่เรียก Open API)
          </p>
        </div>

        {historyError ? (
          <p className="rounded border border-red-200 bg-red-50 px-2 py-1.5 text-xs text-red-700">
            {historyError}
          </p>
        ) : null}

        {recentPayments.length === 0 ? (
          <p className="rounded-lg border border-dashed border-gray-200 bg-[var(--surface-muted)] px-3 py-6 text-center text-xs text-[var(--color-text-muted)]">
            ยังไม่มีรายการ TrueMoney ในร้านนี้
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-xs">
              <thead>
                <tr className="border-b border-[var(--border)] text-[var(--color-text-muted)]">
                  <th className="px-2 py-2 font-semibold">เวลา</th>
                  <th className="px-2 py-2 font-semibold">ยอด (บาท)</th>
                  <th className="px-2 py-2 font-semibold">สถานะ</th>
                  <th className="px-2 py-2 font-semibold">ออร์เดอร์</th>
                  <th className="px-2 py-2 font-semibold">หมายเหตุ</th>
                  <th className="px-2 py-2 font-semibold">จัดการ</th>
                </tr>
              </thead>
              <tbody>
                {recentPayments.map((p) => {
                  const externalNote =
                    p.metadata &&
                    typeof p.metadata === "object" &&
                    p.metadata.externalRefund &&
                    typeof (p.metadata.externalRefund as { note?: unknown }).note === "string"
                      ? String((p.metadata.externalRefund as { note: string }).note)
                      : "";
                  const noteSnippet =
                    p.confirmReason?.trim() || p.failureMessage?.trim() || externalNote || "—";
                  const busy = historyPending && historyBusyId === p.id;
                  return (
                    <tr key={p.id} className="border-b border-[var(--border)] last:border-0">
                      <td className="whitespace-nowrap px-2 py-2 text-[var(--color-text-muted)]">
                        {formatTime(p.createdAt)}
                      </td>
                      <td className="whitespace-nowrap px-2 py-2 font-mono font-semibold">
                        {formatThb(p.amount)}
                      </td>
                      <td className="px-2 py-2">
                        <span
                          className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${statusBadgeClass(
                            p.status,
                          )}`}
                        >
                          {p.status}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-2 py-2 font-mono text-[var(--color-text-muted)]">
                        {shortId(p.orderId)}
                      </td>
                      <td className="max-w-[12rem] truncate px-2 py-2 text-[var(--color-text-muted)]" title={noteSnippet}>
                        {noteSnippet}
                      </td>
                      <td className="px-2 py-2">
                        <div className="flex flex-wrap gap-1">
                          {PENDING_LIKE.has(p.status) ? (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => onCancelPending(p)}
                              className="min-h-9 rounded border border-gray-300 px-2 text-[11px] font-semibold text-gray-700 disabled:opacity-50"
                            >
                              {busy ? "..." : "ยกเลิก"}
                            </button>
                          ) : null}
                          {p.status === "PAID" ? (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => onExternalRefund(p)}
                              className="min-h-9 rounded border border-purple-300 px-2 text-[11px] font-semibold text-purple-800 disabled:opacity-50"
                              title="ไม่เรียก API TrueMoney — บันทึกว่าคืนเงินในแอปแล้ว"
                            >
                              {busy ? "..." : "บันทึกคืนเงินภายนอก"}
                            </button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
