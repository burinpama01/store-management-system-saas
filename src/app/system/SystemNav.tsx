"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/system", label: "ภาพรวมแพลตฟอร์ม", exact: true },
  { href: "/system/tenants", label: "Tenants", exact: false },
  { href: "/system/pricing", label: "แพ็กเกจ/ราคา", exact: false },
  { href: "/system/enterprise", label: "คำขอ Enterprise", exact: false },
  { href: "/system/music-licenses", label: "ใบอนุญาตขอเพลง", exact: false },
  { href: "/system/audit", label: "Audit", exact: false },
  { href: "/system/settings", label: "ตั้งค่า", exact: false },
];

export function SystemNav() {
  const pathname = usePathname();
  return (
    <nav className="panel-muted flex gap-1 overflow-x-auto p-1">
      {TABS.map((tab) => {
        const active = tab.exact ? pathname === tab.href : pathname.startsWith(tab.href);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={`min-h-11 rounded-md px-3 py-2 text-sm font-bold transition-colors ${
              active
                ? "bg-white text-[var(--color-brand)] shadow-xs"
                : "text-[var(--color-text-secondary)] hover:bg-white/70 hover:text-[var(--color-text-primary)]"
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
