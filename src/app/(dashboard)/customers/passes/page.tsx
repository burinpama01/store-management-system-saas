import Link from "next/link";
import { redirect } from "next/navigation";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { getOrganizationBillingState } from "@/modules/billing/billing-service";
import { DEFAULT_BILLING_STATE } from "@/modules/billing/types";
import { listProducts } from "@/modules/catalog/repository";
import { canUseMemberPrivileges, MEMBER_PRIVILEGES_LOCK_MESSAGE } from "@/modules/members/access";
import { isMemberCodeEnabled } from "@/modules/members/repository";
import { isOpsManagerRole } from "@/modules/operations/access";
import { listPassPlans } from "@/modules/prepaid-passes/repository";
import { DEFAULT_PREPAID_PASS_TERMS } from "@/modules/prepaid-passes/rules";
import { PassPlanManager } from "./PassPlanManager";

export const dynamic = "force-dynamic";

export default async function PrepaidPassesPage() {
  const { ctx, resolved } = await getResolvedCurrentPermissions();
  if (!resolved.can("settings.view")) redirect("/dashboard");
  if (!isOpsManagerRole(ctx.role)) redirect("/customers");

  const billing = (await getOrganizationBillingState(ctx.organizationId)) ?? DEFAULT_BILLING_STATE;
  if (!canUseMemberPrivileges(billing)) {
    return (
      <div className="space-y-4 p-4">
        <h1 className="text-xl font-bold text-gray-900">แพ็กซื้อล่วงหน้า</h1>
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">{MEMBER_PRIVILEGES_LOCK_MESSAGE}</p>
      </div>
    );
  }

  const [plansRes, productsRes, codeEnabled] = await Promise.all([
    listPassPlans(ctx.storeId),
    listProducts(ctx.storeId, { includeInactive: false }),
    isMemberCodeEnabled(ctx.storeId),
  ]);
  const plans = plansRes.data ?? [];
  const saleIds = new Set(plans.map((plan) => plan.saleProductId));
  const menu = (productsRes.data ?? [])
    .filter((product) => !saleIds.has(product.id))
    .map((product) => ({ id: product.id, name: product.name, price: product.basePrice }));

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4">
      <div>
        <h1 className="text-xl font-bold text-gray-900">แพ็กซื้อล่วงหน้า</h1>
        <p className="text-sm text-gray-600">
          ขายสิทธิ์ล่วงหน้า เช่น อเมริกาโน่ 10 แก้ว ฿350 — ลูกค้าใช้สิทธิ์ได้ทีละแก้วโดยแสดงรหัส 5 นาทีจากหน้าสมาชิก
          ระบบสร้างสินค้า “ขายแพ็ก” ในหมวด แพ็กล่วงหน้า ให้อัตโนมัติ ขายผ่าน POS ได้ทันที
        </p>
      </div>
      {!codeEnabled && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          สาขานี้ยังปิดรหัสยืนยันสมาชิกอยู่ — ขายแพ็กได้ แต่ลูกค้าจะใช้สิทธิ์ไม่ได้จนกว่าจะเปิดที่{" "}
          <Link className="font-semibold underline" href="/settings/member-privileges">ตั้งค่า › สิทธิ์สมาชิก</Link>
        </p>
      )}
      {plansRes.error && <p className="alert-danger" role="alert">โหลดแพ็กไม่สำเร็จ: {plansRes.error}</p>}
      <p className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs text-gray-600">
        ⚖️ เงื่อนไข “ไม่คืนเงิน” อาจขัดกฎหมายคุ้มครองผู้บริโภคในบางกรณี (เช่น ร้านปิดกิจการ) แนะนำให้ปรึกษาที่ปรึกษากฎหมายก่อนขายจริง
      </p>
      <PassPlanManager plans={plans} menu={menu} defaultTerms={DEFAULT_PREPAID_PASS_TERMS} />
    </div>
  );
}
