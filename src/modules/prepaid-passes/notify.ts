import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import { notifyOwnerSafely } from "@/modules/notifications/dispatcher";
import { logSystemEvent } from "@/modules/system/event-log";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- column ใหม่ยังไม่อยู่ใน database.types
type LooseClient = any;

/** แจ้งร้านว่าลูกค้าซื้อแพ็กออนไลน์สำเร็จ — ครั้งเดียวต่อคำสั่งซื้อ (claim notified_at) */
export async function notifyPassPurchasePaidOnce(purchaseId: string): Promise<boolean> {
  const db: LooseClient = await createSupabaseServiceClient();
  const { data } = await db
    .from("prepaid_pass_purchases")
    .update({ notified_at: new Date().toISOString() })
    .eq("id", purchaseId)
    .eq("status", "paid")
    .is("notified_at", null)
    .select("id, organization_id, store_id, plan_name, amount, credits")
    .maybeSingle();
  if (!data) return false;
  const amount = Number(data.amount ?? 0);
  notifyOwnerSafely({
    type: "pass_purchase",
    organizationId: data.organization_id,
    storeId: data.store_id,
    title: "ลูกค้าซื้อแพ็กล่วงหน้า",
    message: `${data.plan_name} ยอด ${amount.toFixed(2)} (จ่ายออนไลน์แล้ว)`,
    metadata: { purchaseId: data.id, planName: data.plan_name, amount, credits: data.credits },
  });
  void logSystemEvent({
    level: "info",
    source: "prepaid-passes",
    action: "passPurchasePaid",
    message: `ลูกค้าซื้อแพ็ก ${data.plan_name} ออนไลน์สำเร็จ — แจ้งร้าน`,
    organizationId: data.organization_id,
    storeId: data.store_id,
    context: { purchaseId: data.id, amount },
  });
  return true;
}
