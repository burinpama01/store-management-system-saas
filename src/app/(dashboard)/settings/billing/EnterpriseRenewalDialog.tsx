"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { ModalDialog } from "@/shared/components/ui/ModalDialog";
import type { BillingOrderView } from "@/modules/billing/beam-billing-types";
import { BeamPackagePayment } from "./BeamPackagePayment";

/**
 * ไดอาล็อกทับหน้าแพ็กเกจเมื่อแพ็กเกจหมดอายุและซุปเปอร์แอดมินตั้งข้อเสนอต่ออายุไว้
 *
 * ขั้นที่ 1 ถามสองทาง: ต่ออายุในราคาที่ตกลง หรือ เปลี่ยนแพ็กเกจ (ปิดไดอาล็อกไปเลือกเอง)
 * ขั้นที่ 2 กดต่ออายุแล้วสร้างรายการ Beam + แสดง QR ในไดอาล็อกเลย — webhook/polling
 * ยืนยันเงินเข้าแล้วต่ออายุอัตโนมัติ ไม่ต้องแนบสลิป
 */
export function EnterpriseRenewalDialog({
  amount,
  summary,
  fallbackEnabled,
  initialOrder,
  lastPaymentFailed = null,
  onChangePackage,
  onClose,
}: {
  amount: number;
  summary: string;
  fallbackEnabled: boolean;
  /** รายการชำระที่ค้างอยู่ — ถ้ามี ข้ามไปขั้นจ่ายเลย เพื่อไม่ให้ร้านจ่ายซ้ำ */
  initialOrder: BillingOrderView | null;
  /** การชำระครั้งล่าสุดไม่สำเร็จ — แจ้งก่อนเป็นหน้าแรก แล้วค่อยให้เลือก */
  lastPaymentFailed?: { planLabel: string; amount: number } | null;
  onChangePackage: () => void;
  onClose: () => void;
}) {
  const [step, setStep] = useState<"failed" | "choose" | "pay">(
    initialOrder ? "pay" : lastPaymentFailed ? "failed" : "choose",
  );
  const [paid, setPaid] = useState(false);
  const handlePaid = useCallback(() => setPaid(true), []);
  const price = amount.toLocaleString("th-TH", { maximumFractionDigits: 2 });
  // รายการค้างของแพ็กเกจอื่น: ห้ามโชว์ QR ในไดอาล็อกนี้ ไม่งั้นร้านสแกนจ่ายแล้วได้แพ็กเกจผิด
  const otherPlanPending = Boolean(initialOrder && initialOrder.plan !== "enterprise");

  return (
    <ModalDialog
      open
      title={paid ? "ต่ออายุสำเร็จ" : step === "failed" ? "รับชำระเงินไม่สำเร็จ" : "แพ็กเกจหมดอายุ"}
      description={
        paid || step === "failed" ? undefined : `ต้องการต่ออายุ Enterprise ในราคา ${price} บาท หรือเปลี่ยนแพ็กเกจ?`
      }
      onClose={onClose}
      size="sm"
    >
      {step === "failed" && lastPaymentFailed ? (
        <div className="space-y-4">
          <div role="alert" className="rounded-[var(--radius-md)] border border-red-200 bg-red-50 p-4 text-sm text-red-700">
            <p className="font-bold">การชำระเงินครั้งก่อนไม่สำเร็จ</p>
            <p className="mt-1">
              รายการ {lastPaymentFailed.planLabel}{" "}
              {lastPaymentFailed.amount.toLocaleString("th-TH", { maximumFractionDigits: 2 })} บาท
              ระบบไม่ได้รับเงิน จึงยังไม่ได้ต่ออายุแพ็กเกจให้
            </p>
          </div>
          <p className="text-sm text-[var(--ink-2)]">
            แพ็กเกจของร้านหมดอายุแล้ว กรุณาเลือกต่ออายุหรือเปลี่ยนแพ็กเกจอีกครั้ง หากถูกตัดเงินไปแล้วโปรดติดต่อผู้ดูแลพร้อมสลิปก่อนชำระซ้ำ
          </p>
          <button type="button" className="btn-primary min-h-11 w-full" onClick={() => setStep("choose")}>
            เลือกการต่ออายุ
          </button>
        </div>
      ) : step === "choose" ? (
        <div className="space-y-4">
          <div className="rounded-[var(--radius-md)] border border-[var(--tenant-primary)] bg-[var(--tenant-primary-soft)] p-4">
            <p className="text-xs font-bold text-[var(--muted)]">ราคาต่ออายุตามข้อตกลง</p>
            <p className="mt-1 text-2xl font-extrabold tabular-nums text-[var(--tenant-primary-strong)]">
              {price} บาท
            </p>
            <p className="mt-1 text-sm text-[var(--ink-2)]">{summary}</p>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <button type="button" className="btn-primary min-h-11" onClick={() => setStep("pay")}>
              ต่ออายุ {price} บาท
            </button>
            <button type="button" className="btn-secondary min-h-11" onClick={onChangePackage}>
              เปลี่ยนแพ็กเกจ
            </button>
          </div>
          <p className="text-xs text-[var(--muted)]">
            ชำระผ่าน QR พร้อมเพย์ของ Beam ระบบยืนยันเงินเข้าและต่ออายุให้อัตโนมัติ ไม่ต้องแนบสลิป
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {otherPlanPending ? (
            <p role="alert" className="rounded-[var(--radius-md)] border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              มีรายการชำระแพ็กเกจอื่นค้างอยู่ จึงยังต่อ Enterprise ไม่ได้ — ดูรายการนั้นได้ที่ &quot;เปลี่ยนแพ็กเกจแทน&quot;
              หากโอนไปแล้วอย่าโอนซ้ำ หรือรอให้รายการหมดเวลาแล้วกลับมาต่ออายุอีกครั้ง
            </p>
          ) : (
            <BeamPackagePayment
              plan="enterprise"
              duration="30d"
              fallbackEnabled={fallbackEnabled}
              initialOrder={initialOrder}
              autoStart
              embedded
              onPaid={handlePaid}
            />
          )}
          {paid ? (
            <div className="flex justify-end gap-2">
              <Link href="/dashboard" className="btn-primary min-h-11 inline-flex items-center">
                เริ่มใช้งานต่อ
              </Link>
            </div>
          ) : (
            <div className="flex flex-wrap justify-between gap-2 border-t border-[var(--border)] pt-3">
              <p className="text-xs text-[var(--muted)]">เปิดหน้านี้ค้างไว้ ระบบจะตรวจผลการชำระให้เอง</p>
              <button type="button" className="btn-secondary min-h-11 text-sm" onClick={onChangePackage}>
                เปลี่ยนแพ็กเกจแทน
              </button>
            </div>
          )}
        </div>
      )}
    </ModalDialog>
  );
}
