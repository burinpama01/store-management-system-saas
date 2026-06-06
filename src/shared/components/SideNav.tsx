"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

interface NavItem {
  href: string;
  label: string;
}

interface Props {
  items: NavItem[];
  orientation?: "vertical" | "horizontal";
}

export function SideNav({ items, orientation = "vertical" }: Props) {
  const pathname = usePathname();
  const iconMap: Record<string, string> = {
    "ภาพรวม": "▦",
    "เมนูสินค้า": "☕",
    "สต็อก": "◫",
    POS: "▣",
    "บัญชี": "฿",
    "รายงาน": "⌁",
    "การเข้างาน": "◷",
    "บุฟเฟต์": "◎",
    "ตั้งค่า": "⚙",
  };

  return (
    <nav
      className={
        orientation === "horizontal"
          ? "flex gap-1 overflow-x-auto p-2"
          : "flex-1 overflow-y-auto px-3 pb-3"
      }
    >
      {orientation === "vertical" && <div className="nav-group-label">ทำงานประจำวัน</div>}
      {items.map((item) => {
        const isActive =
          item.href === "/"
            ? pathname === "/"
            : pathname === item.href || pathname.startsWith(item.href + "/");

        return (
          <Link
            key={item.href}
            href={item.href}
            className={`group flex items-center gap-2 rounded-md text-sm transition-colors ${
              orientation === "horizontal"
                ? "min-h-11 shrink-0 whitespace-nowrap px-4 py-2.5"
                : "min-h-10 px-3 py-2"
            } ${
              isActive
                ? "bg-[var(--tenant-primary-soft)] text-[var(--tenant-primary-strong)] font-bold"
                : "text-[var(--ink-2)] hover:bg-[var(--surface-muted)] hover:text-[var(--ink)]"
            }`}
          >
            <span
              aria-hidden="true"
              className={`grid h-7 w-7 shrink-0 place-items-center rounded-[9px] text-xs transition-colors ${
                isActive ? "bg-white/70 text-[var(--tenant-primary)]" : "bg-[var(--canvas-2)] text-[var(--quiet)] group-hover:text-[var(--ink-2)]"
              }`}
            >
              {iconMap[item.label] ?? item.label.slice(0, 1)}
            </span>
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
