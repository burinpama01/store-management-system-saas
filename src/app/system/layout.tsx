import type { ReactNode } from "react";
import Link from "next/link";
import { requireSystemAccess } from "@/modules/auth/guards";
import { signOut } from "../(dashboard)/actions";
import { SystemNav } from "./SystemNav";

export const dynamic = "force-dynamic";

export default async function SystemLayout({ children }: { children: ReactNode }) {
  const user = await requireSystemAccess();

  return (
    <div className="min-h-screen bg-[var(--canvas)]">
      <header className="topbar gap-3">
        <div className="flex items-center gap-2">
          <span className="badge badge-warning">Platform Console</span>
          <span className="page-title">StoreOS System</span>
        </div>
        <div className="flex-1" />
        <Link href="/dashboard" className="btn-secondary text-xs">
          กลับสู่ร้านค้า
        </Link>
        <span className="hidden text-xs text-[var(--muted)] sm:inline">{user.email}</span>
        <form action={signOut}>
          <button type="submit" className="btn-secondary text-xs">
            ออกจากระบบ
          </button>
        </form>
      </header>
      <main className="page-shell">
        <SystemNav />
        {children}
      </main>
    </div>
  );
}
