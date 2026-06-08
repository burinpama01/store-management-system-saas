type Variant = "default" | "success" | "warning" | "danger" | "info";

const VARIANTS: Record<Variant, string> = {
  default: "bg-[var(--color-surface-muted)] text-[var(--color-text-secondary)] border-[var(--color-border)]",
  success: "bg-[var(--color-success-soft)] text-[var(--color-success)] border-green-200",
  warning: "bg-[var(--color-warning-soft)] text-[var(--color-warning)] border-amber-200",
  danger: "bg-[var(--color-danger-soft)] text-[var(--color-danger)] border-red-200",
  info: "bg-[var(--color-accent-soft)] text-[var(--color-accent)] border-blue-200",
};

interface Props {
  children: React.ReactNode;
  variant?: Variant;
}

export function Badge({ children, variant = "default" }: Props) {
  return (
    <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-bold ${VARIANTS[variant]}`}>
      {children}
    </span>
  );
}
