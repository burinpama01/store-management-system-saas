import Link from "next/link";
import { redirect } from "next/navigation";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { getOrganizationBillingState } from "@/modules/billing/billing-service";
import { DEFAULT_BILLING_STATE } from "@/modules/billing/types";
import { listCategories, listProducts } from "@/modules/catalog/repository";
import { canUseMemberPrivileges } from "@/modules/members/access";
import { isMemberCodeEnabled } from "@/modules/members/repository";
import { getMissionSmsUsage, isMissionsEnabled, listStoreMissions } from "@/modules/missions/repository";
import { isOpsManagerRole } from "@/modules/operations/access";
import { MissionManager } from "./MissionManager";

export const dynamic = "force-dynamic";

export default async function StoreMissionsPage() {
  const { ctx, resolved } = await getResolvedCurrentPermissions();
  if (!resolved.can("settings.view")) redirect("/dashboard");
  if (!isOpsManagerRole(ctx.role)) redirect("/customers");

  const billing = (await getOrganizationBillingState(ctx.organizationId)) ?? DEFAULT_BILLING_STATE;
  if (!canUseMemberPrivileges(billing)) {
    return (
      <div className="space-y-4 p-4">
        <h1 className="text-xl font-bold text-gray-900">ภารกิจสะสม</h1>
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">ภารกิจสะสมใช้ได้เฉพาะแพ็กเกจ Enterprise</p>
      </div>
    );
  }

  const [missionsRes, productsRes, categoriesRes, enabled, codeEnabled, sms] = await Promise.all([
    listStoreMissions(ctx.storeId),
    listProducts(ctx.storeId, { includeInactive: false }),
    listCategories(ctx.storeId),
    isMissionsEnabled(ctx.storeId),
    isMemberCodeEnabled(ctx.storeId),
    getMissionSmsUsage(ctx.storeId),
  ]);
  const products = (productsRes.data ?? []).map((p) => ({ id: p.id, name: p.name, price: p.basePrice, categoryId: p.categoryId }));
  const categories = (categoriesRes.data ?? []).map((c) => ({ id: c.id, name: c.name }));

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4">
      <div>
        <h1 className="text-xl font-bold text-gray-900">ภารกิจสะสม</h1>
        <p className="text-sm text-gray-600">
          ลูกค้ากด “รับภารกิจ” ในหน้าสมาชิก แล้วซื้อสินค้าตามที่กำหนด ระบบนับให้อัตโนมัติตอนบิลจ่ายสำเร็จ (ต้องผูกเบอร์ลูกค้าในบิล)
          ครบเป้าได้คูปองรางวัลทันที — ใช้คูปองต้องแสดงรหัสสมาชิก 5 นาที
        </p>
      </div>
      {!codeEnabled && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          สาขานี้ยังปิดรหัสยืนยันสมาชิก — ลูกค้าสะสมได้ แต่จะใช้คูปองรางวัลไม่ได้จนกว่าจะเปิดที่{" "}
          <Link className="font-semibold underline" href="/settings/member-privileges">ตั้งค่า › สิทธิ์สมาชิก</Link>
        </p>
      )}
      <p className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs text-gray-600">
        📩 SMS แจ้งลูกค้า (ใกล้ครบ / ได้คูปอง / คูปองใกล้หมด) เดือนนี้ส่งแล้ว {sms.sent}/{sms.limit} ข้อความ — ช่วงทดลอง StoreOS ออกค่า SMS ให้
        {sms.skippedQuota > 0 ? ` · ข้ามเพราะเกินโควตา ${sms.skippedQuota} ข้อความ` : ""} · ส่งเฉพาะลูกค้าที่ยินยอม ไม่เกิน 3 ข้อความทุก 7 วัน ช่วง 09:00–20:00
      </p>
      {missionsRes.error && <p className="alert-danger" role="alert">โหลดภารกิจไม่สำเร็จ: {missionsRes.error}</p>}
      <MissionManager enabled={enabled} missions={missionsRes.data ?? []} products={products} categories={categories} />
    </div>
  );
}
