import Link from "next/link";
import { redirect } from "next/navigation";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { getOrganizationBillingState } from "@/modules/billing/billing-service";
import { DEFAULT_BILLING_STATE, getPlanFeatures } from "@/modules/billing/types";
import { getStore } from "@/modules/stores/repository";
import { getMusicPlayerSettings, getNowPlaying } from "@/modules/music-requests/repository";
import { PlayerApp } from "./PlayerApp";

export const dynamic = "force-dynamic";

export default async function PlayerPage({
  params,
}: {
  params: Promise<{ storeSlug: string }>;
}) {
  const { storeSlug } = await params;
  const { ctx, resolved } = await getResolvedCurrentPermissions();
  if (!resolved.can("orders.manage_qr")) redirect("/dashboard");

  const billing =
    (await getOrganizationBillingState(ctx.organizationId)) ?? DEFAULT_BILLING_STATE;
  const storeRes = await getStore(ctx.storeId);
  const store = storeRes.data;
  if (!getPlanFeatures(billing).musicRequest || !store || store.musicLicenseStatus !== "approved") {
    redirect("/dashboard");
  }
  if (store.slug !== storeSlug) redirect(`/player/${store.slug}`);

  const settingsRes = await getMusicPlayerSettings(ctx.storeId, ctx.organizationId);
  if (!settingsRes.data?.playerEnabled) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-black p-8 text-center text-white">
        <p className="text-2xl">🎵</p>
        <p className="mt-3 text-lg font-semibold">เครื่องเล่นเพลงยังไม่เปิดใช้งาน</p>
        <Link href="/settings/music-player" className="mt-4 rounded-lg bg-white/10 px-4 py-2 text-sm">
          ไปตั้งค่าเครื่องเล่นเพลง
        </Link>
      </main>
    );
  }

  const npRes = await getNowPlaying(ctx.storeId);

  return <PlayerApp storeName={store.name} initialNowPlaying={npRes.data} />;
}
