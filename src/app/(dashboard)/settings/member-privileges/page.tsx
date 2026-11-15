import { redirect } from "next/navigation";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { getOrganizationBillingState } from "@/modules/billing/billing-service";
import { DEFAULT_BILLING_STATE } from "@/modules/billing/types";
import { canUseMemberPrivileges, MEMBER_PRIVILEGES_LOCK_MESSAGE } from "@/modules/members/access";
import { isMemberCodeEnabled } from "@/modules/members/repository";
import { isOpsManagerRole } from "@/modules/operations/access";
import { MemberCodeToggle } from "./MemberCodeToggle";

export const dynamic = "force-dynamic";

export default async function MemberPrivilegesSettingsPage() {
  const { ctx, resolved } = await getResolvedCurrentPermissions();
  if (!resolved.can("settings.view")) redirect("/dashboard");
  if (!isOpsManagerRole(ctx.role)) redirect("/settings/store");

  const billing = (await getOrganizationBillingState(ctx.organizationId)) ?? DEFAULT_BILLING_STATE;
  const allowed = canUseMemberPrivileges(billing);
  const enabled = await isMemberCodeEnabled(ctx.storeId);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-bold text-gray-900">สิทธิ์สมาชิก</h2>
        <p className="text-sm text-gray-600">
          รหัสยืนยันสมาชิก 6 หลักจากมือถือลูกค้า อายุ 5 นาทีและใช้ได้ครั้งเดียว — เป็นด่านยืนยันตัวก่อนใช้แพ็กซื้อล่วงหน้า
          และส่วนลดระดับสมาชิก (กำลังพัฒนา) เบอร์เดียวกันถือเป็นสมาชิกคนเดียวกันทุกสาขา
        </p>
      </div>

      {!allowed && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">{MEMBER_PRIVILEGES_LOCK_MESSAGE}</p>
      )}

      <MemberCodeToggle enabled={enabled} allowed={allowed} />

      <div className="rounded-lg border border-gray-200 bg-white p-4 text-sm text-gray-700">
        <p className="font-semibold text-gray-900">วิธีใช้</p>
        <ol className="mt-2 list-decimal space-y-1 pl-5">
          <li>ลูกค้าเปิดหน้าสมาชิก (สแกน QR สมาชิกของร้าน) แล้วกด “แสดงรหัสใช้สิทธิ์”</li>
          <li>แคชเชียร์เปิดแผงลูกค้าใน POS แล้วสแกน QR หรือพิมพ์รหัส 6 หลักในช่อง “ยืนยันด้วยรหัสสมาชิก”</li>
          <li>ระบบผูกสมาชิกกับบิลและแสดง “ยืนยันด้วยรหัสแล้ว” — สมาชิกจากสาขาอื่นจะถูกสร้างในสาขานี้ให้อัตโนมัติ</li>
          <li>ลูกค้าไม่มีมือถือ: ค้นด้วยเบอร์ได้เพื่อสะสมแต้มตามเดิม แต่จะใช้สิทธิ์แพ็ก/ระดับไม่ได้</li>
        </ol>
        <p className="mt-2 text-xs text-gray-500">กรอกรหัสผิด 5 ครั้งใน 10 นาที ระบบจะล็อกพนักงานคนนั้นไว้ 10 นาที</p>
      </div>
    </div>
  );
}
