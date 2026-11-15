"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useConfirm } from "@/shared/components/ui/useConfirm";
import type { TierInitPreview, TierProgram } from "@/modules/member-tiers/repository";
import {
  CYCLE_LABELS,
  METRIC_MODE_LABELS,
  validateTierProgram,
  type TierCycleMonths,
  type TierDefinition,
  type TierMetricMode,
} from "@/modules/member-tiers/rules";
import { initializeTiersAction, saveTierProgramAction, setTierProgramEnabledAction } from "./actions";

const money = (value: number) => new Intl.NumberFormat("th-TH", { maximumFractionDigits: 2 }).format(value);

export function TierProgramManager({ program, defaultTiers }: { program: TierProgram | null; defaultTiers: TierDefinition[] }) {
  const router = useRouter();
  const { confirm, confirmDialog } = useConfirm();
  const [mode, setMode] = useState<TierMetricMode>(program?.metricMode ?? "both");
  const [cycle, setCycle] = useState<TierCycleMonths>(program?.cycleMonths ?? 6);
  const [oneStep, setOneStep] = useState(program?.downgradeOneStep ?? false);
  const [tiers, setTiers] = useState<TierDefinition[]>(program?.tiers.length ? program.tiers : defaultTiers);
  const [initMode, setInitMode] = useState<"zero" | "backfill">("backfill");
  const [preview, setPreview] = useState<TierInitPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const initialized = Boolean(program?.initializedAt);
  const saved = Boolean(program);

  function updateTier(rank: number, patch: Partial<TierDefinition>) {
    setTiers((current) => current.map((tier) => (tier.rank === rank ? { ...tier, ...patch } : tier)));
  }

  function addTier() {
    setTiers((current) => {
      if (current.length >= 6) return current;
      const last = current[current.length - 1];
      return [...current, { rank: current.length, name: `ระดับ ${current.length + 1}`, color: "#7048e8", minSpend: last.minSpend * 2 || 1000, minOrders: last.minOrders * 2 || 5 }];
    });
  }

  function removeTier() {
    setTiers((current) => (current.length <= 2 ? current : current.slice(0, -1)));
  }

  function save() {
    const input = { metricMode: mode, cycleMonths: cycle, downgradeOneStep: oneStep, tiers };
    const invalid = validateTierProgram(input);
    if (invalid) {
      setError(invalid);
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await saveTierProgramAction(input);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setNotice(initialized ? "บันทึกแล้ว — มีผลกับการประเมินครั้งถัดไป" : "บันทึกแล้ว — ขั้นต่อไป เลือกวิธีเริ่มต้นแล้วกดเปิดใช้");
      setPreview(null);
      router.refresh();
    });
  }

  function runPreview(nextMode: "zero" | "backfill") {
    setInitMode(nextMode);
    setError(null);
    startTransition(async () => {
      const result = await initializeTiersAction(nextMode, true);
      if (!result.ok || !result.preview) {
        setError(result.error ?? "คำนวณตัวอย่างไม่สำเร็จ");
        return;
      }
      setPreview(result.preview);
    });
  }

  async function activate() {
    const ok = await confirm({
      title: "เปิดใช้ระดับสมาชิก?",
      message:
        initMode === "backfill"
          ? "ระบบจะตั้งระดับให้สมาชิกเดิมจากยอดซื้อย้อนหลัง และเริ่มนับยอดรอบนี้ทันที — เปิดแล้วเปลี่ยนวิธีเริ่มต้นไม่ได้"
          : "สมาชิกทุกคนเริ่มที่ระดับแรก ยอดเป็นศูนย์ — เปิดแล้วเปลี่ยนวิธีเริ่มต้นไม่ได้",
      confirmLabel: "เปิดใช้",
    });
    if (!ok) return;
    startTransition(async () => {
      const result = await initializeTiersAction(initMode, false);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setNotice(`เปิดใช้ระดับสมาชิกแล้ว (${result.preview?.members ?? 0} คนได้ระดับจากยอดย้อนหลัง)`);
      router.refresh();
    });
  }

  function toggleEnabled(enabled: boolean) {
    startTransition(async () => {
      const result = await setTierProgramEnabledAction(enabled);
      if (!result.ok) setError(result.error);
      else router.refresh();
    });
  }

  const sorted = [...tiers].sort((a, b) => a.rank - b.rank);

  return (
    <div className="space-y-4">
      {notice && <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{notice}</p>}

      {initialized && (
        <div className={`rounded-lg border p-4 ${program?.isEnabled ? "border-emerald-300 bg-emerald-50" : "border-gray-200 bg-white"}`}>
          <div className="flex flex-wrap items-center gap-3">
            <p className="min-w-0 flex-1 font-semibold text-gray-900">
              {program?.isEnabled ? "ระดับสมาชิกเปิดใช้อยู่" : "ระดับสมาชิกปิดอยู่ (หยุดนับยอด ประวัติยังอยู่)"}
            </p>
            <button type="button" className={program?.isEnabled ? "btn-secondary" : "btn-primary"} disabled={pending} onClick={() => toggleEnabled(!program?.isEnabled)}>
              {program?.isEnabled ? "ปิด" : "เปิดใช้"}
            </button>
          </div>
        </div>
      )}

      <div className="space-y-3 rounded-lg border border-gray-200 bg-white p-4">
        <p className="font-semibold text-gray-900">วัดระดับจาก</p>
        {(Object.keys(METRIC_MODE_LABELS) as TierMetricMode[]).map((key) => (
          <label key={key} className="flex items-center gap-2 text-sm">
            <input type="radio" checked={mode === key} onChange={() => setMode(key)} />
            {METRIC_MODE_LABELS[key]}
          </label>
        ))}

        <p className="pt-2 font-semibold text-gray-900">รอบสะสม</p>
        {([3, 6, 12] as TierCycleMonths[]).map((months) => (
          <label key={months} className="flex items-center gap-2 text-sm">
            <input type="radio" checked={cycle === months} disabled={initialized} onChange={() => setCycle(months)} />
            {CYCLE_LABELS[months]}
          </label>
        ))}
        {initialized && <p className="text-xs text-gray-500">เปลี่ยนความยาวรอบหลังเปิดใช้แล้วไม่ได้</p>}

        <label className="flex items-center gap-2 pt-2 text-sm">
          <input type="checkbox" checked={oneStep} onChange={(e) => setOneStep(e.target.checked)} />
          ครบรอบแล้วยอดไม่ถึง ลดได้ทีละ 1 ระดับเท่านั้น (ปิด = ลดไประดับที่ยอดถึง แบบ Shopee)
        </label>
      </div>

      <div className="space-y-2 rounded-lg border border-gray-200 bg-white p-4">
        <p className="font-semibold text-gray-900">ระดับและเกณฑ์ต่อรอบ</p>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500">
                <th className="py-1">สี</th>
                <th className="py-1">ชื่อระดับ</th>
                <th className="py-1">ยอดซื้อขั้นต่ำ (บาท)</th>
                <th className="py-1">จำนวนบิลขั้นต่ำ</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((tier) => (
                <tr key={tier.rank} className="border-t border-gray-100">
                  <td className="py-2">
                    <input type="color" value={tier.color} onChange={(e) => updateTier(tier.rank, { color: e.target.value })} aria-label={`สี ${tier.name}`} />
                  </td>
                  <td className="py-2 pr-2">
                    <input className="input w-full" style={{ fontSize: 16 }} value={tier.name} maxLength={40} onChange={(e) => updateTier(tier.rank, { name: e.target.value })} />
                  </td>
                  <td className="py-2 pr-2">
                    {tier.rank === 0 ? (
                      <span className="text-gray-500">— (ทุกคนเริ่มที่นี่)</span>
                    ) : (
                      <input className="input w-32" style={{ fontSize: 16 }} inputMode="decimal" value={String(tier.minSpend)}
                        disabled={mode === "orders"}
                        onChange={(e) => updateTier(tier.rank, { minSpend: Number(e.target.value.replace(/[^0-9.]/g, "")) || 0 })} />
                    )}
                  </td>
                  <td className="py-2">
                    {tier.rank === 0 ? (
                      <span className="text-gray-500">—</span>
                    ) : (
                      <input className="input w-24" style={{ fontSize: 16 }} inputMode="numeric" value={String(tier.minOrders)}
                        disabled={mode === "spend"}
                        onChange={(e) => updateTier(tier.rank, { minOrders: Number(e.target.value.replace(/[^0-9]/g, "")) || 0 })} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex gap-2">
          <button type="button" className="btn-secondary text-sm" disabled={tiers.length >= 6} onClick={addTier}>+ เพิ่มระดับ</button>
          <button type="button" className="btn-secondary text-sm" disabled={tiers.length <= 2} onClick={removeTier}>− ลบระดับสุดท้าย</button>
        </div>
      </div>

      {error && <p className="alert-danger text-sm" role="alert">{error}</p>}
      <button type="button" className="btn-primary" disabled={pending} onClick={save}>
        {pending ? "กำลังบันทึก…" : "บันทึกการตั้งค่า"}
      </button>

      {saved && !initialized && (
        <div className="space-y-3 rounded-lg border border-violet-200 bg-violet-50 p-4">
          <p className="font-semibold text-violet-900">เปิดใช้ครั้งแรก — เลือกวิธีเริ่มต้น</p>
          <label className="flex items-start gap-2 text-sm">
            <input type="radio" className="mt-1" checked={initMode === "backfill"} onChange={() => runPreview("backfill")} />
            <span>
              <b>คำนวณจากยอดย้อนหลัง</b> — ระดับเริ่มต้นจากยอดรอบที่แล้ว และนับยอดรอบนี้ต่อจากที่มีอยู่
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input type="radio" className="mt-1" checked={initMode === "zero"} onChange={() => runPreview("zero")} />
            <span>
              <b>เริ่มจากศูนย์</b> — ทุกคนเริ่มที่ {sorted[0]?.name ?? "ระดับแรก"} ยอดเป็นศูนย์
            </span>
          </label>
          {!preview && (
            <button type="button" className="btn-secondary text-sm" disabled={pending} onClick={() => runPreview(initMode)}>
              ดูตัวอย่างจำนวนคนต่อระดับ
            </button>
          )}
          {preview && (
            <div className="rounded-lg bg-white p-3 text-sm">
              <p className="text-gray-700">
                รอบนี้เริ่ม {preview.cycleStart} · รอบที่แล้วเริ่ม {preview.previousCycleStart}
              </p>
              <ul className="mt-1 space-y-0.5">
                {sorted
                  .filter((tier) => tier.rank > 0)
                  .map((tier) => (
                    <li key={tier.rank}>
                      {tier.name}: <b>{money(preview.counts[String(tier.rank)] ?? 0)}</b> คน
                    </li>
                  ))}
              </ul>
              <p className="mt-1 text-xs text-gray-500">สมาชิกที่เหลือเริ่มที่ {sorted[0]?.name}</p>
            </div>
          )}
          <button type="button" className="btn-primary" disabled={pending || !preview} onClick={activate}>
            เปิดใช้ระดับสมาชิก
          </button>
        </div>
      )}
      {confirmDialog}
    </div>
  );
}
