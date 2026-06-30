"use client";

import { useActionState, useState } from "react";
import type { Store } from "@/modules/stores/types";
import {
  CUSTOM_THEME_PRESET_ID,
  THEME_PRESETS,
  getThemePreset,
  type ThemeTokens,
} from "@/modules/theme/presets";
import { ModalDialog, Button } from "@/shared/components/ui";
import { uploadStoreImageAction } from "@/modules/storage/image-actions";
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

const CUSTOM_THEME_FIELDS: Array<{
  key: keyof Omit<ThemeTokens, "presetId">;
  label: string;
}> = [
  { key: "primaryColor", label: "Primary" },
  { key: "primaryStrongColor", label: "Primary strong" },
  { key: "primarySoftColor", label: "Primary soft" },
  { key: "accentColor", label: "Accent" },
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
  const currentTheme = getThemePreset(store.themePresetId);
  const currentThemeName = store.themePresetId === CUSTOM_THEME_PRESET_ID ? "Custom" : currentTheme.name;
  const currentColors = [
    store.themePrimaryColor,
    store.themePrimaryStrongColor,
    store.themePrimarySoftColor,
    store.themeAccentColor,
  ];

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
            <p className="label-muted">ธีมของร้านนี้จะถูกใช้เฉพาะ tenant/store ปัจจุบัน</p>
          </div>
          <span className="badge badge-brand">{currentThemeName}</span>
        </div>
        <div className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-muted)] p-3">
          <div className="mb-3 flex gap-2">
            {currentColors.map((color) => (
              <span key={color} className="h-9 flex-1 rounded-[var(--radius-sm)]" style={{ background: color }} />
            ))}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-extrabold text-[var(--ink)]">{currentThemeName}</p>
            {canEdit && (
              <button type="button" onClick={() => setStoreDialogOpen(true)} className="btn-secondary text-xs">
                แก้ไขธีม
              </button>
            )}
          </div>
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
  const [themePresetId, setThemePresetId] = useState(store.themePresetId);
  const [logoUrl, setLogoUrl] = useState(store.logoUrl ?? "");
  const [logoUploading, setLogoUploading] = useState(false);
  const [logoErr, setLogoErr] = useState<string | null>(null);
  const [customTheme, setCustomTheme] = useState<Omit<ThemeTokens, "presetId">>({
    primaryColor: store.themePrimaryColor,
    primaryStrongColor: store.themePrimaryStrongColor,
    primarySoftColor: store.themePrimarySoftColor,
    accentColor: store.themeAccentColor,
  });
  const [state, formAction, pending] = useActionState(
    async (prev: { error: string | null }, fd: FormData) => {
      const result = await updateStoreAction(prev, fd);
      if (!result.error) onClose();
      return result;
    },
    { error: null },
  );
  const selectedPreset = getThemePreset(themePresetId);
  const isCustomTheme = themePresetId === CUSTOM_THEME_PRESET_ID;
  const themeColors = isCustomTheme
    ? customTheme
    : {
        primaryColor: selectedPreset.colors.primary,
        primaryStrongColor: selectedPreset.colors.primaryStrong,
        primarySoftColor: selectedPreset.colors.primarySoft,
        accentColor: selectedPreset.colors.accent,
      };

  return (
    <ModalDialog
      open
      title="แก้ไขข้อมูลร้าน"
      onClose={onClose}
      size="lg"
    >
      <form action={formAction} className="space-y-4">
        <input type="hidden" name="logoUrl" value={logoUrl} />
        <div>
          <label className="field-label">โลโก้ร้าน (Avatar)</label>
          <div className="flex items-center gap-3">
            {logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={logoUrl} alt="" className="h-14 w-14 rounded-xl border border-[var(--border)] bg-white object-cover" />
            ) : (
              <span className="flex h-14 w-14 items-center justify-center rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] text-xl font-bold text-[var(--muted)]">
                {store.name?.[0]?.toUpperCase() ?? "S"}
              </span>
            )}
            {canEdit && (
              <div className="flex flex-col gap-1">
                <label className="block">
                  <span className="btn-secondary inline-flex min-h-9 cursor-pointer items-center px-3 text-sm">
                    {logoUploading ? "กำลังอัปโหลด..." : "เลือกรูปโลโก้"}
                  </span>
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    disabled={logoUploading}
                    onChange={async (e) => {
                      const f = e.target.files?.[0];
                      if (!f) return;
                      setLogoErr(null);
                      setLogoUploading(true);
                      const fd = new FormData();
                      fd.set("file", f);
                      const res = await uploadStoreImageAction(fd);
                      setLogoUploading(false);
                      if (res.error || !res.url) setLogoErr(res.error ?? "อัปโหลดไม่สำเร็จ");
                      else setLogoUrl(res.url);
                    }}
                  />
                </label>
                {logoUrl && (
                  <button type="button" onClick={() => setLogoUrl("")} className="text-left text-xs text-[var(--muted)]">
                    ลบโลโก้
                  </button>
                )}
              </div>
            )}
          </div>
          {logoErr && <p className="alert-danger mt-2">{logoErr}</p>}
        </div>
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
        <input type="hidden" name="themePresetId" value={themePresetId} />
        <input type="hidden" name="themePrimaryColor" value={themeColors.primaryColor} />
        <input type="hidden" name="themePrimaryStrongColor" value={themeColors.primaryStrongColor} />
        <input type="hidden" name="themePrimarySoftColor" value={themeColors.primarySoftColor} />
        <input type="hidden" name="themeAccentColor" value={themeColors.accentColor} />

        <div className="space-y-3 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-muted)] p-3">
          <div>
            <label className="field-label">Theme presets</label>
            <div className="grid gap-2 sm:grid-cols-2">
              {THEME_PRESETS.map((preset) => {
                const active = themePresetId === preset.id;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    aria-pressed={active}
                    disabled={!canEdit}
                    onClick={() => setThemePresetId(preset.id)}
                    className={`rounded-[var(--radius-md)] border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                      active
                        ? "border-[var(--tenant-primary)] bg-white"
                        : "border-[var(--border)] bg-[var(--surface)] hover:border-[var(--tenant-primary)]"
                    }`}
                  >
                    <span className="mb-2 flex gap-1.5">
                      {[preset.colors.primary, preset.colors.primaryStrong, preset.colors.primarySoft, preset.colors.accent].map((color) => (
                        <span key={color} className="h-6 flex-1 rounded-[var(--radius-sm)]" style={{ background: color }} />
                      ))}
                    </span>
                    <span className="block text-sm font-extrabold text-[var(--ink)]">{preset.name}</span>
                    <span className="block text-xs text-[var(--muted)]">{preset.description}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            {CUSTOM_THEME_FIELDS.map((item) => (
              <div key={item.key}>
                <label className="field-label">{item.label}</label>
                <div className="flex gap-2">
                  <input
                    type="color"
                    value={themeColors[item.key]}
                    disabled={!canEdit || !isCustomTheme}
                    onChange={(event) =>
                      setCustomTheme((prev) => ({
                        ...prev,
                        [item.key]: event.target.value,
                      }))
                    }
                    className="h-11 w-14 shrink-0 rounded-[var(--radius-md)] border border-[var(--border)] bg-white p-1 disabled:opacity-40"
                  />
                  <input
                    type="text"
                    value={themeColors[item.key]}
                    disabled={!canEdit || !isCustomTheme}
                    maxLength={7}
                    pattern="^#[0-9A-Fa-f]{6}$"
                    onChange={(event) =>
                      setCustomTheme((prev) => ({
                        ...prev,
                        [item.key]: event.target.value,
                      }))
                    }
                    className={field}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>

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

        <div className="max-w-xs">
          <label className="field-label" htmlFor="dineInDurationMinutes">
            ระยะเวลา QR เปิดโต๊ะทั่วไป (นาที)
          </label>
          <input
            id="dineInDurationMinutes"
            type="number"
            name="dineInDurationMinutes"
            min={15}
            max={600}
            defaultValue={store.dineInDurationMinutes}
            disabled={!canEdit}
            className="w-full rounded-[var(--radius-md)] border border-[var(--border)] px-3 py-2 text-sm"
          />
          <p className="mt-1 text-xs text-[var(--muted)]">
            ลูกค้าสแกน QR ในใบเปิดโต๊ะ à la carte แล้วสั่งอาหารได้ภายในเวลานี้ (บุฟเฟต์ใช้เวลาจากแพ็กเกจ)
          </p>
        </div>

        <div className="max-w-xs">
          <label className="field-label" htmlFor="qrOrderingMode">
            รูปแบบ QR ของโต๊ะ
          </label>
          <select
            id="qrOrderingMode"
            name="qrOrderingMode"
            defaultValue={store.qrOrderingMode}
            disabled={!canEdit || !canUseQrOrdering}
            className="w-full rounded-[var(--radius-md)] border border-[var(--border)] px-3 py-2 text-sm"
          >
            <option value="table_bound">ผูกโต๊ะถาวร (QR เดิมใช้ได้ตลอด)</option>
            <option value="session_printed">พิมพ์ใหม่ทุกครั้งที่เปิดโต๊ะ (หมดอายุหลังเช็คบิล)</option>
          </select>
          <p className="mt-1 text-xs text-[var(--muted)]">
            แบบ “พิมพ์ใหม่” QR จะมีรหัสรอบโต๊ะติดมาด้วย เมื่อปิดโต๊ะ/เช็คบิล QR เดิมจะหมดอายุทันที
          </p>
        </div>

        <div className="max-w-xs">
          <label className="field-label" htmlFor="tableOpenPolicy">
            การเปิดโต๊ะ
          </label>
          <select
            id="tableOpenPolicy"
            name="tableOpenPolicy"
            defaultValue={store.tableOpenPolicy}
            disabled={!canEdit || !canUseQrOrdering}
            className="w-full rounded-[var(--radius-md)] border border-[var(--border)] px-3 py-2 text-sm"
          >
            <option value="staff_only">พนักงานเปิดโต๊ะก่อน (ค่าเริ่มต้น)</option>
            <option value="customer_self">ลูกค้าเปิดโต๊ะเองตอนสั่งออเดอร์แรก</option>
          </select>
          <p className="mt-1 text-xs text-[var(--muted)]">
            “ลูกค้าเปิดเอง” ใช้ได้เฉพาะ QR แบบผูกโต๊ะ และไม่ใช่โหมดบุฟเฟต์ — ลูกค้าดูเมนูได้ก่อน
            เมื่อกดสั่งครั้งแรกระบบจะเปิดโต๊ะให้อัตโนมัติ
          </p>
        </div>

        <div className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-muted)] p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-bold text-[var(--ink-2)]">ขอเพลง (Music Request)</span>
            <span className="badge badge-warning">
              ใบอนุญาต:{" "}
              {store.musicLicenseStatus === "approved"
                ? "อนุมัติแล้ว"
                : store.musicLicenseStatus === "pending"
                  ? "รอตรวจ"
                  : store.musicLicenseStatus === "rejected"
                    ? "ปฏิเสธ"
                    : store.musicLicenseStatus === "expired"
                      ? "หมดอายุ"
                      : "ยังไม่ขอ"}
            </span>
          </div>
          <label className="mt-3 flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              name="musicRequestEnabled"
              value="1"
              defaultChecked={store.musicRequestEnabled && store.musicLicenseStatus === "approved"}
              disabled={!canEdit || store.musicLicenseStatus !== "approved"}
              className="rounded border-gray-300"
            />
            <span className="text-sm font-medium text-[var(--ink-2)]">เปิดให้ลูกค้าขอเพลงผ่าน QR</span>
          </label>
          {store.musicLicenseStatus !== "approved" && (
            <p className="mt-2 text-xs text-[var(--muted)]">
              ต้องได้รับการอนุมัติใบอนุญาตจากผู้ดูแลระบบก่อน จึงจะเปิดให้ลูกค้าขอเพลงได้ (เฉพาะแพ็กเกจ Enterprise)
            </p>
          )}
        </div>

        {state.error && (
          <p className="alert-danger">
            {state.error}
          </p>
        )}

        {canEdit && (
          <Button
            type="submit"
            variant="primary"
            loading={pending}
            loadingText="กำลังบันทึก..."
            className="disabled:opacity-40"
          >
            บันทึก
          </Button>
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
