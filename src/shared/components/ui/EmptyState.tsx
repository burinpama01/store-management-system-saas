import type { ReactNode } from "react";

interface Props {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}

export function EmptyState({ icon, title, description, action }: Props) {
  return (
    <div className="panel-muted flex flex-col items-center justify-center px-4 py-12 text-center">
      {icon && (
        <div className="mb-3 text-4xl text-[var(--color-text-muted)]" aria-hidden="true">
          {icon}
        </div>
      )}
      <p className="text-sm font-bold text-[var(--color-text-primary)]">{title}</p>
      {description && (
        <p className="mt-1 max-w-xs text-xs text-[var(--color-text-muted)]">{description}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function LoadingState({ message = "กำลังโหลด..." }: { message?: string }) {
  return (
    <div className="flex items-center justify-center py-12 px-4">
      <span className="text-sm text-[var(--color-text-muted)]">{message}</span>
    </div>
  );
}

export function ErrorState({
  message = "เกิดข้อผิดพลาด",
  retry,
}: {
  message?: string;
  retry?: () => void;
}) {
  return (
    <div className="panel-muted flex flex-col items-center justify-center px-4 py-12 text-center">
      <p className="text-sm font-bold text-[var(--color-danger)]">{message}</p>
      {retry && (
        <button
          onClick={retry}
          className="btn-secondary mt-3 text-xs"
        >
          ลองใหม่
        </button>
      )}
    </div>
  );
}
