"use client";

/**
 * ปุ่ม "วัตถุดิบ" ข้างตัวเลือกเสริมในหน้าแก้เมนู — ผูกวัตถุดิบที่บวกเพิ่มเมื่อลูกค้าเลือกตัวเลือกนั้น
 * (เช่น เย็น = น้ำแข็ง, ปั่น = น้ำแข็ง + ผงปั่น) โดยไม่ต้องไปหน้า /costing/menu
 * แสดงเฉพาะผู้จัดการที่ใช้ระบบต้นทุนได้ — context เป็น null = ซ่อนปุ่มทั้งหมด
 */
import { createContext, useContext, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { OptionRecipeData } from "@/modules/costing/repository";
import { useConfirm } from "@/shared/components/ui/useConfirm";
import { saveOptionRecipeAction } from "../costing/actions";

type Ingredient = OptionRecipeData["ingredients"][number];

export interface OptionRecipeContextValue {
  ingredients: Ingredient[];
  linesByOption: Map<string, Array<{ ingredientId: string; quantity: number }>>;
  /** จำนวนตัวเลือกที่เปิดอยู่ในร้านที่มี "กลุ่ม:ตัวเลือก" ชื่อเดียวกัน (รวมตัวนี้) */
  sameNameCount: (groupName: string, optionName: string) => number;
}

const OptionRecipeContext = createContext<OptionRecipeContextValue | null>(null);

const nameKey = (groupName: string, optionName: string) => `${groupName.trim().toLowerCase()}\u0000${optionName.trim().toLowerCase()}`;

export function OptionRecipeProvider({
  data,
  products,
  children,
}: {
  data: OptionRecipeData | null;
  products: Array<{ isActive: boolean; modifierGroups: Array<{ name: string; options: Array<{ name: string; isActive: boolean }> }> }>;
  children: React.ReactNode;
}) {
  const value = useMemo<OptionRecipeContextValue | null>(() => {
    if (!data) return null;
    const linesByOption = new Map<string, Array<{ ingredientId: string; quantity: number }>>();
    for (const line of data.lines) {
      const list = linesByOption.get(line.optionId);
      if (list) list.push({ ingredientId: line.ingredientId, quantity: line.quantity });
      else linesByOption.set(line.optionId, [{ ingredientId: line.ingredientId, quantity: line.quantity }]);
    }
    const counts = new Map<string, number>();
    for (const product of products) {
      // ตรงกับ SQL: "ใช้กับทุกเมนู" แตะเฉพาะเมนูที่เปิดอยู่
      if (!product.isActive) continue;
      for (const group of product.modifierGroups) {
        for (const option of group.options) {
          if (!option.isActive) continue;
          const key = nameKey(group.name, option.name);
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
      }
    }
    return {
      ingredients: data.ingredients,
      linesByOption,
      sameNameCount: (groupName, optionName) => counts.get(nameKey(groupName, optionName)) ?? 0,
    };
  }, [data, products]);
  return <OptionRecipeContext.Provider value={value}>{children}</OptionRecipeContext.Provider>;
}

interface DraftLine {
  key: string;
  ingredientId: string;
  quantity: string;
}

export function OptionRecipeButton({ optionId, optionName, groupName }: { optionId: string; optionName: string; groupName: string }) {
  const ctx = useContext(OptionRecipeContext);
  const [open, setOpen] = useState(false);
  if (!ctx) return null;
  const count = ctx.linesByOption.get(optionId)?.length ?? 0;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={`min-h-7 rounded-full px-2 text-[11px] font-medium ${count > 0 ? "bg-green-50 text-green-700" : "bg-gray-50 text-gray-600"} hover:bg-gray-100`}
      >
        วัตถุดิบ{count > 0 ? ` (${count})` : ""}
      </button>
      {open && (
        <div className="basis-full">
          <OptionRecipeForm
            key={optionId}
            ctx={ctx}
            optionId={optionId}
            optionName={optionName}
            groupName={groupName}
            onClose={() => setOpen(false)}
          />
        </div>
      )}
    </>
  );
}

function ingredientLabel(i: Ingredient) {
  return `${i.name} (${i.usageUnit})${i.hasPrice ? "" : " · ยังไม่ใส่ราคา"}`;
}

function OptionRecipeForm({
  ctx,
  optionId,
  optionName,
  groupName,
  onClose,
}: {
  ctx: OptionRecipeContextValue;
  optionId: string;
  optionName: string;
  groupName: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const { confirm, confirmDialog } = useConfirm();
  const [isPending, startTransition] = useTransition();
  const [lines, setLines] = useState<DraftLine[]>(() =>
    (ctx.linesByOption.get(optionId) ?? []).map((l, i) => ({ key: `l-${i}`, ingredientId: l.ingredientId, quantity: String(l.quantity) })),
  );
  const [applySameName, setApplySameName] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const sameCount = ctx.sameNameCount(groupName, optionName);
  const byId = useMemo(() => new Map(ctx.ingredients.map((i) => [i.id, i])), [ctx.ingredients]);
  const groups = useMemo(() => {
    const map = new Map<string, Ingredient[]>();
    for (const i of ctx.ingredients) {
      const key = i.category ?? "";
      const list = map.get(key);
      if (list) list.push(i);
      else map.set(key, [i]);
    }
    return [...map.entries()]
      .sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b, "th")))
      .map(([key, items]) => ({ label: key || "ไม่ระบุหมวด", items }));
  }, [ctx.ingredients]);

  async function save() {
    const cleaned = lines.filter((l) => l.ingredientId && l.quantity.trim() !== "");
    const payload = cleaned.map((l) => ({ ingredientId: l.ingredientId, quantity: Number(l.quantity) }));
    if (payload.some((l) => !(l.quantity > 0))) {
      setMessage({ tone: "error", text: "ปริมาณต้องมากกว่า 0" });
      return;
    }
    const applyAll = applySameName && sameCount > 1;
    // ห้ามใช้กล่องยืนยันของเบราว์เซอร์ — WebView แอปมือถือ/iframe บล็อก ใช้ dialog ในแอปแทน
    if (applyAll && payload.length === 0) {
      const ok = await confirm({
        title: "ลบวัตถุดิบทุกเมนู?",
        message: `ลบวัตถุดิบของ "${groupName}: ${optionName}" ออกจากทั้ง ${sameCount} เมนู`,
        confirmLabel: "ลบทั้งหมด",
        danger: true,
      });
      if (!ok) return;
    }
    setMessage(null);
    startTransition(async () => {
      const result = await saveOptionRecipeAction({ optionId, lines: payload, applySameName: applyAll });
      if (result.error) {
        setMessage({ tone: "error", text: result.error });
        return;
      }
      // ฟอร์มที่เปิดค้างต้องแสดงชุดที่บันทึกแล้ว (ตัดบรรทัดว่างทิ้ง) ไม่ใช่ draft เดิม
      setLines(cleaned.map((l, i) => ({ key: `s-${Date.now()}-${i}`, ingredientId: l.ingredientId, quantity: String(Number(l.quantity)) })));
      const n = result.optionCount ?? 1;
      setMessage({ tone: "ok", text: n > 1 ? `บันทึกแล้ว ใช้กับ ${n} เมนู` : "บันทึกแล้ว" });
      router.refresh();
    });
  }

  return (
    <div className="mt-1 space-y-1.5 rounded border border-green-200 bg-green-50/40 p-2">
      <p className="text-[11px] text-gray-600">
        วัตถุดิบที่<strong>บวกเพิ่ม</strong>เมื่อลูกค้าเลือก &quot;{optionName}&quot; (ต่อ 1 ที่) — สูตรหลักแก้ที่หน้า ต้นทุนเมนู
      </p>
      {ctx.ingredients.length === 0 && <p className="text-xs text-amber-700">ยังไม่มีวัตถุดิบ — เพิ่มที่ ต้นทุน → วัตถุดิบ ก่อน</p>}
      {lines.map((line, index) => {
        const ingredient = byId.get(line.ingredientId);
        return (
          <div key={line.key} className="grid grid-cols-[minmax(0,1fr)_80px_auto] gap-1.5">
            <select
              aria-label="วัตถุดิบ"
              value={line.ingredientId}
              style={{ fontSize: 16 }}
              onChange={(e) => setLines((c) => c.map((l, i) => (i === index ? { ...l, ingredientId: e.target.value } : l)))}
              className="min-h-9 rounded border border-gray-300 bg-white px-2"
            >
              <option value="">เลือกวัตถุดิบ</option>
              {line.ingredientId && !ingredient && <option value={line.ingredientId}>วัตถุดิบที่ปิดอยู่</option>}
              {groups.map((g) => (
                <optgroup key={g.label} label={g.label}>
                  {g.items.map((i) => (
                    <option key={i.id} value={i.id}>
                      {ingredientLabel(i)}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            <input
              aria-label={`ปริมาณ (${ingredient?.usageUnit ?? "หน่วย"})`}
              inputMode="decimal"
              placeholder={ingredient?.usageUnit ?? "ปริมาณ"}
              value={line.quantity}
              style={{ fontSize: 16 }}
              onChange={(e) => setLines((c) => c.map((l, i) => (i === index ? { ...l, quantity: e.target.value } : l)))}
              className="min-h-9 rounded border border-gray-300 bg-white px-2"
            />
            <button
              type="button"
              aria-label="ลบบรรทัด"
              onClick={() => setLines((c) => c.filter((_, i) => i !== index))}
              className="min-h-9 px-2 text-xs font-semibold text-red-500"
            >
              ✕
            </button>
          </div>
        );
      })}
      <button
        type="button"
        disabled={ctx.ingredients.length === 0}
        onClick={() => setLines((c) => [...c, { key: `n-${Date.now()}-${c.length}`, ingredientId: "", quantity: "" }])}
        className="min-h-8 text-xs font-semibold text-green-700 disabled:opacity-50"
      >
        + เพิ่มวัตถุดิบ
      </button>
      {sameCount > 1 && (
        <label className="flex min-h-8 items-center gap-1.5 text-xs text-gray-700">
          <input type="checkbox" checked={applySameName} onChange={(e) => setApplySameName(e.target.checked)} />
          ใช้ชุดนี้กับทุกเมนูที่มี &quot;{groupName}: {optionName}&quot; ({sameCount} เมนู — แทนที่ของเดิม)
        </label>
      )}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={save}
          disabled={isPending}
          className="min-h-8 rounded bg-green-700 px-3 text-xs font-semibold text-white hover:bg-green-800 disabled:opacity-50"
        >
          {isPending ? "กำลังบันทึก…" : "บันทึกวัตถุดิบ"}
        </button>
        <button type="button" onClick={onClose} className="min-h-8 px-2 text-xs text-gray-500">
          ปิด
        </button>
      </div>
      {message && (
        <p role="status" className={`text-xs ${message.tone === "ok" ? "text-green-700" : "text-red-600"}`}>
          {message.text}
        </p>
      )}
      {confirmDialog}
    </div>
  );
}
