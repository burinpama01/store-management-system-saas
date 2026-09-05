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
      {/* Entry point ตาม Mobile Compliance Design System v1 — ค้นพบง่ายแต่ไม่ลบทันที
          การยืนยันตัวตนและลบข้อมูลจริงอยู่หลังการติดต่อทีมงาน */}
      <div className="panel-muted mt-2 flex flex-wrap items-center justify-between gap-2 p-3">
        <div className="min-w-0">
          <p className="text-sm font-bold text-[var(--color-text-primary)]">บัญชีและข้อมูล</p>
          <p className="text-xs text-[var(--color-text-secondary)]">
            อ่านข้อมูลที่จะถูกลบ ระยะเวลาดำเนินการ และข้อมูลที่ต้องเก็บตามกฎหมายก่อนเริ่มคำขอ
          </p>
        </div>
        <Link
          href="/account-deletion"
          className="inline-flex min-h-11 items-center rounded-md border border-[#b91c1c] px-4 text-sm font-bold text-[#b91c1c] transition-colors hover:bg-[#fee2e2] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#b91c1c]"
        >
          ดูขั้นตอนการลบบัญชี
        </Link>
      </div>
    </div>
  );
}
