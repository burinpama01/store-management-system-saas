"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import {
  actualUnitsPerMonth,
  BUDGET_PRESETS,
  breakEvenUnits,
  COST_TYPE_LABELS,
  COST_TYPES,
  FIXED_COST_TYPES,
  laborDoubleCountRisk,
  MIN_COVERAGE_PCT,
  mixContribution,
  monthlyDepreciation,
  monthlyProfit,
  netProfitAt,
  overheadPerUnit,
  paybackMonths,
  priceLadder,
  summarizeFixedCosts,
  type BudgetKind,
  type CostBudget,
  type CostType,
  type MixRow,
} from "@/modules/costing/break-even";
import type { ExpenseCategory } from "@/modules/costing/break-even-repository";
import type { StoreCostSettings } from "@/modules/costing/types";
import { useConfirm } from "@/shared/components/ui/useConfirm";
import {
  deleteCostBudgetAction,
  saveBreakEvenSettingsAction,
  saveCostBudgetAction,
  setCategoryCostTypeAction,
} from "./actions";

export interface PlannerProduct {
  id: string;
  name: string;
  price: number;
  unitCost: number | null;
}

interface Props {
  canEdit: boolean;
  settings: StoreCostSettings;
  budgets: CostBudget[];
  budgetsError: string | null;
  mix: MixRow[];
  /** จำนวนวันปฏิทินของช่วงยอดขาย */
  windowDays: number;
  salesError: string | null;
  salesRangeLabel: string;
  products: PlannerProduct[];
  categories: ExpenseCategory[];
  categoriesError: string | null;
  actual: { byType: Partial<Record<CostType, number>>; unmapped: number; count: number; label: string } | null;
  payroll: { netPay: number; periodStart: string; periodEnd: string } | null;
}

const INPUT = "w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[var(--ink)]";
// 16px กัน iOS ซูมตอนแตะช่อง (global input ใช้ font: inherit)
const INPUT_STYLE = { fontSize: 16 } as const;
const CARD = "rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4";

const baht = (n: number, digits = 0) => `฿${n.toLocaleString("th-TH", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
const units = (n: number) => n.toLocaleString("th-TH", { maximumFractionDigits: 1 });

type Draft = { id: string | null; kind: BudgetKind; costType: CostType; name: string; amount: string; life: string; isActive: boolean };
const emptyDraft = (kind: BudgetKind): Draft => ({ id: null, kind, costType: kind === "startup" ? "maintenance" : "rent", name: "", amount: "", life: kind === "startup" ? "60" : "", isActive: true });

export function BreakEvenPlanner(props: Props) {
  const { settings, canEdit } = props;
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const { confirm, confirmDialog } = useConfirm();

  const fixed = useMemo(() => summarizeFixedCosts(props.budgets), [props.budgets]);
  const mix = useMemo(() => mixContribution(props.mix, settings.otherVariablePct), [props.mix, settings.otherVariablePct]);
  const actualUnits = actualUnitsPerMonth(mix.totalQty, props.windowDays, settings.openDaysPerMonth);

  // เมนูตัวแทน (ใช้เมื่อยังไม่มียอดขายที่มีสูตร หรือผู้ใช้อยากดูเมนูเดียวแบบในคลิป)
  const costedProducts = props.products.filter((p) => p.unitCost !== null && p.price > 0);
  const [basisChoice, setBasis] = useState<"mix" | string>(mix.avgContribution !== null ? "mix" : (costedProducts[0]?.id ?? "mix"));
  // ค่าที่เลือกไว้อาจใช้ไม่ได้หลัง revalidate (เมนูถูกลบสูตร / ยังไม่มียอด) → ใช้ค่าที่ใช้ได้ ให้ select กับตัวเลขตรงกันเสมอ
  const fallbackBasis = mix.avgContribution !== null ? "mix" : (costedProducts[0]?.id ?? "mix");
  const basisValid = basisChoice === "mix" ? mix.avgContribution !== null : costedProducts.some((p) => p.id === basisChoice);
  const basis = basisValid ? basisChoice : fallbackBasis;
  const basisProduct = basis === "mix" ? null : (costedProducts.find((p) => p.id === basis) ?? null);
  const contribution =
    basisProduct && basisProduct.unitCost !== null
      ? basisProduct.price - basisProduct.unitCost - (basisProduct.price * settings.otherVariablePct) / 100
      : mix.avgContribution;
  const lowCoverage = basis === "mix" && mix.avgContribution !== null && mix.coveragePct < MIN_COVERAGE_PCT;

  const be = breakEvenUnits({
    fixedMonthly: fixed.total,
    contribution,
    targetProfitMonthly: settings.targetProfitMonthly,
    openDaysPerMonth: settings.openDaysPerMonth,
  });

  // what-if: จำนวนชิ้น/วัน และราคาเปลี่ยน %
  const [whatIfDay, setWhatIfDay] = useState<string>(String(Math.round(actualUnits?.perDay ?? be.dayUnits ?? 50)));
  const [priceChange, setPriceChange] = useState<string>("0");
  const whatIfUnitsDay = Math.max(0, Number(whatIfDay) || 0);
  const priceDelta = Number(priceChange) || 0;
  const basePrice = basisProduct ? basisProduct.price : (mix.avgPrice ?? 0);
  const whatIfContribution = contribution === null ? null : contribution + basePrice * (priceDelta / 100) * (1 - settings.otherVariablePct / 100);
  const whatIfMonthUnits = whatIfUnitsDay * settings.openDaysPerMonth;
  const whatIfProfit = whatIfContribution === null ? null : monthlyProfit(whatIfMonthUnits, whatIfContribution, fixed.total);

  // ต้นทุนดำเนินการต่อชิ้น: ยอดจริงก่อน ไม่มีใช้ตัวเลข what-if
  const unitsForOverhead = actualUnits?.perMonth ?? whatIfMonthUnits;
  const overhead = overheadPerUnit(fixed.total, unitsForOverhead);
  const currentProfit = actualUnits && contribution !== null ? monthlyProfit(actualUnits.perMonth, contribution, fixed.total) : null;
  const payback = currentProfit === null ? null : paybackMonths(fixed.startupTotal, currentProfit);

  const run = (task: () => Promise<{ error: string | null }>, okText: string, after?: () => void) => {
    setMessage(null);
    startTransition(async () => {
      const result = await task();
      if (result.error) setMessage({ tone: "error", text: result.error });
      else {
        setMessage({ tone: "ok", text: okText });
        after?.();
      }
    });
  };

  const submitDraft = () => {
    if (!draft) return;
    const amount = Number(draft.amount);
    const life = draft.kind === "startup" && draft.life.trim() !== "" ? Number(draft.life) : null;
    run(
      () =>
        saveCostBudgetAction({
          id: draft.id,
          kind: draft.kind,
          costType: draft.costType,
          name: draft.name,
          amount: Number.isFinite(amount) ? amount : -1,
          usefulLifeMonths: life,
          isActive: draft.isActive,
        }),
      "บันทึกรายการแล้ว",
      () => setDraft(null),
    );
  };

  const removeBudget = async (b: CostBudget) => {
    const ok = await confirm({
      title: `ลบ ${b.name}?`,
      message: "ลบแล้วกู้คืนไม่ได้ — ถ้าแค่ไม่อยากนับชั่วคราว ให้กด “ปิด” แทน",
      confirmLabel: "ลบ",
      danger: true,
    });
    if (ok) run(() => deleteCostBudgetAction(b.id), "ลบรายการแล้ว");
  };

  const monthlyBudgets = props.budgets.filter((b) => b.kind === "monthly");
  const startupBudgets = props.budgets.filter((b) => b.kind === "startup");
  const hasBudgets = props.budgets.length > 0;
  const doubleLabor = props.actual ? laborDoubleCountRisk({ byType: props.actual.byType, unmapped: props.actual.unmapped, payrollNet: props.payroll?.netPay ?? null }) : false;

  // ---------- การ์ดคำตอบ ----------
  let answer: React.ReactNode;
  if (!hasBudgets || fixed.total <= 0) {
    answer = <p className="text-sm text-[var(--muted)]">เริ่มจากใส่ต้นทุนคงที่รายเดือนด้านล่าง (ค่าเช่า น้ำไฟ ค่าแรง ฯลฯ) แล้วระบบจะคำนวณจำนวนที่ต้องขายให้</p>;
  } else if (contribution === null) {
    answer = (
      <p className="text-sm text-[var(--muted)]">
        ยังไม่มีเมนูที่ตั้งสูตรต้นทุน — <Link className="font-semibold text-[var(--tenant-primary)]" href="/costing/menu">ตั้งสูตรเมนู</Link> อย่างน้อย 1 เมนูเพื่อคำนวณกำไรต่อชิ้น
      </p>
    );
  } else if (be.monthUnits === null) {
    answer = <p className="text-sm font-semibold text-red-700">⚠ กำไรต่อชิ้นติดลบหรือเป็นศูนย์ ({baht(contribution, 2)}) — ขายเท่าไรก็ไม่คุ้มทุน ต้องขึ้นราคาหรือลดต้นทุนวัตถุดิบก่อน</p>;
  } else {
    const perDay = actualUnits?.perDay ?? null;
    const gap = perDay !== null && be.dayUnits !== null ? be.dayUnits - perDay : null;
    const progress = perDay !== null && be.dayUnits ? Math.min(100, (perDay / be.dayUnits) * 100) : 0;
    answer = (
      <>
        <p className="text-sm text-[var(--muted)]">ต้องขายวันละ (คุ้มทุน)</p>
        <p className="text-4xl font-extrabold tabular-nums text-[var(--ink)]">{units(be.dayUnits ?? 0)} ชิ้น</p>
        <p className="text-sm text-[var(--muted)]">
          = {units(be.monthUnits)} ชิ้น/เดือน · เปิดร้าน {settings.openDaysPerMonth} วัน
        </p>
        {perDay !== null && (
          <>
            <div className="mt-3 h-2.5 overflow-hidden rounded-full bg-[var(--surface-muted)]" role="img" aria-label={`ขายจริง ${units(perDay)} จาก ${be.dayUnits} ชิ้นต่อวัน`}>
              <div className="h-full rounded-full bg-emerald-600" style={{ width: `${progress}%` }} />
            </div>
            <p className="mt-2 text-sm text-[var(--ink)]">
              ขายจริงเฉลี่ย <b className="tabular-nums">{units(perDay)}</b> ชิ้น/วันเปิดร้าน (จากยอด 30 วันล่าสุด) ·{" "}
              {gap !== null && gap > 0 ? (
                <b className="text-orange-700">▼ ขาดอีก {units(gap)} ชิ้น/วัน</b>
              ) : (
                <b className="text-emerald-700">✓ เกินจุดคุ้มทุนแล้ว</b>
              )}
            </p>
          </>
        )}
        {settings.targetProfitMonthly > 0 && be.targetDayUnits !== null && (
          <p className="mt-1 text-sm text-[var(--ink)]">
            ถึงเป้ากำไร {baht(settings.targetProfitMonthly)}/เดือน: <b className="tabular-nums">{units(be.targetDayUnits)} ชิ้น/วัน</b>
          </p>
        )}
      </>
    );
  }

  const stats: Array<{ label: string; value: string; hint?: string }> = [
    { label: "ต้นทุนคงที่/เดือน", value: baht(fixed.total), hint: fixed.depreciation > 0 ? `รวมค่าเสื่อม ${baht(fixed.depreciation)}` : undefined },
    { label: "กำไรส่วนเกินเฉลี่ย/ชิ้น", value: contribution === null ? "—" : baht(contribution, 2), hint: basisProduct ? `เมนู ${basisProduct.name}` : "ถ่วงตามยอดขายจริง" },
    { label: "ต้นทุนดำเนินการ/ชิ้น", value: overhead === null ? "—" : baht(overhead, 2), hint: unitsForOverhead > 0 ? `ที่ ${units(unitsForOverhead)} ชิ้น/เดือน` : undefined },
    {
      label: "คืนทุน (ยอดปัจจุบัน)",
      value: fixed.startupTotal <= 0 ? "—" : payback === null ? "ยังไม่คืนทุน" : `${payback} เดือน`,
      hint: fixed.startupTotal > 0 ? `เงินลงทุน ${baht(fixed.startupTotal)}` : "ใส่เงินลงทุนเพื่อดูระยะคืนทุน",
    },
  ];

  return (
    <div className="space-y-5">
      {confirmDialog}
      {message && (
        <p role="status" className={`rounded-lg px-3 py-2 text-sm ${message.tone === "ok" ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-800"}`}>
          {message.text}
        </p>
      )}

      <section className={CARD} aria-labelledby="be-answer">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="be-answer" className="text-base font-semibold text-[var(--ink)]">
            คำตอบ
          </h2>
          <label className="flex items-center gap-2 text-sm text-[var(--muted)]">
            คิดจาก
            <select className={`${INPUT} w-auto py-1`} style={INPUT_STYLE} value={basis} onChange={(e) => setBasis(e.target.value)}>
              <option value="mix" disabled={mix.avgContribution === null}>
                ทุกเมนูตามยอดขายจริง
              </option>
              {costedProducts.map((p) => (
                <option key={p.id} value={p.id}>
                  เมนูเดียว: {p.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="mt-2">{answer}</div>
      </section>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((s) => (
          <div key={s.label} className={CARD}>
            <p className="text-sm text-[var(--muted)]">{s.label}</p>
            <p className="mt-1 text-2xl font-bold tabular-nums text-[var(--ink)]">{s.value}</p>
            {s.hint && <p className="mt-0.5 text-xs text-[var(--muted)]">{s.hint}</p>}
          </div>
        ))}
      </div>

      {/* คำเตือน */}
      <div className="space-y-2">
        {props.salesError && <Notice>โหลดยอดขายไม่สำเร็จ: {props.salesError}</Notice>}
        {props.budgetsError && <Notice>โหลดรายการต้นทุนไม่สำเร็จ: {props.budgetsError}</Notice>}
        {lowCoverage && (
          <Notice>
            ⚠ เมนูที่มีสูตรคิดเป็นเพียง {mix.coveragePct}% ของจำนวนที่ขาย — ตัวเลขยังไม่แม่น{" "}
            <Link className="font-semibold underline" href="/costing/menu">
              ตั้งสูตรเมนูขายดี
            </Link>
          </Notice>
        )}
        {basis === "mix" && mix.negative.length > 0 && (
          <Notice>⚠ ขายแล้วขาดทุนตั้งแต่ต้นทุนวัตถุดิบ: {mix.negative.slice(0, 5).map((n) => `${n.name} (${baht(n.contribution, 2)}/ชิ้น)`).join(", ")}</Notice>
        )}
        {fixed.skippedVariable > 0 && <Notice>มี {fixed.skippedVariable} รายการรายเดือนเป็นประเภทวัตถุดิบ/บรรจุภัณฑ์ — ไม่นับเป็นต้นทุนคงที่ เพราะคิดในต้นทุนต่อชิ้นแล้ว</Notice>}
        {doubleLabor && <Notice>⚠ มีทั้งรายจ่ายหมวดค่าแรงและเงินเดือนจากระบบเงินเดือน — ระวังนับค่าแรงซ้ำเมื่อนำไปตั้งงบ</Notice>}
      </div>

      {/* ต้นทุนคงที่รายเดือน */}
      <section className={CARD} aria-labelledby="be-monthly">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="be-monthly" className="text-base font-semibold text-[var(--ink)]">
            ต้นทุนคงที่รายเดือน
          </h2>
          {canEdit && (
            <button type="button" className="btn-primary min-h-10" onClick={() => setDraft(emptyDraft("monthly"))} disabled={pending}>
              + เพิ่มรายการ
            </button>
          )}
        </div>
        <BudgetList items={monthlyBudgets} canEdit={canEdit} pending={pending} onEdit={(b) => setDraft(toDraft(b))} onToggle={(b) => run(() => saveCostBudgetAction({ ...b, isActive: !b.isActive }), b.isActive ? "ปิดรายการแล้ว" : "เปิดรายการแล้ว")} onDelete={removeBudget} />
        {canEdit && monthlyBudgets.length === 0 && (
          <div className="mt-3">
            <p className="text-sm text-[var(--muted)]">กดเพื่อเติมรายการที่ร้านส่วนใหญ่มี (รวมที่ร้านใหม่มักลืม):</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {BUDGET_PRESETS.map((preset) => (
                <button key={preset.name} type="button" className="min-h-9 rounded-full border border-[var(--border)] px-3 text-sm text-[var(--ink)] hover:bg-[var(--surface-muted)]" onClick={() => setDraft({ ...emptyDraft("monthly"), costType: preset.costType, name: preset.name })}>
                  + {preset.name}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* เทียบงบกับจริง */}
        {(props.actual || props.payroll) && (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[420px] text-sm">
              <caption className="mb-1 text-left text-xs text-[var(--muted)]">
                เทียบงบกับรายจ่ายจริง{props.actual ? ` เดือน ${props.actual.label} (${props.actual.count} รายการในบัญชี)` : ""}
              </caption>
              <thead>
                <tr className="border-b border-[var(--border)] text-left text-[var(--muted)]">
                  <th scope="col" className="py-1.5 font-medium">ประเภท</th>
                  <th scope="col" className="py-1.5 text-right font-medium">งบ</th>
                  <th scope="col" className="py-1.5 text-right font-medium">จริง</th>
                </tr>
              </thead>
              <tbody>
                {FIXED_COST_TYPES.map((type) => {
                  const plan = fixed.byType[type] ?? 0;
                  const real = props.actual?.byType[type] ?? 0;
                  if (plan === 0 && real === 0 && !(type === "labor" && props.payroll)) return null;
                  return (
                    <tr key={type} className="border-b border-[var(--border)]">
                      <td className="py-1.5 text-[var(--ink)]">{COST_TYPE_LABELS[type]}</td>
                      <td className="py-1.5 text-right tabular-nums">{plan ? baht(plan) : "—"}</td>
                      <td className="py-1.5 text-right tabular-nums">
                        {real ? baht(real) : "—"}
                        {type === "labor" && props.payroll && (
                          <span className="block text-xs text-[var(--muted)]">
                            เงินเดือนสุทธิงวด {props.payroll.periodStart} – {props.payroll.periodEnd}: {baht(props.payroll.netPay)}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {props.actual && props.actual.unmapped > 0 && (
                  <tr>
                    <td className="py-1.5 text-[var(--muted)]">หมวดที่ยังไม่ระบุประเภท</td>
                    <td />
                    <td className="py-1.5 text-right tabular-nums text-[var(--muted)]">{baht(props.actual.unmapped)}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* เงินลงทุน / ค่าเสื่อม */}
      <section className={CARD} aria-labelledby="be-startup">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 id="be-startup" className="text-base font-semibold text-[var(--ink)]">
              เงินลงทุนและค่าเสื่อม
            </h2>
            <p className="text-xs text-[var(--muted)]">เครื่องชง ตู้เย็น ตกแต่ง ฯลฯ — ใส่อายุใช้งานเพื่อเฉลี่ยเป็นค่าเสื่อมต่อเดือน</p>
          </div>
          {canEdit && (
            <button type="button" className="btn-primary min-h-10" onClick={() => setDraft(emptyDraft("startup"))} disabled={pending}>
              + เพิ่มเงินลงทุน
            </button>
          )}
        </div>
        <BudgetList items={startupBudgets} canEdit={canEdit} pending={pending} onEdit={(b) => setDraft(toDraft(b))} onToggle={(b) => run(() => saveCostBudgetAction({ ...b, isActive: !b.isActive }), b.isActive ? "ปิดรายการแล้ว" : "เปิดรายการแล้ว")} onDelete={removeBudget} />
        {fixed.startupWithoutLife > 0 && <p className="mt-2 text-xs text-[var(--muted)]">{fixed.startupWithoutLife} รายการไม่ได้ใส่อายุใช้งาน → ไม่คิดค่าเสื่อม แต่นับในระยะคืนทุน</p>}
      </section>

      {draft && canEdit && (
        <BudgetForm draft={draft} pending={pending} onChange={setDraft} onCancel={() => setDraft(null)} onSubmit={submitDraft} />
      )}

      {/* ตั้งราคา */}
      <PricingCard products={costedProducts} overhead={overhead} unitsForOverhead={unitsForOverhead} settings={settings} />

      {/* what-if */}
      <section className={CARD} aria-labelledby="be-whatif">
        <h2 id="be-whatif" className="text-base font-semibold text-[var(--ink)]">
          ลองตัวเลข
        </h2>
        <p className="text-xs text-[var(--muted)]">ไม่บันทึก — ใช้ดูว่าถ้าขายได้เท่านี้ หรือขึ้น/ลดราคา จะกำไรเท่าไร</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-sm">
            <span className="text-[var(--muted)]">ขายได้ (ชิ้น/วัน)</span>
            <input className={INPUT} style={INPUT_STYLE} type="number" inputMode="numeric" min={0} value={whatIfDay} onChange={(e) => setWhatIfDay(e.target.value)} />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-[var(--muted)]">ปรับราคาทุกเมนู (%)</span>
            <input className={INPUT} style={INPUT_STYLE} type="number" inputMode="decimal" step={1} value={priceChange} onChange={(e) => setPriceChange(e.target.value)} />
          </label>
        </div>
        <p className="mt-3 text-sm text-[var(--ink)]">
          {whatIfProfit === null ? (
            "ต้องมีเมนูที่ตั้งสูตรก่อน"
          ) : (
            <>
              {units(whatIfMonthUnits)} ชิ้น/เดือน → {whatIfProfit >= 0 ? "กำไร" : "ขาดทุน"}{" "}
              <b className={`tabular-nums ${whatIfProfit >= 0 ? "text-emerald-700" : "text-red-700"}`}>{baht(Math.abs(whatIfProfit))}</b> ต่อเดือน
            </>
          )}
        </p>
      </section>

      {/* ตั้งค่า */}
      {/* key: ค่าจาก server เปลี่ยน (บันทึก/อีกเครื่องแก้) → ฟอร์มรีเซ็ตตามค่าใหม่ ไม่ส่งค่าเก่าทับ */}
      <SettingsCard key={`${settings.openDaysPerMonth}|${settings.targetProfitMonthly}|${settings.otherVariablePct}`} settings={settings} canEdit={canEdit} pending={pending} onSave={(input) => run(() => saveBreakEvenSettingsAction(input), "บันทึกค่าตั้งแล้ว")} />

      {/* จับคู่หมวดรายจ่าย */}
      <section className={CARD} aria-labelledby="be-categories">
        <h2 id="be-categories" className="text-base font-semibold text-[var(--ink)]">
          จับคู่หมวดรายจ่ายในบัญชี
        </h2>
        <p className="text-xs text-[var(--muted)]">บอกระบบว่าหมวดรายจ่ายแต่ละหมวดเป็นต้นทุนประเภทไหน เพื่อเทียบงบกับรายจ่ายจริงด้านบน (ต้องมีสิทธิ์จัดการบัญชี)</p>
        {props.categoriesError ? (
          <p className="mt-2 text-sm text-red-700">โหลดหมวดรายจ่ายไม่สำเร็จ: {props.categoriesError}</p>
        ) : props.categories.length === 0 ? (
          <p className="mt-2 text-sm text-[var(--muted)]">ยังไม่มีหมวดรายจ่าย</p>
        ) : (
          <ul className="mt-2 divide-y divide-[var(--border)]">
            {props.categories.map((category) => (
              <li key={category.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <span className="text-[var(--ink)]">{category.name}</span>
                <select
                  aria-label={`ประเภทต้นทุนของหมวด ${category.name}`}
                  className={`${INPUT} w-auto py-1`}
                  style={INPUT_STYLE}
                  disabled={!canEdit || pending}
                  value={category.costType ?? ""}
                  onChange={(e) => run(() => setCategoryCostTypeAction({ categoryId: category.id, costType: (e.target.value || null) as CostType | null }), "จับคู่หมวดแล้ว")}
                >
                  <option value="">— ยังไม่ระบุ —</option>
                  {COST_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {COST_TYPE_LABELS[type]}
                    </option>
                  ))}
                </select>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="text-xs text-[var(--muted)]">
        ยอดขายจริงช่วง {props.salesRangeLabel} · ราคาเฉลี่ยต่อเมนูเป็นยอดก่อนส่วนลดท้ายบิล · ต้นทุนต่อชิ้นใช้สูตรปัจจุบันของเมนูหลัก (ยังไม่แยกตามตัวเลือก)
      </p>
    </div>
  );
}

function toDraft(b: CostBudget): Draft {
  return { id: b.id, kind: b.kind, costType: b.costType, name: b.name, amount: String(b.amount), life: b.usefulLifeMonths === null ? "" : String(b.usefulLifeMonths), isActive: b.isActive };
}

function Notice({ children }: { children: React.ReactNode }) {
  return <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">{children}</p>;
}

function BudgetList(props: {
  items: CostBudget[];
  canEdit: boolean;
  pending: boolean;
  onEdit: (b: CostBudget) => void;
  onToggle: (b: CostBudget) => void;
  onDelete: (b: CostBudget) => void;
}) {
  if (props.items.length === 0) return <p className="mt-2 text-sm text-[var(--muted)]">ยังไม่มีรายการ</p>;
  return (
    <ul className="mt-2 divide-y divide-[var(--border)]">
      {props.items.map((b) => {
        const dep = monthlyDepreciation(b);
        return (
          <li key={b.id} className={`flex flex-wrap items-center gap-2 py-2 text-sm ${b.isActive ? "" : "opacity-60"}`}>
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium text-[var(--ink)]">
                {b.name} {!b.isActive && <span className="text-xs text-[var(--muted)]">(ปิดอยู่)</span>}
              </p>
              <p className="text-xs text-[var(--muted)]">
                {COST_TYPE_LABELS[b.costType]}
                {b.kind === "startup" && (b.usefulLifeMonths ? ` · ${b.usefulLifeMonths} เดือน → ค่าเสื่อม ${baht(dep, 2)}/เดือน` : " · ไม่คิดค่าเสื่อม")}
              </p>
            </div>
            <span className="tabular-nums font-semibold text-[var(--ink)]">{baht(b.amount)}</span>
            {props.canEdit && (
              <span className="flex gap-1">
                <button type="button" className="min-h-9 rounded-lg px-2 text-[var(--tenant-primary)]" disabled={props.pending} onClick={() => props.onEdit(b)}>
                  แก้
                </button>
                <button type="button" className="min-h-9 rounded-lg px-2 text-[var(--muted)]" disabled={props.pending} onClick={() => props.onToggle(b)}>
                  {b.isActive ? "ปิด" : "เปิด"}
                </button>
                <button type="button" className="min-h-9 rounded-lg px-2 text-red-700" disabled={props.pending} onClick={() => props.onDelete(b)}>
                  ลบ
                </button>
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function BudgetForm(props: { draft: Draft; pending: boolean; onChange: (d: Draft) => void; onCancel: () => void; onSubmit: () => void }) {
  const { draft } = props;
  const set = (patch: Partial<Draft>) => props.onChange({ ...draft, ...patch });
  return (
    <section className={`${CARD} border-[var(--tenant-primary)]`} aria-labelledby="be-form">
      <h2 id="be-form" className="text-base font-semibold text-[var(--ink)]">
        {draft.id ? "แก้รายการ" : draft.kind === "startup" ? "เพิ่มเงินลงทุน" : "เพิ่มต้นทุนรายเดือน"}
      </h2>
      <form
        className="mt-3 grid gap-3 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          props.onSubmit();
        }}
      >
        <label className="space-y-1 text-sm">
          <span className="text-[var(--muted)]">ชื่อรายการ</span>
          <input className={INPUT} style={INPUT_STYLE} value={draft.name} maxLength={80} required onChange={(e) => set({ name: e.target.value })} />
        </label>
        <label className="space-y-1 text-sm">
          <span className="text-[var(--muted)]">ประเภท</span>
          <select className={INPUT} style={INPUT_STYLE} value={draft.costType} onChange={(e) => set({ costType: e.target.value as CostType })}>
            {FIXED_COST_TYPES.map((type) => (
              <option key={type} value={type}>
                {COST_TYPE_LABELS[type]}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-sm">
          <span className="text-[var(--muted)]">{draft.kind === "startup" ? "ราคา/เงินลงทุน (บาท)" : "จำนวนเงินต่อเดือน (บาท)"}</span>
          <input className={INPUT} style={INPUT_STYLE} type="number" inputMode="decimal" min={0} step="0.01" required value={draft.amount} onChange={(e) => set({ amount: e.target.value })} />
        </label>
        {draft.kind === "startup" && (
          <label className="space-y-1 text-sm">
            <span className="text-[var(--muted)]">อายุใช้งาน (เดือน) — เว้นว่าง = ไม่คิดค่าเสื่อม</span>
            <input className={INPUT} style={INPUT_STYLE} type="number" inputMode="numeric" min={1} max={600} step={1} value={draft.life} onChange={(e) => set({ life: e.target.value })} />
          </label>
        )}
        <div className="flex gap-2 sm:col-span-2">
          <button type="submit" className="btn-primary min-h-11" disabled={props.pending}>
            {props.pending ? "กำลังบันทึก…" : "บันทึก"}
          </button>
          <button type="button" className="min-h-11 rounded-lg border border-[var(--border)] px-4 text-sm" onClick={props.onCancel}>
            ยกเลิก
          </button>
        </div>
      </form>
    </section>
  );
}

function PricingCard(props: { products: PlannerProduct[]; overhead: number | null; unitsForOverhead: number; settings: StoreCostSettings }) {
  const [productId, setProductId] = useState(props.products[0]?.id ?? "");
  // เมนูที่เลือกไว้หายหลัง revalidate → ใช้เมนูแรก (select แสดงตรงกับตาราง)
  const product = props.products.find((p) => p.id === productId) ?? props.products[0] ?? null;
  return (
    <section className={CARD} aria-labelledby="be-pricing">
      <h2 id="be-pricing" className="text-base font-semibold text-[var(--ink)]">
        ตั้งราคาเมื่อคิดต้นทุนทั้งหมด
      </h2>
      <p className="text-xs text-[var(--muted)]">ต้นทุนรวม = วัตถุดิบ + บรรจุภัณฑ์ + ต้นทุนดำเนินการต่อชิ้น · ปัดราคาตามกติกาของร้าน</p>
      {props.products.length === 0 ? (
        <p className="mt-2 text-sm text-[var(--muted)]">
          ยังไม่มีเมนูที่ตั้งสูตร — <Link className="font-semibold text-[var(--tenant-primary)]" href="/costing/menu">ตั้งสูตรเมนู</Link>
        </p>
      ) : props.overhead === null ? (
        <p className="mt-2 text-sm text-[var(--muted)]">ใส่ต้นทุนคงที่ และจำนวนที่ขายได้ (ยอดจริงหรือช่อง “ลองตัวเลข”) เพื่อคำนวณต้นทุนดำเนินการต่อชิ้น</p>
      ) : (
        <>
          <select aria-label="เลือกเมนู" className={`${INPUT} mt-3 sm:w-auto`} style={INPUT_STYLE} value={product?.id ?? ""} onChange={(e) => setProductId(e.target.value)}>
            {props.products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          {product && product.unitCost !== null && (
            <PricingTable product={product} unitCost={product.unitCost} overhead={props.overhead} unitsForOverhead={props.unitsForOverhead} settings={props.settings} />
          )}
        </>
      )}
    </section>
  );
}

function PricingTable(props: { product: PlannerProduct; unitCost: number; overhead: number; unitsForOverhead: number; settings: StoreCostSettings }) {
  const full = props.unitCost + props.overhead;
  const ladder = priceLadder({ fullUnitCost: full, otherVariablePct: props.settings.otherVariablePct, rounding: props.settings.priceRounding });
  const now = netProfitAt(props.product.price, full, props.settings.otherVariablePct);
  return (
    <div className="mt-3 space-y-2 text-sm">
      <p className="text-[var(--ink)]">
        วัตถุดิบ+บรรจุภัณฑ์ {baht(props.unitCost, 2)} + ดำเนินการ {baht(props.overhead, 2)} = <b>ต้นทุนรวม {baht(full, 2)}</b>
        <span className="text-xs text-[var(--muted)]"> (ที่ {units(props.unitsForOverhead)} ชิ้น/เดือน)</span>
      </p>
      <table className="w-full max-w-md text-sm">
        <thead>
          <tr className="border-b border-[var(--border)] text-left text-[var(--muted)]">
            <th scope="col" className="py-1.5 font-medium">กำไรสุทธิ</th>
            <th scope="col" className="py-1.5 text-right font-medium">ราคาแนะนำ</th>
            <th scope="col" className="py-1.5 text-right font-medium">กำไร/ชิ้น</th>
          </tr>
        </thead>
        <tbody>
          {ladder.map((row) => (
            <tr key={row.marginPct} className="border-b border-[var(--border)]">
              <td className="py-1.5">{row.marginPct}%</td>
              <td className="py-1.5 text-right font-semibold tabular-nums">{baht(row.price, row.price % 1 === 0 ? 0 : 2)}</td>
              <td className="py-1.5 text-right tabular-nums">{baht(row.profitPerUnit, 2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className={now.perUnit >= 0 ? "text-[var(--ink)]" : "text-red-700"}>
        ราคาปัจจุบัน {baht(props.product.price, 2)} → กำไรสุทธิ {baht(now.perUnit, 2)}/ชิ้น{now.pct !== null ? ` (${now.pct}%)` : ""}
      </p>
      <Link href="/costing/menu" className="inline-flex min-h-10 items-center text-sm font-semibold text-[var(--tenant-primary)]">
        ไปปรับราคา/สูตรเมนู →
      </Link>
    </div>
  );
}

function SettingsCard(props: {
  settings: StoreCostSettings;
  canEdit: boolean;
  pending: boolean;
  onSave: (input: { openDaysPerMonth: number; targetProfitMonthly: number; otherVariablePct: number }) => void;
}) {
  const [openDays, setOpenDays] = useState(String(props.settings.openDaysPerMonth));
  const [target, setTarget] = useState(String(props.settings.targetProfitMonthly));
  const [variable, setVariable] = useState(String(props.settings.otherVariablePct));
  return (
    <section className={CARD} aria-labelledby="be-settings">
      <h2 id="be-settings" className="text-base font-semibold text-[var(--ink)]">
        ตั้งค่า
      </h2>
      <form
        className="mt-3 grid gap-3 sm:grid-cols-3"
        onSubmit={(e) => {
          e.preventDefault();
          props.onSave({ openDaysPerMonth: Number(openDays), targetProfitMonthly: Number(target), otherVariablePct: Number(variable) });
        }}
      >
        <label className="space-y-1 text-sm">
          <span className="text-[var(--muted)]">วันเปิดร้าน/เดือน</span>
          <input className={INPUT} style={INPUT_STYLE} type="number" inputMode="numeric" min={1} max={31} step={1} value={openDays} disabled={!props.canEdit} onChange={(e) => setOpenDays(e.target.value)} />
        </label>
        <label className="space-y-1 text-sm">
          <span className="text-[var(--muted)]">เป้ากำไร/เดือน (บาท)</span>
          <input className={INPUT} style={INPUT_STYLE} type="number" inputMode="decimal" min={0} step="0.01" value={target} disabled={!props.canEdit} onChange={(e) => setTarget(e.target.value)} />
        </label>
        <label className="space-y-1 text-sm">
          <span className="text-[var(--muted)]">ต้นทุนผันแปรอื่น % (ค่าธรรมเนียมบัตร/QR, GP)</span>
          <input className={INPUT} style={INPUT_STYLE} type="number" inputMode="decimal" min={0} max={99} step="0.01" value={variable} disabled={!props.canEdit} onChange={(e) => setVariable(e.target.value)} />
        </label>
        {props.canEdit && (
          <div className="sm:col-span-3">
            <button type="submit" className="btn-primary min-h-11" disabled={props.pending}>
              บันทึกค่าตั้ง
            </button>
          </div>
        )}
      </form>
    </section>
  );
}
