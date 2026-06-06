import { requireSystemAccess } from "@/modules/auth/guards";
import { getPlatformSettings } from "@/modules/billing/platform-settings";
import { isSlip2goConfigured } from "@/modules/billing/slip2go";
import { SystemSettingsForm } from "./SystemSettingsForm";

export const dynamic = "force-dynamic";

export default async function SystemSettingsPage() {
  await requireSystemAccess();
  const settings = await getPlatformSettings();

  return (
    <div className="space-y-5">
      <div className="page-header">
        <div>
          <h1 className="page-title">ตั้งค่าแพลตฟอร์ม</h1>
          <p className="page-kicker">ช่องทางรับชำระเงินค่าสมาชิก SaaS</p>
        </div>
      </div>
      <SystemSettingsForm settings={settings} slipReady={isSlip2goConfigured()} />
    </div>
  );
}
