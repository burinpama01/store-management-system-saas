import type { StockPoolView } from "@/modules/stock/pool-repository";

export function StockPoolCard({
  pool,
  linkedItems,
  selected = false,
  onSelect,
}: {
  pool: StockPoolView;
  linkedItems: string[];
  selected?: boolean;
  onSelect?: () => void;
}) {
  const content = (
    <>
      <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-start">
        <div>
          <p className="font-semibold text-[var(--ink)]">
            {pool.name}
            {pool.isActive ? null : <span className="ml-2 badge badge-warning text-[10px]">ปิดใช้งาน</span>}
          </p>
          <p className="text-xs text-[var(--muted)]">หน่วย: {pool.unitLabel} · เตือนเมื่อเหลือ {pool.lowStockThreshold}</p>
        </div>
        <p className="font-mono text-lg font-bold text-[var(--ink)]">{pool.quantity} {pool.unitLabel}</p>
      </div>
      <p className="mt-3 border-t border-[var(--border)] pt-3 text-xs text-[var(--muted)]">
        เชื่อมกับ: {linkedItems.length > 0 ? linkedItems.join(" · ") : "ยังไม่มี Variant เชื่อม"}
      </p>
    </>
  );

  if (!onSelect) return <article className="rounded-lg border border-[var(--border)] p-4">{content}</article>;

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`min-h-11 w-full rounded-lg border p-4 text-left transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700 ${selected ? "border-teal-700 bg-teal-50" : "border-[var(--border)] bg-white hover:border-teal-600"}`}
    >
      {content}
    </button>
  );
}
