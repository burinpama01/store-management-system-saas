"use client";

import { useActionState, useState } from "react";
import { RECEIPT_MESSAGE_MAX_LENGTH } from "@/modules/settings/receipt-limits";
import type { ReceiptSettings } from "@/modules/settings/repository";
import { ModalDialog, Button } from "@/shared/components/ui";
import { ImageUpload } from "@/shared/components/ui/ImageUpload";
import { upsertReceiptSettingsAction } from "./actions";

interface Props {
  settings: ReceiptSettings | null;
  storeName: string;
  canEdit: boolean;
  organizationId: string;
  storeId: string;
}

export function ReceiptSettingsForm({ settings, storeName, canEdit, organizationId, storeId }: Props) {
  const [receiptDialogOpen, setReceiptDialogOpen] = useState(false);

  const field =
    "w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:bg-gray-50 disabled:text-gray-500";

  return (
    <div className="max-w-lg">
      <section className="rounded-lg border border-gray-200 bg-white p-4">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-gray-900">ตั้งค่าใบเสร็จ</h2>
            <p className="mt-1 text-xs text-gray-500">ดูค่าปัจจุบันและเปิด dialog เพื่อแก้ไข</p>
          </div>
          {canEdit && (
            <button
              type="button"
              onClick={() => setReceiptDialogOpen(true)}
              className="rounded bg-blue-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700"
            >
              แก้ไขตั้งค่าใบเสร็จ
            </button>
          )}
        </div>

        <div className="grid gap-3">
          <ReceiptInfo label="ชื่อร้านในใบเสร็จ" value={settings?.storeName ?? storeName} />
          <ReceiptInfo label="เบอร์โทรศัพท์" value={settings?.phone ?? "ยังไม่ได้ตั้งค่า"} />
          <ReceiptInfo label="เลขประจำตัวผู้เสียภาษี" value={settings?.taxId ?? "ยังไม่ได้ตั้งค่า"} />
          <ReceiptInfo label="QR PromptPay" value={settings?.showQrPayment ? "แสดงในใบเสร็จ" : "ไม่แสดง"} />
          <ReceiptInfo label="กระดาษ / สำเนา" value={`${settings?.paperWidth ?? "80mm"} / ${settings?.printCopies ?? 1} ชุด`} />
        </div>

        {!canEdit && (
          <p className="mt-4 text-xs text-gray-400">คุณไม่มีสิทธิ์แก้ไขตั้งค่าใบเสร็จ</p>
        )}
      </section>

      {receiptDialogOpen && (
        <ReceiptSettingsDialog
          settings={settings}
          storeName={storeName}
          canEdit={canEdit}
          organizationId={organizationId}
          storeId={storeId}
          field={field}
          onClose={() => setReceiptDialogOpen(false)}
        />
      )}
    </div>
  );
}

function ReceiptSettingsDialog({
  settings,
  storeName,
  canEdit,
  organizationId,
  storeId,
  field,
  onClose,
}: Props & {
  field: string;
  onClose: () => void;
}) {
  const [state, formAction, pending] = useActionState(
    async (prev: { error: string | null }, fd: FormData) => {
      const result = await upsertReceiptSettingsAction(prev, fd);
      if (!result.error) onClose();
      return result;
    },
    { error: null },
  );
  const [showQrPayment, setShowQrPayment] = useState(settings?.showQrPayment ?? false);

  return (
    <ModalDialog
      open
      title="แก้ไขตั้งค่าใบเสร็จ"
      onClose={onClose}
      size="lg"
    >
      <form action={formAction} className="space-y-4">
          <div>
            <label className="block text-xs text-gray-500 mb-1">ชื่อร้านในใบเสร็จ *</label>
            <input
              type="text"
              name="storeName"
              required
              maxLength={100}
              defaultValue={settings?.storeName ?? storeName}
              disabled={!canEdit}
              className={field}
            />
          </div>

          <div>
            <label className="block text-xs text-gray-500 mb-1">ที่อยู่ในใบเสร็จ</label>
            <textarea
              name="address"
              rows={2}
              maxLength={300}
              defaultValue={settings?.address ?? ""}
              disabled={!canEdit}
              className={field}
            />
          </div>

          <div>
            <label className="block text-xs text-gray-500 mb-1">เบอร์โทรศัพท์</label>
            <input
              type="text"
              name="phone"
              maxLength={20}
              defaultValue={settings?.phone ?? ""}
              disabled={!canEdit}
              className={field}
            />
          </div>

          <div>
            <label className="block text-xs text-gray-500 mb-1">เลขประจำตัวผู้เสียภาษี</label>
            <input
              type="text"
              name="taxId"
              maxLength={20}
              defaultValue={settings?.taxId ?? ""}
              disabled={!canEdit}
              className={field}
            />
          </div>

          <div className="space-y-2">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                name="showTaxId"
                value="1"
                defaultChecked={settings?.showTaxId ?? false}
                disabled={!canEdit}
              />
              <span className="text-sm text-gray-700">แสดงเลขประจำตัวผู้เสียภาษีในใบเสร็จ</span>
            </label>

            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                name="showQrPayment"
                value="1"
                checked={showQrPayment}
                disabled={!canEdit}
                onChange={(e) => setShowQrPayment(e.target.checked)}
              />
              <span className="text-sm text-gray-700">แสดง QR PromptPay ในใบเสร็จ</span>
            </label>

            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                name="autoPrintReceipt"
                value="1"
                defaultChecked={settings?.autoPrintReceipt ?? false}
                disabled={!canEdit}
              />
              <span className="text-sm text-gray-700">พิมพ์ใบเสร็จอัตโนมัติเมื่อชำระเงินสำเร็จ</span>
            </label>

            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                name="autoPrintStationTickets"
                value="1"
                defaultChecked={settings?.autoPrintStationTickets ?? false}
                disabled={!canEdit}
              />
              <span className="text-sm text-gray-700">
                พิมพ์ตั๋วครัว/บาร์อัตโนมัติเมื่อมีออร์เดอร์เข้า (แยกตามเครื่องพิมพ์ของแต่ละสถานี)
              </span>
            </label>
          </div>

          <div>
            <label className="block text-xs text-gray-500 mb-1">หมายเลข PromptPay</label>
            <input
              type="text"
              name="promptpayId"
              maxLength={20}
              defaultValue={settings?.promptpayId ?? ""}
              disabled={!canEdit}
              placeholder="เบอร์มือถือหรือเลขบัตรประชาชน"
              className={field}
            />
          </div>

          {canEdit && (
            <ImageUpload
              name="logoUrl"
              label="โลโก้หัวใบเสร็จ (พิมพ์เป็นรูปบนสุด)"
              defaultValue={settings?.logoUrl}
              organizationId={organizationId}
              storeId={storeId}
            />
          )}

          <div>
            <label className="block text-xs text-gray-500 mb-1">ข้อความส่วนหัว</label>
            <textarea
              name="headerText"
              rows={4}
              maxLength={RECEIPT_MESSAGE_MAX_LENGTH}
              defaultValue={settings?.headerText ?? ""}
              disabled={!canEdit}
              className={field}
            />
          </div>

          <div>
            <label className="block text-xs text-gray-500 mb-1">ข้อความส่วนท้าย</label>
            <textarea
              name="footerText"
              rows={4}
              maxLength={RECEIPT_MESSAGE_MAX_LENGTH}
              defaultValue={settings?.footerText ?? ""}
              disabled={!canEdit}
              className={field}
            />
          </div>

          {canEdit && (
            <ImageUpload
              name="footerImageUrl"
              label="รูปท้ายใบเสร็จ เช่น QR LINE / พร้อมเพย์ (พิมพ์เป็นรูปล่างสุด)"
              defaultValue={settings?.footerImageUrl}
              organizationId={organizationId}
              storeId={storeId}
            />
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-gray-500 mb-1">ความกว้างกระดาษ</label>
              <select name="paperWidth" defaultValue={settings?.paperWidth ?? "80mm"} disabled={!canEdit} className={field}>
                <option value="58mm">58mm</option>
                <option value="80mm">80mm</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">จำนวนสำเนา</label>
              <input
                type="number"
                name="printCopies"
                min="1"
                max="5"
                defaultValue={settings?.printCopies ?? 1}
                disabled={!canEdit}
                className={field}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 items-end">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                name="showVatBreakdown"
                value="1"
                defaultChecked={settings?.showVatBreakdown ?? false}
                disabled={!canEdit}
              />
              <span className="text-sm text-gray-700">แสดงบรรทัดแยกมูลค่าสินค้า/VAT (VAT รวมในราคาแล้ว)</span>
            </label>
            <div>
              <label className="block text-xs text-gray-500 mb-1">อัตรา VAT (%)</label>
              <input
                type="number"
                name="vatRate"
                min="0"
                max="100"
                step="0.01"
                defaultValue={settings?.vatRate ?? 7}
                disabled={!canEdit}
                className={field}
              />
            </div>
          </div>

          {state.error && (
            <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">
              {state.error}
            </p>
          )}

          {canEdit && (
            <Button
              type="submit"
              loading={pending}
              loadingText="กำลังบันทึก..."
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded disabled:opacity-40 transition-colors"
            >
              บันทึก
            </Button>
          )}

          {!canEdit && (
            <p className="text-xs text-gray-400">คุณไม่มีสิทธิ์แก้ไขตั้งค่าใบเสร็จ</p>
          )}
      </form>
    </ModalDialog>
  );
}

function ReceiptInfo({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-gray-200 bg-gray-50 p-3">
      <p className="text-xs text-gray-500">{label}</p>
      <p className="mt-1 text-sm font-medium text-gray-800">{value}</p>
    </div>
  );
}
