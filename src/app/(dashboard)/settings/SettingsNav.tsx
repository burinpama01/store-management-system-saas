"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import type { FeatureKey } from "@/modules/billing/types";

export interface SettingsTab {
  href: string;
  label: string;
  featureKey?: FeatureKey;
}

export function SettingsNav({ tabs }: { tabs: SettingsTab[] }) {
  const pathname = usePathname();
  return (
    <div className="mb-5">
      <nav className="panel-muted flex gap-1 overflow-x-auto p-1">
        {tabs.map((tab) => (
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
