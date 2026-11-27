import { redirect } from "next/navigation";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { getOrganizationBillingState } from "@/modules/billing/billing-service";
import { DEFAULT_BILLING_STATE, getPlanFeatures } from "@/modules/billing/types";
import { canUseMemberPrivileges } from "@/modules/members/access";
import { isOnlineOrderingEnabled } from "@/modules/online-orders/repository";
import { RiderApp } from "./RiderApp";

export const dynamic = "force-dynamic";
export const metadata = { title: "หน้าคนส่ง" };

/** หน้าคนส่ง (R4) — มือถือของพนักงาน: รับงานออนไลน์ส่งถึงบ้าน + โหมดขับนำทาง */
export default async function RiderPage() {
  const { ctx, resolved } = await getResolvedCurrentPermissions();
  if (!resolved.can("pos.use")) redirect("/dashboard");
  const billing = (await getOrganizationBillingState(ctx.organizationId)) ?? DEFAULT_BILLING_STATE;
  const entitled = canUseMemberPrivileges(billing) && getPlanFeatures(billing).byoPaymentGateway;
  const enabled = entitled && (await isOnlineOrderingEnabled(ctx.storeId));
  if (!enabled) {
    return (
      <main className="mx-auto max-w-md p-6 text-center text-sm text-gray-600">
        หน้าคนส่งใช้ได้เมื่อร้านเปิด “สั่งออนไลน์ (ส่งถึงบ้าน)” — แพ็กเกจ Enterprise
      </main>
    );
  }
  return (
    <RiderApp
      storeName={ctx.storeName ?? ""}
      // แผนที่ในหน้าเว็บใช้ key ฝั่งเบราว์เซอร์แยก (จำกัดโดเมน) — ไม่ตั้ง = นำทางด้วยแอป Google Maps อย่างเดียว
      browserMapsKey={process.env.NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY?.trim() || null}
      // Map ID แบบ vector ทำให้แผนที่หมุนตามทิศได้ — ไม่ตั้ง = แผนที่หันทิศเหนือ ลูกศรหมุนแทน
      mapId={process.env.NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID?.trim() || null}
    />
  );
}
