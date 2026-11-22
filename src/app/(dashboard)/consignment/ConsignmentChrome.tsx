import Link from "next/link";

const TABS = [
  { href: "/consignment", label: "ภาพรวม" },
  { href: "/consignment/products", label: "ตั้งเมนู" },
  { href: "/consignment/receive", label: "รับของ / เติมของ" },
  { href: "/consignment/report", label: "รายงาน" },
] as const;

export type ConsignmentTab = (typeof TABS)[number]["href"];

export function ConsignmentHeader({ active, description }: { active: ConsignmentTab; description: string }) {
  return (
    <header className="space-y-3">
      <div>
        <h1 className="text-2xl font-bold text-[var(--ink)]">สินค้าซื้อขาด / ฝากขาย</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">{description}</p>
      </div>
      <nav aria-label="เมนูฝากขาย" className="flex flex-wrap gap-2">
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

export function ConsignmentLocked({ message }: { message: string }) {
  return (
    <section className="page-shell max-w-3xl">
      <div className="rounded-md border border-amber-200 bg-amber-50 p-5">
        <p className="text-sm font-bold text-amber-900">สินค้าซื้อขาด/ฝากขาย ยังใช้ไม่ได้</p>
        <p className="mt-2 text-sm text-amber-800">{message}</p>
      </div>
    </section>
  );
}

export function NotEnabledNotice() {
  return (
    <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
      สาขานี้ยังไม่ได้เปิดระบบ — เจ้าของหรือแอดมินเปิดได้ที่แท็บ ภาพรวม
    </p>
  );
}

export function baht(value: number) {
  return new Intl.NumberFormat("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}

export const inputClass =
  "min-h-11 w-full rounded-lg border border-[var(--border)] bg-white px-3 text-[16px] text-[var(--ink)]";

/** ชื่อเมนู/รสสำหรับแสดงผล */
export function itemLabel(
  products: Array<{ id: string; name: string; groups: Array<{ options: Array<{ id: string; name: string }> }> }>,
  productId: string,
  optionId: string | null,
) {
  const p = products.find((x) => x.id === productId);
  if (!p) return "เมนูที่ถูกลบ";
  if (!optionId) return p.name;
  const opt = p.groups.flatMap((g) => g.options).find((o) => o.id === optionId);
  return `${p.name} · ${opt?.name ?? "รสที่ถูกลบ"}`;
}
