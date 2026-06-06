import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { SettingsNav } from "./SettingsNav";

export const dynamic = "force-dynamic";

export default async function SettingsLayout({ children }: { children: ReactNode }) {
  const { resolved } = await getResolvedCurrentPermissions();
  if (!resolved.can("settings.view")) redirect("/");

  return (
    <div className="page-shell">
      <div className="page-header">
        <div>
          <h1 className="page-title">ตั้งค่า</h1>
          <p className="page-kicker">จัดการร้านค้า ทีมงาน ใบเสร็จ และสิทธิ์การใช้งาน</p>
        </div>
      </div>
      <SettingsNav />
      {children}
    </div>
  );
}
