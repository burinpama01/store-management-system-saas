import { redirect } from "next/navigation";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { getOrganizationBillingState } from "@/modules/billing/billing-service";
import { DEFAULT_BILLING_STATE } from "@/modules/billing/types";
import { canUseMemberPrivileges } from "@/modules/members/access";
import { isOpsManagerRole } from "@/modules/operations/access";
import { getStoreWebsite, listWebsiteVersions, loadVerifiedLunarDates, loadWebsiteRenderData } from "@/modules/store-website/repository";
import { activeFestival, pendingLunarFestivals, toFestivalView, upcomingFestivals } from "@/modules/store-website/festivals";
import { normalizeSlug } from "@/modules/store-website/schema";
import { WEBSITE_TEMPLATES } from "@/modules/store-website/templates";
import { WebsiteSetup } from "./WebsiteSetup";
import { WebsiteEditor } from "./WebsiteEditor";

export const dynamic = "force-dynamic";

function siteBase() {
  return (process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || "https://www.store-os.online").replace(/\/$/, "");
}

export default async function WebsitePage() {
  const { ctx, resolved } = await getResolvedCurrentPermissions();
  if (!isOpsManagerRole(resolved.role)) redirect("/dashboard");
  const billing = (await getOrganizationBillingState(ctx.organizationId)) ?? DEFAULT_BILLING_STATE;

  return (
    <div className="page-shell">
      <div className="page-header">
        <div>
          <h1 className="page-title">เว็บไซต์ร้าน</h1>
          <p className="page-kicker">หน้าเว็บของร้านสำหรับแปะใน Facebook, Instagram, LINE — เมนู โปรโมชัน แพ็ก และสมาชิก</p>
        </div>
      </div>
      {canUseMemberPrivileges(billing) ? <WebsiteBody storeId={ctx.storeId} /> : (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">เว็บไซต์ร้านใช้ได้เฉพาะแพ็กเกจ Enterprise</p>
      )}
    </div>
  );
}

async function WebsiteBody({ storeId }: { storeId: string }) {
  const [website, renderData] = await Promise.all([getStoreWebsite(storeId), loadWebsiteRenderData(storeId)]);
  if (!renderData) return <p className="alert-danger">โหลดข้อมูลร้านไม่สำเร็จ</p>;
  if (!website) {
    return <WebsiteSetup templates={WEBSITE_TEMPLATES} defaultSlug={normalizeSlug(renderData.store.slug).slice(0, 40)} siteBase={siteBase()} />;
  }
  const [versions, lunar] = await Promise.all([listWebsiteVersions(storeId), loadVerifiedLunarDates()]);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const settings = website.festivalSettings;
  const currentFestival = toFestivalView(activeFestival(today, settings, lunar), settings);
  const upcoming = upcomingFestivals(today, settings, lunar).map((w) => ({
    key: w.festival.key,
    name: w.festival.name,
    startsOn: w.startsOn,
    endsOn: w.endsOn,
  }));
  return (
    <>
    <div className="page-shell pb-0">
      <a href="/website/orders" className="panel flex items-center justify-between p-3 text-sm hover:bg-[var(--surface-muted,#f5f5f4)]">
        <span>
          <b>สั่งออนไลน์</b> — รับที่ร้าน / ร้านส่งเอง จ่ายด้วย Beam (ตั้งค่าและดูคิวออเดอร์)
        </span>
        <span aria-hidden="true">→</span>
      </a>
    </div>
    <WebsiteEditor
      key={website.updatedAt}
      website={website}
      renderData={renderData}
      templates={WEBSITE_TEMPLATES}
      versions={versions}
      siteBase={siteBase()}
      today={today}
      currentFestival={currentFestival}
      upcomingFestivals={upcoming}
      pendingLunarKeys={pendingLunarFestivals(today, lunar)}
    />
    </>
  );
}
