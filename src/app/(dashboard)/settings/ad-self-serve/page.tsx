import { headers } from "next/headers";
import { redirect } from "next/navigation";
import Link from "next/link";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { getOrganizationBillingState } from "@/modules/billing/billing-service";
import { DEFAULT_BILLING_STATE, getPlanFeatures } from "@/modules/billing/types";
import { getStore } from "@/modules/stores/repository";
import { getStoreAdOffer } from "@/modules/ad-self-serve/repository";
import { buildStoreAdUrl, canUseAdSelfServe, DEFAULT_STORE_AD_OFFER } from "@/modules/ad-self-serve/rules";
import { StoreAdOfferForm } from "./StoreAdOfferForm";
import { StoreAdQrCard } from "./StoreAdQrCard";

export const dynamic = "force-dynamic";

/** โดเมนเดียวกับที่พนักงานเปิดหน้านี้อยู่ (แบบเดียวกับ QR ขอเพลง) */
async function requestOrigin(): Promise<string> {
  const h = await headers();
  const host = h.get("host") ?? "";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return host ? `${proto}://${host}` : "";
}

export default async function AdSelfServeSettingsPage() {
  const { ctx, resolved } = await getResolvedCurrentPermissions();
  if (!resolved.can("settings.view")) redirect("/dashboard");
  if (!resolved.can("settings.manage_store")) redirect("/settings/store");

  const billing = (await getOrganizationBillingState(ctx.organizationId)) ?? DEFAULT_BILLING_STATE;
  const features = getPlanFeatures(billing);
  if (!features.adSelfServe) redirect("/settings");

  if (!canUseAdSelfServe(features)) {
    return (
      <div className="page-shell space-y-4">
        <h1 className="text-xl font-bold text-[var(--text)]">รับลงโฆษณาผ่าน QR</h1>
        <p className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          ต้องมีฟีเจอร์ <b>จอลูกค้า</b> ด้วย โฆษณาของลูกค้าจะแสดงบนจอลูกค้า —{" "}
          <Link href="/settings/billing" className="underline">เพิ่มจอลูกค้าในแพ็กเกจ</Link>
        </p>
      </div>
    );
  }

  const [offerRes, storeRes, origin] = await Promise.all([
    getStoreAdOffer(ctx.storeId, ctx.organizationId),
    getStore(ctx.storeId),
    requestOrigin(),
  ]);
  const offer = offerRes.data ?? DEFAULT_STORE_AD_OFFER;
  const slug = storeRes.data?.slug ?? null;

  return (
    <div className="page-shell space-y-5">
      <div>
        <h1 className="text-xl font-bold text-[var(--text)]">รับลงโฆษณาผ่าน QR</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">
          ลูกค้าสแกน QR เลือกแพ็ก อัปโหลดวิดีโอ/รูป แล้วจ่ายเงินเข้าบัญชีร้านโดยตรง โฆษณาขึ้นจอลูกค้าเองตามเงื่อนไขที่ตั้งไว้
        </p>
      </div>
      {offerRes.error ? <p className="alert-danger text-sm">{offerRes.error}</p> : null}
      {offer.enabled && slug ? (
        <StoreAdQrCard url={buildStoreAdUrl(origin, slug)} storeName={ctx.storeName} packages={offer.packages} />
      ) : (
        <p className="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] p-3 text-sm text-[var(--muted)]">
          เปิดสวิตช์ &quot;รับลงโฆษณา&quot; แล้วบันทึก จึงจะแสดง QR สำหรับพิมพ์ติดร้าน
        </p>
      )}
      <StoreAdOfferForm offer={offer} />
    </div>
  );
}
