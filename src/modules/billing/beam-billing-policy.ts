import type { BeamCharge } from "@/modules/payments/beam-client";
import type { Slip2goVerification } from "./slip2go";

export function evaluateBeamBillingCharge(
  order: { id: string; charge_id: string | null; amount: number }, charge: BeamCharge,
): boolean {
  return charge.status === "SUCCEEDED" && charge.currency === "THB" && charge.chargeId === order.charge_id
    && charge.referenceId === order.id && charge.amountSatang === Math.round(Number(order.amount) * 100);
}

export function evaluateBillingSlip(
  order: { amount: number; receiver_account: string | null; created_at: string; expires_at: string },
  slip: Slip2goVerification,
): string | null {
  if (!slip.ok || !slip.transRef) return "ตรวจสลิปไม่สำเร็จ หรือไม่พบเลขอ้างอิงธนาคาร";
  if (slip.amount == null || Math.round(slip.amount * 100) !== Math.round(Number(order.amount) * 100)) return "ยอดโอนไม่ตรงกับรายการ";
  const account = order.receiver_account?.replace(/[\s-]/g, "");
  const received = slip.receiverAccount?.replace(/[\s-]/g, "");
  if (!account || (slip.receiverVerified !== true && (!received || !/^\d{6,20}$/.test(received) || received !== account))) return "ยืนยันบัญชีผู้รับไม่ได้ กรุณาติดต่อผู้ดูแลพร้อมเลขอ้างอิง";
  const at = Date.parse(slip.transDate ?? "");
  if (!Number.isFinite(at) || at < Date.parse(order.created_at) - 60_000 || at > Date.parse(order.expires_at)) return "เวลาบนสลิปไม่อยู่ในช่วงรายการชำระเงิน";
  return null;
}
