import Link from "next/link";
import type { HTMLAttributes, ReactNode } from "react";

type MarketingHeaderProps = {
  active?: "features" | "pricing";
};

const NAV_ITEMS: Array<{ label: string; href: string; key: NonNullable<MarketingHeaderProps["active"]> }> = [
  { label: "ฟีเจอร์", href: "/", key: "features" },
  { label: "แพ็กเกจและราคา", href: "/pricing", key: "pricing" },
];

const PRICING_NAV_ITEMS = NAV_ITEMS.filter((item) => item.key === "features" || item.key === "pricing");

export function MarketingBrand() {
  return (
    <Link href="/" className="marketing-brand" aria-label="StoreOS">
      <span className="brand-mark">S</span>
      <span>
        <strong className="brand-name">StoreOS</strong>
      </span>
    </Link>
  );
}

export function MarketingHeader({ active = "features" }: MarketingHeaderProps) {
  const navItems = active === "pricing" ? PRICING_NAV_ITEMS : NAV_ITEMS;

  return (
    <header className="marketing-header">
      <MarketingBrand />
      <nav className="marketing-nav" aria-label="เมนูหลัก">
        {navItems.map((item) => (
          <Link
            key={item.key}
            href={item.href}
            className={`marketing-nav-link${active === item.key ? " is-active" : ""}`}
          >
            {item.label}
          </Link>
        ))}
      </nav>
      <div className="marketing-header-actions">
        <Link href="/login" className="marketing-login-link">
          เข้าสู่ระบบ
        </Link>
        <Link href="/register" className="btn-primary marketing-header-cta">
          สมัครใช้งาน
        </Link>
      </div>
    </header>
  );
}

export function GlassPanel({
  children,
  className = "",
  ...props
}: Readonly<
  HTMLAttributes<HTMLDivElement> & {
  children: ReactNode;
  className?: string;
  }
>) {
  return (
    <div {...props} className={`marketing-glass ${className}`}>
      {children}
    </div>
  );
}

export function MarketingFooter() {
  return (
    <footer className="marketing-footer">
      <MarketingBrand />
      <span>ระบบจัดการร้าน POS, QR ordering, สต็อก, ลงเวลา และรายงานในระบบเดียว</span>
    </footer>
  );
}
