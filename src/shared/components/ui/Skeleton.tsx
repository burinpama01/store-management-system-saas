/**
 * Skeleton placeholders for real loading boundaries (Suspense / loading.tsx).
 * These show while server data is actually being fetched — an honest loading
 * state without a fabricated percentage.
 */
export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-md bg-[var(--surface-muted)] ${className}`} />;
}

export function SkeletonText({ lines = 3, className = "" }: { lines?: number; className?: string }) {
  return (
    <div className={`space-y-2 ${className}`}>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} className={`h-3 ${i === lines - 1 ? "w-2/3" : "w-full"}`} />
      ))}
    </div>
  );
}

export function LocalizedLoading({
  message = "กำลังโหลดข้อมูลส่วนนี้...",
  detail,
  percent,
  variant = "inline",
  className = "",
}: {
  message?: string;
  detail?: string;
  percent?: number;
  variant?: "inline" | "overlay";
  className?: string;
}) {
  const hasMeasuredProgress = typeof percent === "number" && Number.isFinite(percent);
  const clampedPercent = hasMeasuredProgress ? Math.max(0, Math.min(100, Math.round(percent))) : 0;
  const wrapperClass =
    variant === "overlay"
      ? "absolute inset-0 z-20 flex items-center justify-center rounded-lg border border-[var(--color-border)] bg-white/85 p-4 shadow-sm backdrop-blur-sm"
      : "rounded-lg border border-[var(--color-border)] bg-white/80 p-3";

  return (
    <div className={`${wrapperClass} ${className}`} role="status" aria-live="polite" aria-busy="true">
      <div className="w-full max-w-sm space-y-3">
        <div className="flex items-center gap-3">
          <span
            aria-hidden="true"
            className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-[var(--surface-muted)] border-t-[var(--tenant-primary)]"
          />
          <div className="min-w-0">
            <p className="text-xs font-bold text-[var(--color-text-primary)]">{message}</p>
            {detail && <p className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">{detail}</p>}
          </div>
        </div>
        {hasMeasuredProgress ? (
          <div
            className="w-full"
            role="progressbar"
            aria-valuenow={clampedPercent}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div className="mb-1 flex items-center justify-between text-[11px] font-semibold text-[var(--color-text-muted)]">
              <span>ความคืบหน้า</span>
              <span className="tabular-nums">{clampedPercent}%</span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-[var(--surface-muted)]">
              <div
                className="h-full rounded-full bg-[var(--tenant-primary)] transition-[width] duration-150 ease-out"
                style={{ width: `${clampedPercent}%` }}
              />
            </div>
          </div>
        ) : (
          // ไม่สร้างเปอร์เซ็นต์ปลอม: ถ้าไม่มี progress จริง ให้ใช้ skeleton/indeterminate แทน
          <div className="space-y-2" aria-hidden="true">
            <Skeleton className="h-2 w-full" />
            <Skeleton className="h-2 w-4/5" />
          </div>
        )}
      </div>
    </div>
  );
}

/** Generic dashboard page skeleton: header + KPI cards + a table block. */
export function PageSkeleton() {
  return (
    <div className="page-shell" aria-busy="true" aria-live="polite">
      <span className="sr-only">กำลังโหลดข้อมูล...</span>
      <div className="page-header">
        <div className="space-y-2">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-3 w-72" />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="panel p-4">
            <Skeleton className="mb-3 h-3 w-20" />
            <Skeleton className="h-7 w-24" />
            <Skeleton className="mt-4 h-8 w-full" />
          </div>
        ))}
      </div>
      <div className="panel p-4">
        <Skeleton className="mb-4 h-4 w-40" />
        <div className="space-y-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3">
              <Skeleton className="h-4 w-6" />
              <Skeleton className="h-4 flex-1" />
              <Skeleton className="h-4 w-16" />
              <Skeleton className="h-4 w-20" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
