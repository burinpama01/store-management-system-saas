"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/settings/store", label: "ร้านค้า" },
  { href: "/settings/team", label: "ทีมงาน" },
  { href: "/settings/receipt", label: "ใบเสร็จ" },
  { href: "/settings/billing", label: "แพ็กเกจ" },
  { href: "/settings/notifications", label: "Notifications" },
];

export function SettingsNav() {
  const pathname = usePathname();
  return (
    <div className="mb-5">
      <nav className="panel-muted flex gap-1 overflow-x-auto p-1">
        {TABS.map((tab) => (
          <Link
            key={tab.href}
            href={tab.href}
            className={`min-h-11 rounded-md px-3 py-2 text-sm font-bold transition-colors ${
              pathname.startsWith(tab.href)
                ? "bg-white text-[var(--color-brand)] shadow-xs"
                : "text-[var(--color-text-secondary)] hover:bg-white/70 hover:text-[var(--color-text-primary)]"
            }`}
          >
            {tab.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
