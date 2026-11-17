"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  EMPTY_MISSION_INPUT,
  MISSION_TEMPLATES,
  rewardLabel,
  validateMissionInput,
  type Mission,
  type MissionInput,
  type MissionStats,
} from "@/modules/missions/rules";
import { saveMissionAction, setMissionsEnabledAction } from "./actions";

interface ProductOption {
  id: string;
  name: string;
  price: number;
  categoryId: string;
}

interface Props {
  enabled: boolean;
  missions: { mission: Mission; stats: MissionStats }[];
  products: ProductOption[];
  categories: { id: string; name: string }[];
}

/** ค่าในฟอร์มเก็บเป็น string เพื่อให้พิมพ์ลบได้ แล้วแปลงตอนบันทึก */
interface Draft {
  id: string | null;
  input: MissionInput;
  targetCount: string;
  maxPerOrder: string;
  durationDays: string;
  joinEndsAt: string;
  maxParticipants: string;
  rewardDiscountValue: string;
  rewardMinSubtotal: string;
  rewardValidDays: string;
}

const inputStyle = { fontSize: 16 };

function toDraft(id: string | null, input: MissionInput): Draft {
  return {
    id,
    input,
    targetCount: String(input.targetCount),
    maxPerOrder: input.maxPerOrder === null ? "" : String(input.maxPerOrder),
    durationDays: input.durationDays === null ? "" : String(input.durationDays),
    joinEndsAt: input.joinEndsAt ? input.joinEndsAt.slice(0, 10) : "",
    maxParticipants: input.maxParticipants === null ? "" : String(input.maxParticipants),
    rewardDiscountValue: input.rewardDiscountValue === null ? "" : String(input.rewardDiscountValue),
    rewardMinSubtotal: String(input.rewardMinSubtotal),
    rewardValidDays: String(input.rewardValidDays),
  };
}

const intOrNull = (value: string) => (value.trim() === "" ? null : Number(value));

/** วันปิดภารกิจ = สิ้นวันที่เลือก เวลาไทย */
function endOfThaiDay(date: string): string | null {
  if (!date) return null;
  return new Date(`${date}T23:59:59+07:00`).toISOString();
}

function fromDraft(draft: Draft): MissionInput {
  return {
    ...draft.input,
    targetCount: Number(draft.targetCount),
    maxPerOrder: intOrNull(draft.maxPerOrder),
    durationDays: intOrNull(draft.durationDays),
    joinEndsAt: endOfThaiDay(draft.joinEndsAt),
    maxParticipants: intOrNull(draft.maxParticipants),
    rewardDiscountValue: draft.input.rewardType === "discount" ? intOrNull(draft.rewardDiscountValue) : null,
    rewardMinSubtotal: draft.rewardMinSubtotal.trim() === "" ? 0 : Number(draft.rewardMinSubtotal),
    rewardValidDays: Number(draft.rewardValidDays),
  };
}

function formatDate(iso: string | null) {
  if (!iso) return "ไม่มีกำหนด";
  return new Date(iso).toLocaleDateString("th-TH", { day: "numeric", month: "short", year: "2-digit", timeZone: "Asia/Bangkok" });
}

export function MissionManager({ enabled, missions, products, categories }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const productName = useMemo(() => new Map(products.map((p) => [p.id, p.name])), [products]);
  const categoryName = useMemo(() => new Map(categories.map((c) => [c.id, c.name])), [categories]);

  function patch(next: Partial<MissionInput>) {
    setDraft((d) => (d ? { ...d, input: { ...d.input, ...next } } : d));
  }
  function patchField<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((d) => (d ? { ...d, [key]: value } : d));
  }

  function toggleEnabled() {
    setError(null);
    startTransition(async () => {
      const res = await setMissionsEnabledAction(!enabled);
      if (!res.ok) setError(res.error);
      else router.refresh();
    });
  }

  function save() {
    if (!draft) return;
    const input = fromDraft(draft);
    const invalid = validateMissionInput(input);
    if (invalid) {
      setError(invalid);
      return;
    }
    setError(null);
    startTransition(async () => {
      const res = await saveMissionAction(draft.id, input);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setMessage(draft.id ? "บันทึกภารกิจแล้ว" : "สร้างภารกิจแล้ว");
      setDraft(null);
      router.refresh();
    });
  }

  const filteredProducts = products.filter((p) => !search.trim() || p.name.toLowerCase().includes(search.trim().toLowerCase()));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-gray-200 bg-white p-4">
        <div>
          <p className="font-semibold text-gray-900">ภารกิจสะสมของสาขานี้: {enabled ? "เปิดอยู่" : "ปิดอยู่"}</p>
          <p className="text-xs text-gray-600">ปิดแล้วลูกค้าจะไม่เห็นภารกิจและบิลใหม่จะไม่ถูกนับ (คูปองที่ได้ไปแล้วยังใช้ได้)</p>
        </div>
        <button type="button" className={enabled ? "btn-secondary" : "btn-primary"} disabled={pending} onClick={toggleEnabled}>
          {enabled ? "ปิดภารกิจ" : "เปิดภารกิจ"}
        </button>
      </div>

      {error && <p className="alert-danger" role="alert">{error}</p>}
      {message && !draft && <p className="alert-success">{message}</p>}

      {!draft && (
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn-primary" onClick={() => { setMessage(null); setDraft(toDraft(null, EMPTY_MISSION_INPUT)); }}>
            + สร้างภารกิจ
          </button>
          {MISSION_TEMPLATES.map((t) => (
            <button
              key={t.key}
              type="button"
              className="btn-secondary text-sm"
              onClick={() => { setMessage(null); setDraft(toDraft(null, { ...EMPTY_MISSION_INPUT, ...t.input })); }}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}

      {draft && (
        <div className="space-y-4 rounded-lg border border-gray-200 bg-white p-4">
          <p className="font-semibold text-gray-900">{draft.id ? "แก้ภารกิจ" : "สร้างภารกิจใหม่"}</p>

          <label className="block text-sm">
            <span className="field-label">ชื่อภารกิจ (ลูกค้าเห็น)</span>
            <input className="input mt-1 w-full" style={inputStyle} maxLength={80} value={draft.input.name} onChange={(e) => patch({ name: e.target.value })} />
          </label>
          <label className="block text-sm">
            <span className="field-label">คำอธิบาย (ไม่บังคับ)</span>
            <textarea className="input mt-1 w-full" style={inputStyle} rows={2} maxLength={300} value={draft.input.description} onChange={(e) => patch({ description: e.target.value })} />
          </label>

          <div className="text-sm">
            <span className="field-label">นับสินค้าอะไร</span>
            <div className="mt-1 flex flex-wrap gap-2">
              {([["all", "ทุกเมนู"], ["categories", "เลือกหมวด"], ["products", "เลือกเมนู"]] as const).map(([value, label]) => (
                <button key={value} type="button" className={draft.input.scope === value ? "btn-primary text-sm" : "btn-secondary text-sm"} onClick={() => patch({ scope: value })}>
                  {label}
                </button>
              ))}
            </div>
            {draft.input.scope === "categories" && (
              <div className="mt-2 flex flex-wrap gap-2">
                {categories.map((c) => {
                  const on = draft.input.categoryIds.includes(c.id);
                  return (
                    <label key={c.id} className={`cursor-pointer rounded-lg border px-3 py-1.5 ${on ? "border-[var(--color-brand)] bg-[var(--color-brand-soft)]" : "border-gray-200"}`}>
                      <input type="checkbox" className="mr-1" checked={on} onChange={() => patch({ categoryIds: on ? draft.input.categoryIds.filter((id) => id !== c.id) : [...draft.input.categoryIds, c.id] })} />
                      {c.name}
                    </label>
                  );
                })}
              </div>
            )}
            {draft.input.scope === "products" && (
              <div className="mt-2">
                <input className="input w-full" style={inputStyle} placeholder="ค้นเมนู" value={search} onChange={(e) => setSearch(e.target.value)} />
                <div className="mt-2 max-h-56 overflow-y-auto rounded-lg border border-gray-200">
                  {filteredProducts.map((p) => {
                    const on = draft.input.productIds.includes(p.id);
                    return (
                      <label key={p.id} className="flex cursor-pointer items-center gap-2 border-b border-gray-100 px-3 py-2 last:border-0">
                        <input type="checkbox" checked={on} onChange={() => patch({ productIds: on ? draft.input.productIds.filter((id) => id !== p.id) : [...draft.input.productIds, p.id] })} />
                        <span className="flex-1">{p.name}</span>
                        <span className="text-xs text-gray-500">{categoryName.get(p.categoryId) ?? ""}</span>
                      </label>
                    );
                  })}
                </div>
                <p className="mt-1 text-xs text-gray-500">เลือกแล้ว {draft.input.productIds.length} เมนู</p>
              </div>
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <label className="block text-sm">
              <span className="field-label">เป้าหมาย (ชิ้น)</span>
              <input className="input mt-1 w-full" style={inputStyle} inputMode="numeric" value={draft.targetCount} onChange={(e) => patchField("targetCount", e.target.value)} />
            </label>
            <label className="block text-sm">
              <span className="field-label">นับได้สูงสุดต่อบิล (ว่าง = ไม่จำกัด)</span>
              <input className="input mt-1 w-full" style={inputStyle} inputMode="numeric" value={draft.maxPerOrder} onChange={(e) => patchField("maxPerOrder", e.target.value)} />
            </label>
            <label className="block text-sm">
              <span className="field-label">ทำให้ครบภายใน (วันหลังกดรับ)</span>
              <input className="input mt-1 w-full" style={inputStyle} inputMode="numeric" placeholder="เช่น 30" value={draft.durationDays} onChange={(e) => patchField("durationDays", e.target.value)} />
            </label>
            <label className="block text-sm">
              <span className="field-label">วันปิดภารกิจ (ไม่บังคับ)</span>
              <input type="date" className="input mt-1 w-full" style={inputStyle} value={draft.joinEndsAt} onChange={(e) => patchField("joinEndsAt", e.target.value)} />
            </label>
            <label className="block text-sm">
              <span className="field-label">จำนวนผู้รับสูงสุด (ว่าง = ไม่จำกัด)</span>
              <input className="input mt-1 w-full" style={inputStyle} inputMode="numeric" value={draft.maxParticipants} onChange={(e) => patchField("maxParticipants", e.target.value)} />
            </label>
            <label className="flex items-center gap-2 text-sm sm:pt-6">
              <input type="checkbox" checked={draft.input.repeatable} onChange={(e) => patch({ repeatable: e.target.checked })} />
              ครบแล้วให้กดรับรอบใหม่ได้
            </label>
          </div>

          <div className="space-y-2 rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm">
            <span className="field-label">รางวัลเมื่อทำครบ</span>
            <div className="flex flex-wrap gap-2">
              <button type="button" className={draft.input.rewardType === "product" ? "btn-primary text-sm" : "btn-secondary text-sm"} onClick={() => patch({ rewardType: "product" })}>เมนูฟรี 1 ชิ้น</button>
              <button type="button" className={draft.input.rewardType === "discount" ? "btn-primary text-sm" : "btn-secondary text-sm"} onClick={() => patch({ rewardType: "discount", rewardDiscountKind: draft.input.rewardDiscountKind ?? "amount" })}>คูปองส่วนลด</button>
            </div>
            {draft.input.rewardType === "product" ? (
              <label className="block">
                <span className="text-xs text-gray-600">เมนูที่ได้ฟรี</span>
                <select className="input mt-1 w-full" style={inputStyle} value={draft.input.rewardProductId ?? ""} onChange={(e) => patch({ rewardProductId: e.target.value || null })}>
                  <option value="">— เลือกเมนู —</option>
                  {products.map((p) => <option key={p.id} value={p.id}>{p.name} (฿{p.price})</option>)}
                </select>
                <span className="text-xs text-gray-500">ตัวเลือกเสริมที่มีราคา (เช่น ไซซ์ใหญ่) ลูกค้าจ่ายส่วนต่าง</span>
              </label>
            ) : (
              <div className="grid gap-3 sm:grid-cols-3">
                <label className="block">
                  <span className="text-xs text-gray-600">ชนิด</span>
                  <select className="input mt-1 w-full" style={inputStyle} value={draft.input.rewardDiscountKind ?? "amount"} onChange={(e) => patch({ rewardDiscountKind: e.target.value as "amount" | "percentage" })}>
                    <option value="amount">ลดเป็นบาท</option>
                    <option value="percentage">ลดเป็น %</option>
                  </select>
                </label>
                <label className="block">
                  <span className="text-xs text-gray-600">มูลค่า</span>
                  <input className="input mt-1 w-full" style={inputStyle} inputMode="decimal" value={draft.rewardDiscountValue} onChange={(e) => patchField("rewardDiscountValue", e.target.value)} />
                </label>
                <label className="block">
                  <span className="text-xs text-gray-600">ยอดซื้อขั้นต่ำ (บาท)</span>
                  <input className="input mt-1 w-full" style={inputStyle} inputMode="decimal" value={draft.rewardMinSubtotal} onChange={(e) => patchField("rewardMinSubtotal", e.target.value)} />
                </label>
              </div>
            )}
            <label className="block w-48">
              <span className="text-xs text-gray-600">คูปองใช้ได้ (วัน)</span>
              <input className="input mt-1 w-full" style={inputStyle} inputMode="numeric" value={draft.rewardValidDays} onChange={(e) => patchField("rewardValidDays", e.target.value)} />
            </label>
          </div>

          {draft.id && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={draft.input.status === "ended"} onChange={(e) => patch({ status: e.target.checked ? "ended" : "active" })} />
              ปิดภารกิจนี้ (ไม่รับคนใหม่และหยุดนับ — คูปองที่ได้ไปแล้วยังใช้ได้)
            </label>
          )}

          <p className="text-xs text-gray-500">แก้เป้าหมาย/เพดาน มีผลกับคนที่กดรับหลังจากนี้ · คนที่ทำอยู่ใช้ค่าเดิมจนจบรอบ</p>
          <div className="flex gap-2">
            <button type="button" className="btn-primary" disabled={pending} onClick={save}>{pending ? "กำลังบันทึก…" : "บันทึก"}</button>
            <button type="button" className="btn-secondary" disabled={pending} onClick={() => { setDraft(null); setError(null); }}>ยกเลิก</button>
          </div>
        </div>
      )}

      <div className="space-y-2">
        {missions.length === 0 && <p className="text-sm text-gray-500">ยังไม่มีภารกิจ — เริ่มจากเทมเพลตด้านบนได้</p>}
        {missions.map(({ mission, stats }) => (
          <div key={mission.id} className="rounded-lg border border-gray-200 bg-white p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <p className="font-semibold text-gray-900">
                  {mission.name}{" "}
                  <span className={`ml-1 rounded-full px-2 py-0.5 text-xs ${mission.status === "active" ? "bg-emerald-50 text-emerald-700" : "bg-gray-100 text-gray-600"}`}>
                    {mission.status === "active" ? "เปิดอยู่" : "ปิดแล้ว"}
                  </span>
                </p>
                <p className="text-xs text-gray-600">
                  {mission.targetCount} ชิ้น
                  {mission.maxPerOrder ? ` · สูงสุด ${mission.maxPerOrder}/บิล` : ""}
                  {mission.durationDays ? ` · ภายใน ${mission.durationDays} วัน` : ""}
                  {" · ปิด "}{formatDate(mission.joinEndsAt)}
                  {mission.repeatable ? " · ทำซ้ำได้" : ""}
                  {" · รางวัล: "}{rewardLabel(mission, mission.rewardProductId ? productName.get(mission.rewardProductId) : null)}
                </p>
              </div>
              <button type="button" className="btn-secondary text-sm" onClick={() => { setMessage(null); setDraft(toDraft(mission.id, mission)); }}>แก้</button>
            </div>
            <div className="mt-3 grid grid-cols-4 gap-2 text-center text-sm">
              {([["กดรับ (คน)", stats.joined], ["กำลังทำ", stats.active], ["ทำครบ", stats.completed], ["ใช้คูปองแล้ว", stats.rewardsUsed]] as const).map(([label, value]) => (
                <div key={label} className="rounded-lg bg-gray-50 p-2">
                  <p className="text-lg font-bold text-gray-900">{value}</p>
                  <p className="text-xs text-gray-600">{label}</p>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
