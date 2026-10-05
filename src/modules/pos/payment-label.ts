/** Gateway references preserve the provider while the ledger uses method "other". */
export function posPaymentLabel(payment: { method: string; reference?: string | null }): string {
  if (payment.method === "other") {
    if (payment.reference?.startsWith("BEAM:") && payment.reference.length > 5) return "Beam QR";
    if (payment.reference?.startsWith("TM:") && payment.reference.length > 3) return "TrueMoney";
  }
  if (payment.method === "cash") return "เงินสด";
  if (payment.method === "qr_promptpay") return "QR พร้อมเพย์";
  if (payment.method === "credit_card") return "บัตรเครดิต";
  if (payment.method === "bank_transfer") return "โอนธนาคาร";
  return payment.method;
}
