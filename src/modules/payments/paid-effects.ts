import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import { notifyOnlineOrderPaidOnce } from "@/modules/online-orders/notify";
import { notifyPassPurchasePaidOnce } from "@/modules/prepaid-passes/notify";
import { notifyAdOrderPaidOnce } from "@/modules/ad-self-serve/notify";
import { logSystemEvent } from "@/modules/system/event-log";

/**
 * หลัง gateway_payments เป็น PAID (webhook หรือถาม Beam) — แจ้งร้านตามสิ่งที่ผูกกับการจ่าย
 * ออเดอร์ออนไลน์/แพ็ก ถูกเลื่อนสถานะโดย trigger ใน DB แล้ว ที่นี่แค่แจ้ง (กันซ้ำด้วย notified_at)
 * ห้ามโยน error — การแจ้งพังต้องไม่ทำให้ webhook ตอบผิด
 */
export async function runGatewayPaidEffects(gatewayPaymentId: string): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- column ใหม่ยังไม่อยู่ใน database.types
    const db: any = await createSupabaseServiceClient();
    const { data } = await db
      .from("gateway_payments")
      .select("id, status, online_order_id, prepaid_pass_purchase_id, ad_order_id")
      .eq("id", gatewayPaymentId)
      .maybeSingle();
    if (!data || data.status !== "PAID") return;
    if (data.online_order_id) await notifyOnlineOrderPaidOnce(String(data.online_order_id));
    if (data.prepaid_pass_purchase_id) await notifyPassPurchasePaidOnce(String(data.prepaid_pass_purchase_id));
    if (data.ad_order_id) await notifyAdOrderPaidOnce(String(data.ad_order_id));
  } catch (e) {
    await logSystemEvent({
      level: "warn",
      source: "payments.paid-effects",
      action: "runGatewayPaidEffects",
      message: `แจ้งร้านหลังรับเงินไม่สำเร็จ: ${e instanceof Error ? e.message : String(e)}`,
      context: { gatewayPaymentId },
    }).catch(() => undefined);
  }
}
