"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  buildStarterTemplates,
  MAX_KITCHEN_NAME_LENGTH,
  MAX_KITCHENS,
  STORE_PACKS,
  type StorePackId,
} from "@/modules/operations/starter-packs";
import { CHECKLIST_PHASE_LABELS } from "@/modules/operations/types";
import { createStarterPackTemplatesAction } from "../../actions";

export function StarterPackPicker({
  initialPacks,
  existingNames,
}: {
  initialPacks: StorePackId[];
  existingNames: string[];
}) {
  const router = useRouter();
  const [packs, setPacks] = useState<StorePackId[]>(initialPacks);
  // id คงที่ต่อแถว — ลบแถวกลางแล้ว React ไม่สลับค่า/โฟกัสข้ามช่อง
  const nextId = useRef(2);
  const [kitchenRows, setKitchenRows] = useState([
    { id: 0, name: "ครัวร้อน" },
    { id: 1, name: "ครัวเย็น" },
  ]);
  const kitchens = useMemo(() => kitchenRows.map((row) => row.name), [kitchenRows]);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const preview = useMemo(() => buildStarterTemplates({ packs, kitchenNames: kitchens }), [packs, kitchens]);
  const existing = useMemo(() => new Set(existingNames), [existingNames]);
  const toCreate = preview.filter((template) => !existing.has(template.name));

  const toggle = (id: StorePackId) =>
    setPacks((current) => (current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]));

  function create() {
    setError(null);
    startTransition(async () => {
      const result = await createStarterPackTemplatesAction({ packs, kitchenNames: kitchens });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.push(`/ops/templates?created=${result.created ?? 0}&skipped=${result.skipped ?? 0}`);
      router.refresh();
    });
  }

  const renderPack = (kind: "store" | "addon") =>
    STORE_PACKS.filter((pack) => pack.kind === kind).map((pack) => {
      const on = packs.includes(pack.id);
      return (
        <label
          key={pack.id}
          className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 ${on ? "border-emerald-500 bg-emerald-50" : "border-gray-200 bg-white"}`}
        >
          <input type="checkbox" className="mt-1" checked={on} onChange={() => toggle(pack.id)} />
          <span className="min-w-0">
            <span className="block font-semibold text-gray-900">{pack.label}</span>
            <span className="block text-xs text-gray-600">{pack.description}</span>
          </span>
        </label>
      );
    });

  return (
    <div className="space-y-5">
      <section>
        <h2 className="text-sm font-bold text-gray-900">ร้านของคุณเป็นแบบไหน (เลือกได้หลายอย่าง)</h2>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">{renderPack("store")}</div>
      </section>

      <section>
        <h2 className="text-sm font-bold text-gray-900">ร้านมีลักษณะเหล่านี้ไหม</h2>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">{renderPack("addon")}</div>
      </section>

      {packs.includes("multi_kitchen") && (
        <section className="rounded-lg border border-gray-200 bg-white p-4">
          <h2 className="text-sm font-bold text-gray-900">ชื่อครัว (สูงสุด {MAX_KITCHENS} ครัว)</h2>
          <p className="text-xs text-gray-600">แต่ละครัวได้เช็กลิสต์เปิด / ระหว่างวัน / ปิด แยกกัน</p>
          <div className="mt-2 space-y-2">
            {kitchenRows.map((row, index) => (
              <div key={row.id} className="flex gap-2">
                <input
                  className="min-w-0 flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm"
                  maxLength={MAX_KITCHEN_NAME_LENGTH}
                  value={row.name}
                  placeholder={`ครัว ${index + 1}`}
                  onChange={(event) =>
                    setKitchenRows(kitchenRows.map((entry) => (entry.id === row.id ? { ...entry, name: event.target.value } : entry)))
                  }
                />
                <button
                  type="button"
                  className="text-xs text-red-700 underline"
                  disabled={kitchenRows.length === 1}
                  onClick={() => setKitchenRows(kitchenRows.filter((entry) => entry.id !== row.id))}
                >
                  ลบ
                </button>
              </div>
            ))}
            <button
              type="button"
              className="btn-secondary"
              disabled={kitchenRows.length >= MAX_KITCHENS}
              onClick={() => setKitchenRows([...kitchenRows, { id: nextId.current++, name: "" }])}
            >
              + เพิ่มครัว
            </button>
          </div>
        </section>
      )}

      <section className="rounded-lg border border-gray-200 bg-white p-4">
        <h2 className="text-sm font-bold text-gray-900">จะได้เช็กลิสต์ {toCreate.length} ชุด</h2>
        <p className="text-xs text-gray-600">
          สร้างแบบ “ปิดใช้” และยังไม่มีผู้รับผิดชอบ — แก้ข้อ เวลา ช่วงอุณหภูมิ และผู้รับผิดชอบได้ทีหลัง
        </p>
        {preview.length === 0 && <p className="mt-2 text-sm text-gray-500">ยังไม่ได้เลือกประเภทร้าน</p>}
        <ul className="mt-2 divide-y divide-gray-100 text-sm">
          {preview.map((template) => (
            <li key={template.name} className="flex flex-wrap items-center gap-x-2 py-1.5">
              <span className={existing.has(template.name) ? "text-gray-400 line-through" : "font-medium text-gray-900"}>
                {template.name}
              </span>
              <span className="text-xs text-gray-500">
                {template.area} · {CHECKLIST_PHASE_LABELS[template.phase]} · {template.items.length} ข้อ
                {template.requireBeforeClockOut ? " · ต้องส่งก่อนออกงาน" : ""}
              </span>
              {existing.has(template.name) && <span className="text-xs text-gray-500">มีอยู่แล้ว — ข้าม</span>}
            </li>
          ))}
        </ul>
      </section>

      <div className="sticky bottom-0 z-10 -mx-4 flex flex-wrap items-center gap-3 border-t border-gray-200 bg-white/95 py-3 pl-4 pr-24 sm:mx-0 sm:rounded-lg sm:border">
        <p className="min-w-0 flex-1 text-sm text-red-700" role="alert">{error}</p>
        <button type="button" className="btn-primary" disabled={pending || toCreate.length === 0} onClick={create}>
          {pending ? "กำลังสร้าง…" : `สร้าง ${toCreate.length} ชุด`}
        </button>
      </div>
    </div>
  );
}
