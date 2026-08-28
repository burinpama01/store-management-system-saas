// Cron: activation nudges (F5/Task 12) — วันละครั้งต่อ store/step (Asia/Bangkok)
// เรียกโดย Vercel Cron (Authorization: Bearer $CRON_SECRET เมื่อมี env CRON_SECRET)
// กติกาตามแผน: opt-out/respect notification settings, query readiness ซ้ำก่อนส่ง,
// หยุดเมื่อมี first paid order, idempotency store+step+date (atomic claim)
import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import { parseSetupProfileOrNull } from "@/modules/onboarding/setup-profile";
import { bangkokDateIso, pickActivationNudge } from "@/modules/onboarding/nudges";
import { notifyOwnerNow } from "@/modules/notifications/dispatcher";

export const dynamic = "force-dynamic";

const STEP_COPY: Record<string, { title: string; message: string }> = {
  "store-profile": {
    title: "ตั้งค่าข้อมูลร้านให้ครบ",
    message: "ร้านของคุณยังไม่ได้กรอกชื่อ/ที่อยู่/เบอร์โทรให้ครบ — กรอกเสร็จจะพร้อมออกใบเสร็จ เปิดที่ StoreOS > ตั้งค่า > ร้านค้า",
  },
  catalog: { title: "เพิ่มเมนูสินค้าแรก", message: "ยังไม่มีสินค้าในระบบ — เพิ่มเมนูแรกที่ StoreOS > เมนูสินค้า แล้วเริ่มขายได้เลย" },
  table: { title: "ตั้งค่าโต๊ะและ QR", message: "ร้านใช้โต๊ะแต่ยังไม่มีโต๊ะในระบบ — เพิ่มโต๊ะที่ StoreOS > ตั้งค่า > โต๊ะ & QR" },
  printer: { title: "เชื่อมเครื่องพิมพ์", message: "ยังไม่มีเครื่องพิมพ์ที่ตั้งค่า — เชื่อมได้ที่ StoreOS > ตั้งค่า > Print Hub หรืออุปกรณ์นี้" },
  "first-paid-order": { title: "ปิดบิลแรกของวันนี้", message: "เหลือขั้นสุดท้าย! เปิดบิลที่ POS แล้วรับเงิน 1 บิล = ร้านพร้อมขายจริง" },
};

export async function GET(req: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  if (!secret || auth !== `Bearer ${secret}`) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }

  const supabase = await createSupabaseServiceClient();
  const now = new Date();
  const today = bangkokDateIso(now);

  const storesRes = await supabase
    .from("stores")
    .select("id, organization_id, name, address, phone, setup_profile")
    .eq("is_active", true);
  if (storesRes.error) {
    return new Response(JSON.stringify({ error: storesRes.error.message }), { status: 500, headers: { "content-type": "application/json" } });
  }
  const stores = (storesRes.data ?? []) as Array<{ id: string; organization_id: string; name: string; address: string | null; phone: string | null; setup_profile: unknown }>;

  const claimed: Array<{ storeId: string; step: string; sent: boolean }> = [];
  const skipped: Array<{ storeId: string; reason: string }> = [];

  for (const store of stores) {
    const countRows = async (table: "products" | "tables" | "printers" | "customers" | "orders", extra?: Record<string, string>) => {
      let q = supabase.from(table).select("id", { count: "exact", head: true }).eq("store_id", store.id).eq("organization_id", store.organization_id);
      if (extra) for (const [k, v] of Object.entries(extra)) q = q.eq(k, v);
      const res = await q;
      return res.error ? 0 : res.count ?? 0;
    };
    const [products, tables, printers, members, paidOrders] = await Promise.all([
      countRows("products"),
      countRows("tables"),
      countRows("printers"),
      countRows("customers"),
      countRows("orders", { status: "paid" }),
    ]);

    // activation_nudge_log is intentionally NOT typed in database.types — including it
    // collapses supabase-js generics repo-wide (TS instantiation budget, see log 2026-08-28).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nudgeLogTable = supabase.from("activation_nudge_log") as any;
    const nudgedTodayRes = await nudgeLogTable
      .select("step")
      .eq("store_id", store.id)
      .eq("nudged_on", today);
    const nudgedStepsToday = (nudgedTodayRes.data ?? []) as Array<string>;

    const nudge = pickActivationNudge({
      storeId: store.id,
      readiness: {
        profileComplete: Boolean(store.name?.trim() && store.address?.trim() && store.phone?.trim()),
        products,
        tables,
        printers,
        members,
        paidOrders,
      },
      profile: parseSetupProfileOrNull(store.setup_profile),
      nudgedStepsToday,
      optedOut: false,
      now,
    });
    if (!nudge) {
      skipped.push({ storeId: store.id, reason: "not_needed_or_already_nudged" });
      continue;
    }

    const claim = await nudgeLogTable
      .insert({ store_id: store.id, step: nudge.step, nudged_on: today })
      .select("id");
    if (claim.error || !claim.data || (claim.data as Array<{ id: string }>).length === 0) {
      skipped.push({ storeId: store.id, reason: claim.error ? `claim_error:${claim.error.message}` : "already_claimed" });
      continue;
    }

    const copy = STEP_COPY[nudge.step] ?? { title: "ตั้งค่าร้านต่อ", message: "ทำตามขั้นตอนใน StoreOS ต่อได้เลย" };
    notifyOwnerNow({
      type: "activation_nudge",
      destination: "owner",
      title: copy.title,
      message: `${copy.message} (ร้าน: ${store.name})`,
      organizationId: store.organization_id,
      storeId: store.id,
      metadata: { step: nudge.step, requestId: nudge.idempotencyKey },
    });
    claimed.push({ storeId: store.id, step: nudge.step, sent: true });
  }

  return new Response(JSON.stringify({ ok: true, day: today, claimedCount: claimed.length, skippedCount: skipped.length, claimed, skipped }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}