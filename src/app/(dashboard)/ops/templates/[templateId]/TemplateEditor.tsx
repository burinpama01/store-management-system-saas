"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { validateTemplateInput } from "@/modules/operations/rules";
import {
  CHECKLIST_PHASE_LABELS,
  DAY_LABELS,
  type ChecklistPhase,
  type ChecklistPhotoRule,
  type TemplateInput,
  type TemplateItemInput,
} from "@/modules/operations/types";
import { saveChecklistTemplateAction } from "../../actions";

const PHOTO_RULE_LABELS: Record<ChecklistPhotoRule, string> = {
  never: "ไม่ต้องมีรูป",
  on_fail: "ไม่ผ่านต้องมีรูป",
  always: "ต้องมีรูปทุกครั้ง",
};

const NEW_ITEM: TemplateItemInput = {
  label: "",
  description: null,
  critical: false,
  valueType: "check",
  unit: null,
  minValue: null,
  maxValue: null,
  photoRule: "never",
};

function parseNumber(raw: string): number | null {
  if (raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

export function TemplateEditor({
  templateId,
  initial,
  members,
}: {
  templateId: string | null;
  initial: TemplateInput;
  members: Array<{ userId: string; label: string; role: string }>;
}) {
  const router = useRouter();
  const [form, setForm] = useState<TemplateInput>(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const update = (patch: Partial<TemplateInput>) => setForm((current) => ({ ...current, ...patch }));
  const updateItem = (index: number, patch: Partial<TemplateItemInput>) =>
    setForm((current) => ({
      ...current,
      items: current.items.map((item, i) => (i === index ? { ...item, ...patch } : item)),
    }));
  const moveItem = (index: number, delta: number) =>
    setForm((current) => {
      const target = index + delta;
      if (target < 0 || target >= current.items.length) return current;
      const items = [...current.items];
      [items[index], items[target]] = [items[target], items[index]];
      return { ...current, items };
    });

  function save() {
    setError(null);
    const invalid = validateTemplateInput(form);
    if (invalid) {
      setError(invalid);
      return;
    }
    startTransition(async () => {
      const result = await saveChecklistTemplateAction(templateId, form);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.push("/ops/templates");
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <div className="space-y-3 rounded-lg border border-gray-200 bg-white p-4">
        <label className="block text-sm">
          <span className="font-semibold text-gray-800">ชื่อเช็กลิสต์</span>
          <input className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2" maxLength={120} value={form.name}
            placeholder="เช่น ปิดครัว" onChange={(event) => update({ name: event.target.value })} />
        </label>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="block text-sm">
            <span className="font-semibold text-gray-800">พื้นที่</span>
            <input className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2" maxLength={60} value={form.area}
              placeholder="ครัว / บาร์" onChange={(event) => update({ area: event.target.value })} />
          </label>
          <label className="block text-sm">
            <span className="font-semibold text-gray-800">รอบ</span>
            <select className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2" value={form.phase}
              onChange={(event) => update({ phase: event.target.value as ChecklistPhase })}>
              {(Object.keys(CHECKLIST_PHASE_LABELS) as ChecklistPhase[]).map((phase) => (
                <option key={phase} value={phase}>{CHECKLIST_PHASE_LABELS[phase]}</option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            <span className="font-semibold text-gray-800">ต้องเสร็จภายใน (เวลาร้าน)</span>
            <input type="time" className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2" value={form.dueTime ?? ""}
              onChange={(event) => update({ dueTime: event.target.value || null })} />
            <span className="text-[11px] text-gray-500">เลยเวลาแล้วยังไม่ส่ง = แจ้งเจ้าของ · ก่อน 05:00 = หลังเที่ยงคืน</span>
          </label>
        </div>

        <div className="text-sm">
          <span className="font-semibold text-gray-800">วันที่ใช้</span>
          <div className="mt-1 flex flex-wrap gap-2">
            {DAY_LABELS.map((label, day) => {
              const on = form.daysOfWeek.includes(day);
              return (
                <button key={label} type="button"
                  className={`h-10 w-12 rounded-md border text-sm font-semibold ${on ? "border-emerald-500 bg-emerald-50 text-emerald-800" : "border-gray-300 bg-white text-gray-500"}`}
                  onClick={() => update({ daysOfWeek: on ? form.daysOfWeek.filter((d) => d !== day) : [...form.daysOfWeek, day].sort() })}>
                  {label}
                </button>
              );
            })}
          </div>
        </div>

        <div className="text-sm">
          <span className="font-semibold text-gray-800">ผู้รับผิดชอบ</span>
          <div className="mt-1 grid gap-1 sm:grid-cols-2">
            {members.map((member) => (
              <label key={member.userId} className="flex items-center gap-2 rounded-md border border-gray-200 px-3 py-2">
                <input type="checkbox" checked={form.assigneeUserIds.includes(member.userId)}
                  onChange={(event) => update({
                    assigneeUserIds: event.target.checked
                      ? [...form.assigneeUserIds, member.userId]
                      : form.assigneeUserIds.filter((id) => id !== member.userId),
                  })} />
                <span className="min-w-0 truncate">{member.label}</span>
                <span className="ml-auto text-[11px] text-gray-500">{member.role}</span>
              </label>
            ))}
          </div>
        </div>

        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={form.requireBeforeClockOut}
            onChange={(event) => update({ requireBeforeClockOut: event.target.checked })} />
          <span>
            <span className="font-semibold text-gray-800">ต้องส่งก่อนออกงาน</span>
            <span className="block text-xs text-gray-600">ผู้รับผิดชอบจะกดออกงานไม่ได้จนกว่าจะส่งเช็กลิสต์นี้ของวันนั้น</span>
          </span>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={form.isActive} onChange={(event) => update({ isActive: event.target.checked })} />
          <span className="font-semibold text-gray-800">ใช้งาน</span>
        </label>
      </div>

      <div className="space-y-3">
        <h2 className="text-sm font-bold text-gray-900">ข้อในเช็กลิสต์ ({form.items.length})</h2>
        {form.items.map((item, index) => (
          <div key={index} className="space-y-2 rounded-lg border border-gray-200 bg-white p-4">
            <div className="flex items-center gap-2">
              <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-gray-100 text-xs font-bold">{index + 1}</span>
              <input className="min-w-0 flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm" maxLength={200} value={item.label}
                placeholder="สิ่งที่ต้องตรวจ" onChange={(event) => updateItem(index, { label: event.target.value })} />
            </div>
            <input className="w-full rounded-md border border-gray-200 px-3 py-1.5 text-xs" maxLength={500} value={item.description ?? ""}
              placeholder="คำอธิบาย/วิธีทำ (ไม่บังคับ)" onChange={(event) => updateItem(index, { description: event.target.value || null })} />
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <label className="flex items-center gap-1">
                <input type="checkbox" checked={item.critical} onChange={(event) => updateItem(index, { critical: event.target.checked })} />
                <span className="font-semibold text-red-700">ข้อสำคัญ</span>
              </label>
              <select className="rounded-md border border-gray-300 px-2 py-1.5" value={item.valueType}
                onChange={(event) => updateItem(index, { valueType: event.target.value as TemplateItemInput["valueType"] })}>
                <option value="check">ติ๊ก ผ่าน/ไม่ผ่าน</option>
                <option value="number">กรอกตัวเลข (เช่น อุณหภูมิ)</option>
              </select>
              <select className="rounded-md border border-gray-300 px-2 py-1.5" value={item.photoRule}
                onChange={(event) => updateItem(index, { photoRule: event.target.value as ChecklistPhotoRule })}>
                {(Object.keys(PHOTO_RULE_LABELS) as ChecklistPhotoRule[]).map((rule) => (
                  <option key={rule} value={rule}>{PHOTO_RULE_LABELS[rule]}</option>
                ))}
              </select>
            </div>
            {item.valueType === "number" && (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-gray-700">ช่วงที่ผ่าน</span>
                <input type="number" step="0.1" className="w-20 rounded-md border border-gray-300 px-2 py-1.5"
                  value={item.minValue ?? ""} placeholder="ต่ำสุด" onChange={(event) => updateItem(index, { minValue: parseNumber(event.target.value) })} />
                <span>–</span>
                <input type="number" step="0.1" className="w-20 rounded-md border border-gray-300 px-2 py-1.5"
                  value={item.maxValue ?? ""} placeholder="สูงสุด" onChange={(event) => updateItem(index, { maxValue: parseNumber(event.target.value) })} />
                <input className="w-20 rounded-md border border-gray-300 px-2 py-1.5" maxLength={20} value={item.unit ?? ""}
                  placeholder="หน่วย" onChange={(event) => updateItem(index, { unit: event.target.value || null })} />
                <span className="text-[11px] text-gray-500">นอกช่วง = ไม่ผ่านอัตโนมัติ</span>
              </div>
            )}
            <div className="flex gap-2 text-xs">
              <button type="button" className="underline" disabled={index === 0} onClick={() => moveItem(index, -1)}>เลื่อนขึ้น</button>
              <button type="button" className="underline" disabled={index === form.items.length - 1} onClick={() => moveItem(index, 1)}>เลื่อนลง</button>
              <button type="button" className="ml-auto text-red-700 underline" disabled={form.items.length === 1}
                onClick={() => update({ items: form.items.filter((_, i) => i !== index) })}>ลบข้อนี้</button>
            </div>
          </div>
        ))}
        <button type="button" className="btn-secondary" disabled={form.items.length >= 60}
          onClick={() => update({ items: [...form.items, { ...NEW_ITEM }] })}>+ เพิ่มข้อ</button>
      </div>

      <div className="sticky bottom-0 z-10 -mx-4 flex flex-wrap items-center gap-3 border-t border-gray-200 bg-white/95 py-3 pl-4 pr-24 sm:mx-0 sm:rounded-lg sm:border">
        <p className="min-w-0 flex-1 text-sm text-red-700" role="alert">{error}</p>
        <button type="button" className="btn-primary" disabled={pending} onClick={save}>{pending ? "กำลังบันทึก…" : "บันทึก"}</button>
      </div>
    </div>
  );
}
