import Link from "next/link";

const TABS = [
  { href: "/costing", label: "ภาพรวม" },
  { href: "/costing/menu", label: "ต้นทุนเมนู" },
  { href: "/costing/ingredients", label: "วัตถุดิบ" },
] as const;

export function CostingHeader({ active, title, description }: { active: (typeof TABS)[number]["href"]; title: string; description: string }) {
  return (
    <header className="space-y-3">
      <div>
        <h1 className="text-2xl font-bold text-[var(--ink)]">{title}</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">{description}</p>
      </div>
      <nav aria-label="เมนูระบบต้นทุน" className="flex flex-wrap gap-2">
        {TABS.map((tab) => (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={tab.href === active ? "page" : undefined}
            className={`inline-flex min-h-10 items-center rounded-full border px-4 text-sm font-semibold ${
              tab.href === active
                ? "border-[var(--tenant-primary)] bg-[var(--tenant-primary)] text-white"
                : "border-[var(--border)] bg-[var(--surface)] text-[var(--ink)] hover:bg-[var(--surface-muted)]"
            }`}
          >
            {tab.label}
          </Link>
        ))}
      </nav>
    </header>
  );
}

export function CostingLocked({ message }: { message: string }) {
  return (
    <section className="page-shell max-w-3xl">
      <div className="rounded-md border border-amber-200 bg-amber-50 p-5">
        <p className="text-sm font-bold text-amber-900">ระบบต้นทุนยังใช้ไม่ได้</p>
        <p className="mt-2 text-sm text-amber-800">{message}</p>
      </div>
    </section>
  );
}

export function money(value: number) {
  return new Intl.NumberFormat("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}
