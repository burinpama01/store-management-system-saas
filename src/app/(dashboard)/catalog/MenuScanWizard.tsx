"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import {
  createCategoryAction,
  createProductAction,
} from "./actions";
import { listCategoriesForScan } from "./menu-scan-actions";

type ScanItem = {
  category: string;
  name: string;
  price: number | null;
  confidence: number;
  requiresConfirmation: boolean;
  include: boolean;
};

type SaveResult = { name: string; ok: boolean; message: string };

/**
 * Task 11/E — Menu Scan wizard: ถ่าย/อัปโหลดรูปเมนู → AI ดึงรายการ → ร้านตรวจ →
 * สร้างเมนูผ่าน server actions เดิม (permission/package gate เดิมทุกจุด)
 * นโยบายรูป: ไม่เก็บรูป — preview ในเครื่องเท่านั้น, ส่งให้ AI หลังกดยืนยัน, ระบบไม่บันทึกรูป
 */
export function MenuScanWizard() {
  const [open, setOpen] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [consent, setConsent] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [items, setItems] = useState<ScanItem[] | null>(null);
  const [categories, setCategories] = useState<Array<{ id: string; name: string }>>([]);
  const [saveResults, setSaveResults] = useState<SaveResult[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [, formAction] = useActionState(createCategoryAction, { error: null });
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      void listCategoriesForScan().then((res) => {
        if (res.ok) setCategories(res.categories);
      });
    }
  }, [open]);

  function pick(f: File | null) {
    setFile(f);
    setItems(null);
    setSaveResults(null);
    setScanError(null);
    setConsent(false);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(f ? URL.createObjectURL(f) : null);
  }

  async function scan() {
    if (!file || !consent) return;
    setScanning(true);
    setScanError(null);
    try {
      const fd = new FormData();
      fd.set("image", file);
      const res = await fetch("/api/ai/menu-scan", { method: "POST", body: fd });
      const data = (await res.json()) as {
        ok?: boolean;
        items?: Array<{ category: string; name: string; price: number | null; confidence: number }>;
        manualPath?: string;
        error?: string;
      };
      if (data.ok && data.items) {
        setItems(
          data.items.map((it) => ({
            ...it,
            requiresConfirmation: it.price === null || it.confidence < 0.6,
            include: true,
          })));
        void listCategoriesForScan().then((r) => {
          if (r.ok) setCategories(r.categories);
        });
      } else {
        setScanError(data.manualPath ?? data.error ?? "สแกนไม่สำเร็จ");
      }
    } catch {
      setScanError("เชื่อมต่อไม่สำเร็จ — ลองใหม่");
    } finally {
      setScanning(false);
    }
  }

  async function saveAll() {
    if (!items) return;
    setSaving(true);
    const results: SaveResult[] = [];
    let currentCategories = [...categories];
    for (const item of items.filter((i) => i.include)) {
      const match = currentCategories.find((c) => c.name.toLowerCase() === item.category.toLowerCase());
      let categoryId = match?.id ?? null;
      if (!categoryId) {
        const fd = new FormData();
        fd.set("name", item.category);
        const created = await createCategoryAction({ error: null }, fd);
        if (created.error) {
          results.push({ name: item.name, ok: false, message: `หมวด "${item.category}": ${created.error}` });
          continue;
        }
        const refreshed = await listCategoriesForScan();
        if (refreshed.ok) {
          currentCategories = refreshed.categories;
          setCategories(refreshed.categories);
          categoryId = refreshed.categories.find((c) => c.name.toLowerCase() === item.category.toLowerCase())?.id ?? null;
        }
        if (!categoryId) {
          results.push({ name: item.name, ok: false, message: `หา id หมวด "${item.category}" ไม่พบ` });
          continue;
        }
      }
      const fd = new FormData();
      fd.set("name", item.name);
      fd.set("categoryId", categoryId);
      fd.set("basePrice", item.price === null ? "0" : String(item.price));
      const created = await createProductAction({ error: null }, fd);
      results.push(
        created.error
          ? { name: item.name, ok: false, message: created.error }
          : { name: item.name, ok: true, message: item.price === null ? "สร้างแล้ว (ราคายังไม่ได้ใส่)" : "สร้างแล้ว" },
      );
    }
    setSaveResults(results);
    setSaving(false);
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="btn-secondary min-h-11 px-4 text-sm">
        📷 สแกนเมนูด้วย AI
      </button>
    );
  }

  const included = items?.filter((i) => i.include).length ?? 0;

  return (
    <div className="panel max-w-3xl p-5">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="panel-title">📷 สแกนเมนูด้วย AI</h3>
        <button type="button" onClick={() => { setOpen(false); pick(null); }} className="text-sm text-[var(--muted)]">
          ปิด
        </button>
      </div>

      {!items ? (
        <div className="space-y-3">
          <p className="text-sm text-[var(--muted)]">
            ถ่ายรูปหรือเลือกรูปเมนู → AI ดึงรายการสินค้า → คุณตรวจและแก้ไข → กดสร้างเมนูจริง
          </p>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            capture="environment"
            onChange={(e) => pick(e.target.files?.[0] ?? null)}
            className="w-full text-sm"
          />
          {previewUrl ? (
            <div className="space-y-2">
              {/* ตัวอย่างรูปแสดงในเครื่องเท่านั้น — ระบบไม่เก็บรูป */}
              <img src={previewUrl} alt="ตัวอย่างรูปเมนู" className="max-h-72 rounded-[var(--radius-md)] border border-[var(--border)] object-contain" />
              <label className="flex items-start gap-2 text-xs text-[var(--ink-2)]">
                <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
                ยืนยันส่งรูปนี้ให้ AI อ่าน (ระบบไม่เก็บรูป — ประมวลผลแล้วทิ้ง ไม่มีข้อมูลร้านแนบไป)
              </label>
              <button type="button" onClick={scan} disabled={!consent || scanning} className="btn-primary min-h-11 w-full disabled:opacity-40">
                {scanning ? "กำลังอ่านเมนู..." : "สแกนเมนู"}
              </button>
            </div>
          ) : null}
          {scanError ? (
            <p className="rounded-[var(--radius-md)] border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800" role="alert">
              {scanError}
            </p>
          ) : null}
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-[var(--muted)]">ตรวจรายการก่อนสร้าง — แก้ชื่อ/ราคาได้, รายการที่ราคาอ่านไม่ออกจะขึ้น “ต้องใส่ราคา”</p>
          {items.map((item, i) => (
            <div key={`${item.category}-${item.name}-${i}`} className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-muted)] p-3">
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={item.include}
                  onChange={(e) => setItems(items.map((x, xi) => (xi === i ? { ...x, include: e.target.checked } : x)))}
                  aria-label={`รวม ${item.name}`}
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
                />
              </div>
            </div>
          ))}
          <button
            type="button"
            onClick={saveAll}
            disabled={saving || included === 0}
            className="btn-primary min-h-11 w-full disabled:opacity-40"
          >
            {saving ? "กำลังสร้างเมนู..." : `สร้าง ${included} รายการ`}
          </button>
          {saveResults ? (
            <ul className="space-y-1 text-sm">
              {saveResults.map((r) => (
                <li key={r.name} className={r.ok ? "text-emerald-700" : "text-red-600"}>
                  {r.ok ? "✓" : "✕"} {r.name} — {r.message}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      )}
    </div>
  );
}