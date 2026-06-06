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
