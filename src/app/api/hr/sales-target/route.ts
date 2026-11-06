// แถบเป้ายอดขายวันนี้ (R7, R32, R33): ทุกตำแหน่งในสาขาเดียวกันเห็น · เฉพาะ "วันนี้" ดูย้อนหลังไม่ได้
// ไม่ได้ซื้อแพ็ก / ไม่ได้เปิดสวิตช์ = { enabled: false } โดยไม่ยิง query ยอดขายเลย
import { getCurrentUser, getUserStores, resolveCurrentStore } from "@/modules/auth/session";
import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import { getAdvancedPayrollAccess } from "@/modules/hr/advanced/store-payroll";
import { loadDailySales, loadMaxDailySalesBefore } from "@/modules/hr/advanced/repository";
import { businessDate } from "@/modules/hr/advanced/pay-cycle";
import { tierAmountFor } from "@/modules/hr/advanced/income";
import { logActionError } from "@/modules/system/event-log";

export const dynamic = "force-dynamic";

// ยอดสถิติก่อนวันนี้เปลี่ยนวันละครั้ง — cache ในหน่วยความจำของ instance กันยิง aggregate ทั้งประวัติทุกครั้ง
const recordCache = new Map<string, { value: number; at: number }>();

export async function GET(): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) return Response.json({ enabled: false }, { status: 401 });
  const { organizations, stores, memberships } = await getUserStores();
  const ctx = await resolveCurrentStore(stores, organizations, memberships, user.id);
  if (!ctx) return Response.json({ enabled: false }, { status: 403 });

  try {
    const access = await getAdvancedPayrollAccess(ctx.organizationId, ctx.storeId);
    const sw = access.settings.switches;
    if (!sw.salesTargetBar || !sw.salesBonus) return Response.json({ enabled: false });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- อ่านเวลาปิดร้าน
    const db: any = await createSupabaseServiceClient();
    const { data: store } = await db.from("stores").select("timezone, closing_time").eq("id", ctx.storeId).maybeSingle();
    const tz: string = store?.timezone ?? ctx.storeTimezone ?? "Asia/Bangkok";
    const today = businessDate(new Date(), tz, store?.closing_time ?? null);
    const channels = access.settings.salesBonusChannels;

    const sales = (await loadDailySales(ctx.storeId, today, today, channels)).get(today) ?? 0;
    const cacheKey = `${ctx.storeId}:${today}:${channels.join(",")}`;
    let recordBefore = recordCache.get(cacheKey);
    if (!recordBefore || Date.now() - recordBefore.at > 3_600_000) {
      recordBefore = { value: await loadMaxDailySalesBefore(ctx.storeId, today, channels), at: Date.now() };
      recordCache.set(cacheKey, recordBefore);
    }
    const record = Math.max(access.settings.salesRecordBaseline, recordBefore.value);
    const tiers = access.settings.salesBonusTiers;
    const next = tiers.find((t) => t.minSales > sales) ?? null;

    return Response.json(
      {
        enabled: true,
        date: today,
        sales,
        currentBonus: tierAmountFor(sales, tiers),
        nextTier: next,
        remaining: next ? Math.max(0, Math.round((next.minSales - sales) * 100) / 100) : 0,
        topTier: tiers[tiers.length - 1] ?? null,
        isRecord: sales > 0 && sales > record && access.settings.salesRecordBonus > 0,
        recordBonus: access.settings.salesRecordBonus,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    logActionError({ source: "hr.sales-target", action: "GET", error, storeId: ctx.storeId, organizationId: ctx.organizationId });
    return Response.json({ enabled: false }, { status: 500 });
  }
}
