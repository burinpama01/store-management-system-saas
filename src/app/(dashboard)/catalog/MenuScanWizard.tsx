"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { uploadWithProgress } from "@/shared/services/upload";
import { createCategoryAction, createProductAction } from "./actions";
import { getMenuScanQuotaAction, listCategoriesForScan, type MenuScanQuotaView } from "./menu-scan-actions";

type ScanItem = {
  category: string;
  name: string;
  price: number | null;
  confidence: number;
  requiresConfirmation: boolean;
  include: boolean;
};

type SaveResult = { name: string; ok: boolean; message: string };

/** ขนาด/ชนิดไฟล์ต้องตรงกับด่านฝั่ง server (route ตรวจซ้ำจาก magic bytes เสมอ) */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MIN_IMAGE_BYTES = 8 * 1024;
const MIN_IMAGE_EDGE = 300;
const ACCEPTED_TYPES = ["image/jpeg", "image/png", "image/webp"];

type Phase = "idle" | "uploading" | "analyzing";

type ScanResponse = {
  ok?: boolean;
  items?: Array<{ category: string; name: string; price: number | null; confidence: number }>;
  quota?: {
    budget: number;
    used: number;
    remaining: number;
    creditRemaining: number;
    totalRemaining: number;
    remainingRequests: number;
  };
  manualPath?: string;
  error?: string;
};

/** ตรวจรูปฝั่งเครื่องก่อนส่ง — กันอัปไฟล์มั่ว/ภาพจิ๋วไม่ให้เผาโควตา AI ทิ้ง */
async function validateImage(file: File): Promise<string | null> {
  if (!ACCEPTED_TYPES.includes(file.type)) return "รองรับเฉพาะไฟล์รูป JPG / PNG / WEBP";
  if (file.size > MAX_IMAGE_BYTES) return "รูปใหญ่เกิน 5 MB — ถ่ายใหม่หรือย่อรูปก่อน";
  if (file.size < MIN_IMAGE_BYTES) return "รูปเล็ก/ไม่ชัดเกินไป — ถ่ายรูปเมนูให้เต็มกรอบแล้วลองใหม่";
  const size = await new Promise<{ w: number; h: number } | null>((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ w: img.naturalWidth, h: img.naturalHeight });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    img.src = url;
  });
  if (!size) return "เปิดไฟล์รูปนี้ไม่ได้ — ไฟล์อาจเสียหาย";
  if (size.w < MIN_IMAGE_EDGE || size.h < MIN_IMAGE_EDGE) {
    return `รูปเล็กเกินไป (${size.w}×${size.h}) — ต้องกว้าง/สูงอย่างน้อย ${MIN_IMAGE_EDGE} พิกเซล`;
  }
  return null;
}

/**
 * Task 11/E — Menu Scan wizard: ถ่าย/อัปโหลดรูปเมนู → AI ดึงรายการ → ร้านตรวจ →
 * ยืนยันขั้นสุดท้าย → สร้างเมนูผ่าน server actions เดิม (permission/package gate เดิมทุกจุด)
 * นโยบายรูป: ไม่เก็บรูป — preview ในเครื่องเท่านั้น, ส่งให้ AI หลังกดยืนยัน, ระบบไม่บันทึกรูป
 */
export function MenuScanWizard({
  kitchenStations = [],
  canUseQrOrdering = false,
}: {
  kitchenStations?: Array<{ id: string; name: string }>;
  canUseQrOrdering?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [consent, setConsent] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [uploadPercent, setUploadPercent] = useState(0);
  const [scanError, setScanError] = useState<string | null>(null);
  const [items, setItems] = useState<ScanItem[] | null>(null);
  const [categories, setCategories] = useState<Array<{ id: string; name: string }>>([]);
  const [quota, setQuota] = useState<MenuScanQuotaView | null>(null);
  const [saveResults, setSaveResults] = useState<SaveResult[] | null>(null);
  const [savingIndex, setSavingIndex] = useState<number | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  // จุดแสดงสินค้าที่จะสร้าง — POS ติ๊กไว้เป็นค่าเริ่มต้นตามที่ร้านใช้งานจริง
  const [showInPos, setShowInPos] = useState(true);
  const [showInQr, setShowInQr] = useState(false);
  const [showInDelivery, setShowInDelivery] = useState(false);
  const [kitchenStationId, setKitchenStationId] = useState<string>(kitchenStations[0]?.id ?? "");
  const cameraRef = useRef<HTMLInputElement>(null);
  const uploadRef = useRef<HTMLInputElement>(null);

  const refreshQuota = useCallback(() => {
    void getMenuScanQuotaAction().then(setQuota);
  }, []);

  useEffect(() => {
    if (!open) return;
    void listCategoriesForScan().then((res) => {
      if (res.ok) setCategories(res.categories);
    });
    refreshQuota();
  }, [open, refreshQuota]);

  useEffect(
    () => () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    },
    [previewUrl],
  );

  async function pick(f: File | null) {
    setItems(null);
    setSaveResults(null);
    setScanError(null);
    setConsent(false);
    setUploadPercent(0);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    if (!f) {
      setFile(null);
      setPreviewUrl(null);
      return;
    }
    const problem = await validateImage(f);
    if (problem) {
      setFile(null);
      setPreviewUrl(null);
      setScanError(problem);
      return;
    }
    setFile(f);
    setPreviewUrl(URL.createObjectURL(f));
  }

  async function scan() {
    if (!file || !consent) return;
    setPhase("uploading");
    setUploadPercent(0);
    setScanError(null);
    try {
      const fd = new FormData();
      fd.set("image", file);
      // ใช้ตัวอัปโหลดกลางของระบบ (XHR) เพื่อให้เห็นเปอร์เซ็นต์อัปโหลดจริง
      const { data } = await uploadWithProgress<ScanResponse>("/api/ai/menu-scan", fd, (percent) => {
        setUploadPercent(percent);
        if (percent >= 100) setPhase("analyzing");
      });
      if (!data) {
        setScanError("เชื่อมต่อไม่สำเร็จ — ลองใหม่");
        return;
      }
      if (data.quota) {
        setQuota({ ok: true, enabled: true, ...data.quota });
      } else {
        refreshQuota();
      }
      if (data.ok && data.items) {
        setItems(
          data.items.map((it) => ({
            ...it,
            requiresConfirmation: it.price === null || it.confidence < 0.6,
            include: true,
          })),
        );
        const refreshed = await listCategoriesForScan();
        if (refreshed.ok) setCategories(refreshed.categories);
      } else {
        setScanError(data.manualPath ?? data.error ?? "สแกนไม่สำเร็จ");
      }
    } catch {
      setScanError("เชื่อมต่อไม่สำเร็จ — ลองใหม่");
    } finally {
      setPhase("idle");
    }
  }

  async function saveAll() {
    if (!items) return;
    setConfirmOpen(false);
    const queue = items.filter((i) => i.include);
    const results: SaveResult[] = [];
    let currentCategories = [...categories];
    for (const [index, item] of queue.entries()) {
      setSavingIndex(index);
      const match = currentCategories.find((c) => c.name.toLowerCase() === item.category.toLowerCase());
      let categoryId = match?.id ?? null;
      if (!categoryId) {
        const fd = new FormData();
        fd.set("name", item.category);
        const created = await createCategoryAction({ error: null }, fd);
        if (created.error) {
          results.push({ name: item.name, ok: false, message: `หมวด "${item.category}": ${created.error}` });
          setSaveResults([...results]);
          continue;
        }
        const refreshed = await listCategoriesForScan();
        if (refreshed.ok) {
          currentCategories = refreshed.categories;
          setCategories(refreshed.categories);
          categoryId =
            refreshed.categories.find((c) => c.name.toLowerCase() === item.category.toLowerCase())?.id ?? null;
        }
        if (!categoryId) {
          results.push({ name: item.name, ok: false, message: `หา id หมวด "${item.category}" ไม่พบ` });
          setSaveResults([...results]);
          continue;
        }
      }
      const fd = new FormData();
      fd.set("name", item.name);
      fd.set("categoryId", categoryId);
      fd.set("basePrice", item.price === null ? "0" : String(item.price));
      if (showInPos) fd.set("availableForPos", "on");
      if (showInQr && kitchenStationId) {
        fd.set("availableForQr", "on");
        fd.set("kitchenStationId", kitchenStationId);
      }
      if (showInDelivery) fd.set("availableForDelivery", "on");
      const created = await createProductAction({ error: null }, fd);
      results.push(
        created.error
          ? { name: item.name, ok: false, message: created.error }
          : { name: item.name, ok: true, message: item.price === null ? "สร้างแล้ว (ราคา 0 บาท)" : "สร้างแล้ว" },
      );
      setSaveResults([...results]);
    }
    setSavingIndex(null);
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="btn-secondary min-h-11 px-4 text-sm">
        📷 สแกนเมนูด้วย AI
      </button>
    );
  }

  const included = items?.filter((i) => i.include) ?? [];
  const missingPrice = included.filter((i) => i.price === null || i.price === 0).length;
  const newCategories = [
    ...new Set(
      included
        .map((i) => i.category)
        .filter((name) => !categories.some((c) => c.name.toLowerCase() === name.toLowerCase())),
    ),
  ];
  const saving = savingIndex !== null;
  const busy = phase !== "idle";
  const quotaExhausted = quota?.ok === true && quota.enabled && quota.remainingRequests <= 0;
  const channelLabels = [
    showInPos ? "POS" : null,
    showInQr ? "QR สั่งอาหาร" : null,
    showInDelivery ? "เดลิเวอรี" : null,
  ].filter(Boolean) as string[];

  return (
    <div className="panel max-w-3xl p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="panel-title">📷 สแกนเมนูด้วย AI</h3>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            void pick(null);
          }}
          className="text-sm text-[var(--muted)]"
        >
          ปิด
        </button>
      </div>

      {/* โควตา AI ของเดือนนี้ */}
      <div className="mb-3 text-xs" aria-live="polite">
        {quota === null ? (
          <span className="text-[var(--muted)]">กำลังตรวจโควตา AI…</span>
        ) : quota.ok === false ? (
          <span className="text-red-600">อ่านโควตาไม่สำเร็จ</span>
        ) : quota.enabled === false ? (
          <span className="rounded-[var(--radius-sm)] bg-amber-50 px-2 py-1 text-amber-800">{quota.reason}</span>
        ) : (
          <span className={quota.remainingRequests <= 0 ? "text-red-600" : "text-[var(--muted)]"}>
            โควตา AI ของทั้งร้าน (ใช้ร่วมกันทุกฟีเจอร์): เหลือ{" "}
            <b className="tabular-nums">{quota.remainingRequests.toLocaleString("th-TH")}</b> ครั้ง · โควตาฟรีเดือนนี้{" "}
            {quota.remaining.toLocaleString("th-TH")}/{quota.budget.toLocaleString("th-TH")} โทเคน
            {quota.creditRemaining > 0 ? ` + เครดิตเติมเงิน ${quota.creditRemaining.toLocaleString("th-TH")} โทเคน` : ""}
            {" · "}
            <Link href="/settings/billing" className="underline">
              เติมเงิน
            </Link>
          </span>
        )}
      </div>

      {!items ? (
        <div className="space-y-3">
          <p className="text-sm text-[var(--muted)]">
            ถ่ายรูปหรืออัปโหลดรูปเมนู → AI ดึงรายการสินค้า → คุณตรวจและแก้ไข → ยืนยันสร้างเมนูจริง
          </p>

          <input
            ref={cameraRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            capture="environment"
            onChange={(e) => void pick(e.target.files?.[0] ?? null)}
            className="hidden"
          />
          <input
            ref={uploadRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            onChange={(e) => void pick(e.target.files?.[0] ?? null)}
            className="hidden"
          />
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              void pick(e.dataTransfer.files?.[0] ?? null);
            }}
            className="rounded-[var(--radius-md)] border border-dashed border-[var(--border)] p-4 text-center"
          >
            <div className="flex flex-wrap justify-center gap-2">
              <button
                type="button"
                onClick={() => cameraRef.current?.click()}
                className="btn-secondary min-h-11 px-4 text-sm"
                disabled={busy}
              >
                📷 ถ่ายรูป
              </button>
              <button
                type="button"
                onClick={() => uploadRef.current?.click()}
                className="btn-secondary min-h-11 px-4 text-sm"
                disabled={busy}
              >
                🖼️ อัปโหลดรูป
              </button>
            </div>
            <p className="mt-2 text-xs text-[var(--muted)]">
              ลากรูปมาวางตรงนี้ก็ได้ — รองรับ JPG / PNG / WEBP ขนาด 8 KB – 5 MB และกว้าง/สูงอย่างน้อย {MIN_IMAGE_EDGE} พิกเซล
            </p>
          </div>

          {previewUrl ? (
            <div className="space-y-2">
              {/* ตัวอย่างรูปแสดงในเครื่องเท่านั้น — ระบบไม่เก็บรูป */}
              <img
                src={previewUrl}
                alt="ตัวอย่างรูปเมนู"
                className="max-h-72 rounded-[var(--radius-md)] border border-[var(--border)] object-contain"
              />
              <p className="text-xs text-[var(--muted)]">
                {file?.name} · {((file?.size ?? 0) / 1024 / 1024).toFixed(2)} MB
              </p>
              <label className="flex items-start gap-2 text-xs text-[var(--ink-2)]">
                <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} disabled={busy} />
                ยืนยันส่งรูปนี้ให้ AI อ่าน (ระบบไม่เก็บรูป — ประมวลผลแล้วทิ้ง ไม่มีข้อมูลร้านแนบไป)
              </label>
              <button
                type="button"
                onClick={scan}
                disabled={!consent || busy || quotaExhausted}
                className="btn-primary min-h-11 w-full disabled:opacity-40"
              >
                {phase === "uploading"
                  ? `กำลังอัปโหลดรูป ${uploadPercent}%`
                  : phase === "analyzing"
                    ? "AI กำลังอ่านเมนู…"
                    : "สแกนเมนู"}
              </button>
              {busy ? (
                <div className="space-y-1" aria-live="polite">
                  <div className="h-2 w-full overflow-hidden rounded-full bg-[var(--surface-muted)]">
                    <div
                      className="h-full bg-[var(--brand)] transition-all"
                      style={{ width: phase === "analyzing" ? "100%" : `${uploadPercent}%` }}
                    />
                  </div>
                  <p className="text-xs text-[var(--muted)]">
                    {phase === "uploading"
                      ? `กำลังส่งรูป… ${uploadPercent}%`
                      : "ส่งรูปครบแล้ว — AI กำลังอ่านรายการ (ปกติ 5–20 วินาที) อย่าปิดหน้านี้"}
                  </p>
                </div>
              ) : null}
            </div>
          ) : null}

          {quotaExhausted ? (
            <p className="rounded-[var(--radius-md)] border border-red-200 bg-red-50 p-3 text-sm text-red-700" role="alert">
              โควตา AI หมดแล้ว —{" "}
              <Link href="/settings/billing" className="font-bold underline">
                เติมเงินเพื่อใช้งานต่อ
              </Link>{" "}
              หรือเพิ่มเมนูด้วยมือตามปกติ
            </p>
          ) : null}
          {scanError ? (
            <p className="rounded-[var(--radius-md)] border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800" role="alert">
              {scanError}
            </p>
          ) : null}
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-[var(--muted)]">
            ตรวจรายการก่อนสร้าง — แก้ชื่อ/ราคาได้, รายการที่ราคาอ่านไม่ออกจะขึ้น “ต้องตรวจ”
          </p>

          {/* จุดแสดงสินค้า — POS เป็นค่าเริ่มต้น */}
          <fieldset className="rounded-[var(--radius-md)] border border-[var(--border)] p-3">
            <legend className="px-1 text-xs font-bold text-[var(--ink-2)]">จุดแสดงสินค้าที่จะสร้าง</legend>
            <div className="flex flex-wrap gap-4 text-sm">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={showInPos} onChange={(e) => setShowInPos(e.target.checked)} disabled={saving} />
                ขายที่ POS <span className="text-xs text-[var(--muted)]">(ค่าเริ่มต้น)</span>
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={showInQr}
                  onChange={(e) => setShowInQr(e.target.checked)}
                  disabled={saving || !canUseQrOrdering || kitchenStations.length === 0}
                />
                QR สั่งอาหาร
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={showInDelivery}
                  onChange={(e) => setShowInDelivery(e.target.checked)}
                  disabled={saving}
                />
                เดลิเวอรี
              </label>
            </div>
            {showInQr ? (
              <label className="mt-2 block text-xs text-[var(--ink-2)]">
                ครัว/บาร์ที่รับออเดอร์ QR
                <select
                  value={kitchenStationId}
                  onChange={(e) => setKitchenStationId(e.target.value)}
                  className="form-input mt-1"
                  disabled={saving}
                >
                  {kitchenStations.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {!canUseQrOrdering ? (
              <p className="mt-2 text-xs text-[var(--muted)]">แพ็กเกจปัจจุบันยังไม่รวม QR สั่งอาหาร</p>
            ) : kitchenStations.length === 0 ? (
              <p className="mt-2 text-xs text-[var(--muted)]">
                ยังไม่มีครัว/บาร์ — เพิ่มได้ที่ ตั้งค่า → Kitchen ก่อนเปิดขายผ่าน QR
              </p>
            ) : null}
          </fieldset>

          {items.map((item, i) => (
            <div
              key={`${item.category}-${item.name}-${i}`}
              className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-muted)] p-3"
            >
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={item.include}
                  onChange={(e) => setItems(items.map((x, xi) => (xi === i ? { ...x, include: e.target.checked } : x)))}
                  aria-label={`รวม ${item.name}`}
                  disabled={saving}
                />
                <span className="badge badge-brand text-[10px]">{item.category}</span>
                <span className="text-xs text-[var(--muted)]">มั่นใจ {Math.round(item.confidence * 100)}%</span>
                {item.requiresConfirmation ? <span className="text-xs font-bold text-amber-700">ต้องตรวจ</span> : null}
              </div>
              <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_140px]">
                <input
                  value={item.name}
                  onChange={(e) => setItems(items.map((x, xi) => (xi === i ? { ...x, name: e.target.value } : x)))}
                  className="form-input"
                  aria-label="ชื่อสินค้า"
                  disabled={saving}
                />
                <input
                  type="number"
                  min={0}
                  value={item.price ?? ""}
                  placeholder="ราคา (บาท)"
                  onChange={(e) =>
                    setItems(
                      items.map((x, xi) =>
                        xi === i ? { ...x, price: e.target.value === "" ? null : Number(e.target.value) } : x,
                      ),
                    )
                  }
                  className="form-input tabular-nums"
                  aria-label="ราคา"
                  disabled={saving}
                />
              </div>
            </div>
          ))}

          {missingPrice > 0 ? (
            <p className="rounded-[var(--radius-md)] border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800" role="alert">
              ⚠️ มี {missingPrice} รายการที่ยังไม่ได้ระบุราคา — ถ้าสร้างเลยจะถูกบันทึกเป็น <b>0 บาท</b> และขายที่ POS ได้ทันทีในราคา 0
            </p>
          ) : null}

          <button
            type="button"
            onClick={() => setConfirmOpen(true)}
            disabled={saving || included.length === 0 || (!showInPos && !showInQr && !showInDelivery)}
            className="btn-primary min-h-11 w-full disabled:opacity-40"
          >
            {saving ? `กำลังสร้างเมนู ${(savingIndex ?? 0) + 1}/${included.length}…` : `สร้าง ${included.length} รายการ`}
          </button>

          {saving ? (
            <div className="space-y-1" aria-live="polite">
              <div className="h-2 w-full overflow-hidden rounded-full bg-[var(--surface-muted)]">
                <div
                  className="h-full bg-[var(--brand)] transition-all"
                  style={{ width: `${Math.round((((savingIndex ?? 0) + 1) / Math.max(1, included.length)) * 100)}%` }}
                />
              </div>
              <p className="text-xs text-[var(--muted)]">กำลังบันทึกทีละรายการ อย่าปิดหน้านี้</p>
            </div>
          ) : null}

          {saveResults ? (
            <ul className="space-y-1 text-sm">
              {saveResults.map((r, i) => (
                <li key={`${r.name}-${i}`} className={r.ok ? "text-emerald-700" : "text-red-600"}>
                  {r.ok ? "✓" : "✕"} {r.name} — {r.message}
                </li>
              ))}
            </ul>
          ) : null}

          {saveResults && !saving ? (
            <p className="text-xs text-[var(--muted)]">
              ต้องการเพิ่มตัวเลือกสินค้า (ขนาด / หวานน้อย / ท็อปปิ้ง) หรือรูปภาพ ให้ไปที่รายการเมนูแล้วกด “แก้ไข” ที่สินค้านั้น
            </p>
          ) : null}
        </div>
      )}

      {/* Dialog ยืนยันขั้นสุดท้าย */}
      {confirmOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="ยืนยันสร้างเมนู"
        >
          <div className="panel w-full max-w-md space-y-3 p-5">
            <h4 className="panel-title">ยืนยันสร้างเมนู {included.length} รายการ?</h4>
            <ul className="space-y-1 text-sm text-[var(--ink-2)]">
              <li>
                • สร้างสินค้า <b>{included.length}</b> รายการ
              </li>
              {newCategories.length > 0 ? (
                <li>
                  • สร้างหมวดใหม่ <b>{newCategories.length}</b> หมวด: {newCategories.join(", ")}
                </li>
              ) : null}
              <li>
                • จุดแสดง: <b>{channelLabels.join(" + ") || "—"}</b>
              </li>
            </ul>
            {missingPrice > 0 ? (
              <p className="rounded-[var(--radius-md)] border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                ⚠️ <b>{missingPrice} รายการยังไม่ได้ระบุราคา</b> — จะถูกบันทึกเป็น <b>0 บาท</b> กดกลับไปใส่ราคาก่อนได้
              </p>
            ) : null}
            <p className="rounded-[var(--radius-md)] bg-[var(--surface-muted)] p-3 text-xs text-[var(--ink-2)]">
              หมายเหตุ: การสแกนสร้างได้แค่ชื่อ / หมวด / ราคาเท่านั้น — หากต้องการเพิ่ม<b>ตัวเลือกสินค้า</b> (ขนาด, ระดับความหวาน,
              ท็อปปิ้ง), รูปภาพ หรือราคาเดลิเวอรี ให้เลือก <b>“แก้ไขเมนู”</b> ที่สินค้านั้นหลังสร้างเสร็จ
            </p>
            <div className="flex gap-2">
              <button type="button" onClick={() => setConfirmOpen(false)} className="btn-secondary min-h-11 flex-1">
                กลับไปแก้ไข
              </button>
              <button type="button" onClick={() => void saveAll()} className="btn-primary min-h-11 flex-1">
                ยืนยันสร้างเมนู
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
