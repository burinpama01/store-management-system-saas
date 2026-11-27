import Link from "next/link";
import { getTierProgram } from "@/modules/member-tiers/repository";
import { redirect } from "next/navigation";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { getOrganizationBillingState } from "@/modules/billing/billing-service";
import { DEFAULT_BILLING_STATE, getPlanFeatures } from "@/modules/billing/types";
import { canUseMemberPrivileges } from "@/modules/members/access";
import { isOpsManagerRole } from "@/modules/operations/access";
import { getOnlineOrderSettingsWithOrigin } from "@/modules/online-orders/repository";
import { listKitchenStations } from "@/modules/qr-ordering/kitchen-stations";
import { getReceiptSettings } from "@/modules/settings/repository";
import { listPrinters } from "@/modules/stores/repository";
import { getStoreWebsite } from "@/modules/store-website/repository";
import { listOnlineOrdersAction } from "./actions";
import { OnlineOrdersBoard } from "./OnlineOrdersBoard";
import { OnlineOrderSettingsForm } from "./OnlineOrderSettingsForm";

export const dynamic = "force-dynamic";

export default async function OnlineOrdersPage() {
  const { ctx, resolved } = await getResolvedCurrentPermissions();
  if (!resolved.can("orders.manage_qr")) redirect("/dashboard");
  const billing = (await getOrganizationBillingState(ctx.organizationId)) ?? DEFAULT_BILLING_STATE;
  if (!canUseMemberPrivileges(billing) || !getPlanFeatures(billing).byoPaymentGateway) {
    return (
      <div className="page-shell">
        <div className="panel p-6">
          <h1 className="page-title">สั่งออนไลน์</h1>
          <p className="text-sm text-[var(--muted)]">สั่งออนไลน์ผ่านเว็บร้านใช้ได้เฉพาะแพ็กเกจ Enterprise</p>
        </div>
      </div>
    );
  }

  const [{ settings, originFromAttendance }, site, list, stations, receipt, printersRes, tierProgram] = await Promise.all([
    getOnlineOrderSettingsWithOrigin(ctx.storeId),
    getStoreWebsite(ctx.storeId),
    listOnlineOrdersAction(),
    listKitchenStations(ctx.storeId),
    getReceiptSettings(ctx.storeId, ctx.organizationId),
    listPrinters(ctx.storeId, ctx.organizationId),
    // R3: ระดับสมาชิก (ตั้งเพดานเก็บเงินปลายทางรายระดับ) — ไม่มีโปรแกรมระดับ = ไม่มีรายการ
    getTierProgram(ctx.organizationId).catch(() => null),
  ]);
  const memberTiers = (tierProgram?.tiers ?? []).map((t) => ({ rank: t.rank, name: t.name }));
  const stationPrinters = (stations.data ?? [])
    .filter((s) => s.printerId)
    .map((s) => ({ id: s.id, name: s.name, printerId: s.printerId as string }));
  const canConfigure = isOpsManagerRole(resolved.role);

  return (
    <div className="page-shell space-y-4">
      <div className="panel flex flex-wrap items-center justify-between gap-2 p-4">
        <div>
          <h1 className="page-title">สั่งออนไลน์ (เว็บร้าน)</h1>
          <p className="text-sm text-[var(--muted)]">
            ลูกค้าจ่าย QR พร้อมเพย์ผ่าน Beam ก่อน — กด “รับออเดอร์” แล้วระบบเปิดบิลและปิดบิลด้วยเงินที่ได้รับให้เอง
          </p>
        </div>
        <div className="flex gap-2 text-sm">
          <Link href="/website" className="btn-secondary">แก้เว็บไซต์ร้าน</Link>
          {settings.deliveryEnabled && <Link href="/rider" className="btn-secondary">🛵 หน้าคนส่ง</Link>}
          {site?.slug && settings.enabled && (
            <a href={`/s/${site.slug}/order`} target="_blank" rel="noreferrer" className="btn-secondary">เปิดหน้าสั่งของลูกค้า</a>
          )}
        </div>
      </div>
      {list.error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">โหลดออเดอร์ไม่สำเร็จ: {list.error}</p>}
      <OnlineOrdersBoard
        initialOrders={list.orders}
        canCancel={canConfigure}
        storeName={ctx.storeName ?? ""}
        stationPrinters={stationPrinters}
        paperWidth={receipt.data?.paperWidth === "58mm" ? "58mm" : "80mm"}
        printers={printersRes.data ?? []}
      />
      {canConfigure ? (
        <OnlineOrderSettingsForm initial={settings} hasWebsite={Boolean(site)} originFromAttendance={originFromAttendance} memberTiers={memberTiers} />
      ) : (
        <p className="text-xs text-[var(--muted)]">ตั้งค่าสั่งออนไลน์ได้เฉพาะเจ้าของหรือแอดมิน</p>
      )}
    </div>
  );
}
