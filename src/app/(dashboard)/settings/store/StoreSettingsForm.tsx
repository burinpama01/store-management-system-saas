"use client";

import { useActionState, useState } from "react";
import type { Store } from "@/modules/stores/types";
import { ModalDialog } from "@/shared/components/ui";
import { updateStoreAction } from "./actions";

const TIMEZONES = [
  { value: "Asia/Bangkok", label: "Asia/Bangkok (UTC+7)" },
  { value: "Asia/Singapore", label: "Asia/Singapore (UTC+8)" },
  { value: "Asia/Kuala_Lumpur", label: "Asia/Kuala_Lumpur (UTC+8)" },
  { value: "Asia/Jakarta", label: "Asia/Jakarta (UTC+7)" },
  { value: "Asia/Kolkata", label: "Asia/Kolkata (UTC+5:30)" },
  { value: "Asia/Tokyo", label: "Asia/Tokyo (UTC+9)" },
  { value: "UTC", label: "UTC" },
];

const CURRENCIES = [
  { value: "THB", label: "THB — บาท" },
  { value: "USD", label: "USD — ดอลลาร์สหรัฐ" },
  { value: "SGD", label: "SGD — ดอลลาร์สิงคโปร์" },
  { value: "JPY", label: "JPY — เยน" },
  { value: "EUR", label: "EUR — ยูโร" },
  { value: "MYR", label: "MYR — ริงกิต" },
  { value: "IDR", label: "IDR — รูเปียห์" },
];

interface Props {
  store: Store;
  canEdit: boolean;
  canUseQrOrdering: boolean;
  canUseBuffet: boolean;
}

export function StoreSettingsForm({
  store,
  canEdit,
  canUseQrOrdering,
  canUseBuffet,
}: Props) {
  const [storeDialogOpen, setStoreDialogOpen] = useState(false);

  const field = "form-input disabled:bg-[var(--surface-muted)] disabled:text-[var(--muted)]";

  return (
    <div className="page-shell">
      <div className="page-header">
        <div>
          <h1 className="page-title">ตั้งค่าร้าน & ธีม</h1>
          <p className="page-kicker">โปรไฟล์ร้าน สิทธิ์ฟีเจอร์ตามแพ็กเกจ และ tenant-ready storefront settings</p>
        </div>
        <span className="badge badge-brand">Settings</span>
      </div>

      <section className="panel max-w-3xl p-5">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="panel-title">ข้อมูลร้าน</h2>
            <p className="label-muted">ตรวจดูโปรไฟล์ร้านและฟีเจอร์ที่เปิดใช้งาน</p>
          </div>
          {canEdit && (
            <button
              type="button"
              onClick={() => setStoreDialogOpen(true)}
              className="btn-primary"
            >
              แก้ไขข้อมูลร้าน
            </button>
          )}
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <InfoItem label="ชื่อร้านค้า" value={store.name} />
          <InfoItem label="เบอร์โทรศัพท์" value={store.phone ?? "ยังไม่ได้ตั้งค่า"} />
          <InfoItem label="Timezone" value={store.timezone} />
          <InfoItem label="สกุลเงิน" value={store.currencyCode} />
          <InfoItem label="ที่อยู่" value={store.address ?? "ยังไม่ได้ตั้งค่า"} wide />
          <InfoItem
            label="ฟีเจอร์"
            value={[
              store.buffetEnabled && canUseBuffet ? "บุฟเฟต์" : null,
              store.qrOrderingEnabled && canUseQrOrdering ? "QR Ordering" : null,
            ].filter(Boolean).join(", ") || "ยังไม่เปิดฟีเจอร์เสริม"}
            wide
          />
        </div>

        {!canEdit && (
          <p className="mt-4 text-xs text-[var(--muted)]">คุณไม่มีสิทธิ์แก้ไขข้อมูลร้านค้า</p>
        )}
      </section>

      {storeDialogOpen && (
        <StoreSettingsDialog
          store={store}
          canEdit={canEdit}
          canUseQrOrdering={canUseQrOrdering}
          canUseBuffet={canUseBuffet}
          field={field}
          onClose={() => setStoreDialogOpen(false)}
        />
      )}

      <section className="panel max-w-3xl p-5">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <h2 className="panel-title">Theme presets</h2>
            <p className="label-muted">ตัวอย่าง tenant theme จาก prototype สำหรับต่อยอดเป็น theme builder</p>
          </div>
          <span className="badge badge-warning">Preview only</span>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {[
            ["Caramel Cafe", "#c2603a", "#3c8fb0", "#fbede4"],
            ["Matcha Garden", "#5b8c51", "#c2851f", "#ecf3e8"],
            ["Berry Bloom", "#b65c8a", "#7a6bc4", "#fbeaf2"],
          ].map(([name, primary, accent, soft]) => (
            <div key={name} className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-muted)] p-3">
              <div className="mb-3 flex gap-2">
                {[primary, accent, soft].map((color) => (
                  <span key={color} className="h-8 flex-1 rounded-[var(--radius-sm)]" style={{ background: color }} />
                ))}
              </div>
              <p className="text-sm font-extrabold text-[var(--ink)]">{name}</p>
              <p className="text-xs text-[var(--muted)]">Primary {primary}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function StoreSettingsDialog({
  store,
  canEdit,
  canUseQrOrdering,
  canUseBuffet,
  field,
  onClose,
}: Props & {
  field: string;
  onClose: () => void;
}) {
  const [state, formAction, pending] = useActionState(
    async (prev: { error: string | null }, fd: FormData) => {
      const result = await updateStoreAction(prev, fd);
      if (!result.error) onClose();
      return result;
    },
    { error: null },
  );

  return (
    <ModalDialog
      open
      title="แก้ไขข้อมูลร้าน"
      onClose={onClose}
      size="lg"
    >
      <form action={formAction} className="space-y-4">
        <div>
          <label className="field-label">ชื่อร้านค้า *</label>
          <input
            type="text"
            name="name"
            required
            maxLength={100}
            defaultValue={store.name}
            disabled={!canEdit}
            className={field}
          />
        </div>

        <div>
          <label className="field-label">ที่อยู่</label>
          <textarea
            name="address"
            rows={2}
            maxLength={300}
            defaultValue={store.address ?? ""}
            disabled={!canEdit}
            className={field}
          />
        </div>

        <div>
          <label className="field-label">เบอร์โทรศัพท์</label>
          <input
            type="text"
            name="phone"
            maxLength={20}
            defaultValue={store.phone ?? ""}
            disabled={!canEdit}
            className={field}
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="field-label">Timezone</label>
            <select name="timezone" defaultValue={store.timezone} disabled={!canEdit} className={field}>
              {TIMEZONES.map((tz) => (
                <option key={tz.value} value={tz.value}>{tz.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="field-label">สกุลเงิน</label>
            <select name="currencyCode" defaultValue={store.currencyCode} disabled={!canEdit} className={field}>
              {CURRENCIES.map((c) => (
                <option key={c.value} value={c.value}>{c.label}</option>
              ))}
            </select>
          </div>
        </div>

        <input type="hidden" name="locale" value={store.locale} />

        <div className="space-y-2">
          <label className="flex cursor-pointer items-center gap-2 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-muted)] p-3">
            <input
              type="checkbox"
              name="buffetEnabled"
              value="1"
              defaultChecked={store.buffetEnabled && canUseBuffet}
              disabled={!canEdit || !canUseBuffet}
              className="rounded border-gray-300"
            />
            <span className="text-sm font-bold text-[var(--ink-2)]">เปิดใช้งานโหมดบุฟเฟต์</span>
            {!canUseBuffet && (
              <span className="badge badge-warning">
                บุฟเฟต์ถูกจำกัดตามแพ็กเกจ
              </span>
            )}
          </label>
          <label className="flex cursor-pointer items-center gap-2 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-muted)] p-3">
            <input
              type="checkbox"
              name="qrOrderingEnabled"
              value="1"
              defaultChecked={store.qrOrderingEnabled && canUseQrOrdering}
              disabled={!canEdit || !canUseQrOrdering}
              className="rounded border-gray-300"
            />
            <span className="text-sm font-bold text-[var(--ink-2)]">เปิดใช้งาน QR Ordering</span>
            {!canUseQrOrdering && (
              <span className="badge badge-warning">
                QR Ordering ถูกจำกัดตามแพ็กเกจ
              </span>
            )}
          </label>
        </div>

        {state.error && (
          <p className="alert-danger">
            {state.error}
          </p>
        )}

        {canEdit && (
          <button
            type="submit"
            disabled={pending}
            className="btn-primary disabled:opacity-40"
          >
            {pending ? "กำลังบันทึก..." : "บันทึก"}
          </button>
        )}

        {!canEdit && (
          <p className="text-xs text-[var(--muted)]">คุณไม่มีสิทธิ์แก้ไขข้อมูลร้านค้า</p>
        )}
      </form>
    </ModalDialog>
  );
}

function InfoItem({ label, value, wide = false }: { label: string; value: string; wide?: boolean }) {
  return (
    <div className={`rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-muted)] p-3 ${wide ? "sm:col-span-2" : ""}`}>
      <p className="label-muted">{label}</p>
      <p className="mt-1 text-sm font-bold text-[var(--ink-2)]">{value}</p>
    </div>
  );
}
