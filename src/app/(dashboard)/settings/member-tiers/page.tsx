import { redirect } from "next/navigation";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { getOrganizationBillingState } from "@/modules/billing/billing-service";
import { DEFAULT_BILLING_STATE } from "@/modules/billing/types";
import { canUseMemberPrivileges } from "@/modules/members/access";
import { isOpsManagerRole } from "@/modules/operations/access";
import { getTierProgram, listTierBenefits } from "@/modules/member-tiers/repository";
import { DEFAULT_TIERS } from "@/modules/member-tiers/rules";
import { TierProgramManager } from "./TierProgramManager";
import { TierBenefitsEditor } from "./TierBenefitsEditor";

export const dynamic = "force-dynamic";

export default async function MemberTiersSettingsPage() {
  const { ctx, resolved } = await getResolvedCurrentPermissions();
  if (!resolved.can("settings.view")) redirect("/dashboard");
  if (!isOpsManagerRole(ctx.role)) redirect("/settings/store");

  const billing = (await getOrganizationBillingState(ctx.organizationId)) ?? DEFAULT_BILLING_STATE;
  const allowed = canUseMemberPrivileges(billing);
  const program = allowed ? await getTierProgram(ctx.organizationId) : null;
  const benefits = program ? await listTierBenefits(ctx.organizationId) : [];

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-bold text-gray-900">ระดับสมาชิก</h2>
        <p className="text-sm text-gray-600">
          แบบ Shopee Rewards — นับยอดซื้อ/จำนวนบิลของสมาชิกทุกสาขาในรอบ ขึ้นระดับทันทีเมื่อถึงเกณฑ์ ครบรอบแล้วยอดไม่ถึงเกณฑ์ระดับเดิมจะลดระดับ
          แต้มสะสมเดิมไม่เกี่ยวและไม่ถูกรีเซ็ต · ตั้งค่าครั้งเดียวใช้ทั้งองค์กร
        </p>
      </div>
      {!allowed ? (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">ระดับสมาชิกใช้ได้เฉพาะแพ็กเกจ Enterprise</p>
      ) : (
        <>
          <TierProgramManager program={program} defaultTiers={DEFAULT_TIERS} />
          {program && <TierBenefitsEditor benefits={benefits} tiers={program.tiers} />}
        </>
      )}
    </div>
  );
}
