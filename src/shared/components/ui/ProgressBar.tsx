"use client";

/**
 * Determinate progress bar with a live percentage label. Use only where the
 * percentage reflects real measured progress (e.g. file upload bytes). For
 * unmeasurable waits use a skeleton/spinner instead, not a fake number.
 */
export function ProgressBar({
  percent,
  label,
}: {
  percent: number;
  label?: string;
}) {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  return (
    <div className="w-full" role="progressbar" aria-valuenow={clamped} aria-valuemin={0} aria-valuemax={100}>
      <div className="mb-1 flex items-center justify-between text-xs font-bold text-[var(--ink-2)]">
        <span>{label ?? "กำลังโหลด..."}</span>
        <span className="tabular-nums">{clamped}%</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-[var(--surface-muted)]">
        <div
          className="h-full rounded-full bg-[var(--tenant-primary)] transition-[width] duration-150 ease-out"
          style={{ width: `${clamped}%` }}
        />
      </div>
    </div>
  );
}
