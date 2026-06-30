// Webhook ขาเข้าจาก JDC: order.created (ออเดอร์ใหม่) / order.status (สถานะเปลี่ยนจากแอป JDC)
// auth ด้วย HMAC (webhook_secret ของ link) + timestamp กัน replay. ตอบ 202 เร็ว.
import { getActiveLinkByMerchant, recordEvent } from "@/modules/connect/repository";
import { isFreshTimestamp, verifyConnectSignature } from "@/modules/connect/hmac";
import { processInboundOrder } from "@/modules/connect/order-ingestion";
import { applyInboundStatus } from "@/modules/connect/status-sync";
import { getOrganizationBillingState } from "@/modules/billing/billing-service";
import { getJdcWebhookSecret } from "@/modules/billing/platform-settings";
import { canUseFeature, DEFAULT_BILLING_STATE } from "@/modules/billing/types";
import type { InboundOrderPayload } from "@/modules/connect/types";

export const dynamic = "force-dynamic";

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export async function POST(req: Request): Promise<Response> {
  const raw = await req.text();

  let payload: InboundOrderPayload;
  try {
    payload = JSON.parse(raw) as InboundOrderPayload;
  } catch {
    return json(400, { error: "Invalid JSON" });
  }

  const merchantId = payload.merchant_id;
  if (!merchantId || !payload.booking_id || !payload.topic) {
    return json(400, { error: "Missing merchant_id/booking_id/topic" });
  }

  const link = await getActiveLinkByMerchant(merchantId);
  if (!link) return json(404, { error: "No active channel link for merchant" });

  // ตรวจ signature + timestamp (HMAC ด้วย shared secret ระดับแพลตฟอร์ม — JDC ออกชุดเดียวทั้งระบบ)
  const webhookSecret = await getJdcWebhookSecret();
  if (!webhookSecret) {
    return json(503, { error: "Connect not configured (missing JDC webhook secret)" });
  }
  const signature = req.headers.get("x-connect-signature");
  if (!verifyConnectSignature(raw, webhookSecret, signature)) {
    return json(401, { error: "Invalid signature" });
  }
  if (!isFreshTimestamp(payload.ts)) {
    return json(401, { error: "Stale timestamp" });
  }

  // billing gate (Enterprise apiIntegration)
  const billing =
    (await getOrganizationBillingState(link.organizationId)) ?? DEFAULT_BILLING_STATE;
  if (!canUseFeature(billing, "apiIntegration")) {
    return json(403, { error: "API access requires the Enterprise plan" });
  }

  try {
    if (payload.topic === "order.created") {
      const res = await processInboundOrder(link, payload);
      if (!res.ok) return json(500, { error: res.error ?? "ingest failed" });
      return json(202, { received: true, duplicate: res.duplicate ?? false });
    }
    if (payload.topic === "order.status") {
      await applyInboundStatus(link, payload.booking_id, payload.status);
      return json(202, { received: true });
    }
    return json(400, { error: `Unknown topic: ${payload.topic}` });
  } catch (e) {
    await recordEvent({
      linkId: link.id,
      direction: "inbound",
      topic: payload.topic,
      payload: { booking_id: payload.booking_id },
      status: "failed",
      lastError: e instanceof Error ? e.message : "unknown",
    });
    return json(500, { error: "Processing error" });
  }
}
