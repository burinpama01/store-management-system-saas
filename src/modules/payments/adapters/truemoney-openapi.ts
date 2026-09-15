import { PaymentError, PaymentErrorCodes } from "../errors";
import type { PaymentProviderAdapter } from "../provider-contract";

/**
 * TrueMoney Wallet Open API adapter — Phase B scaffold.
 *
 * Official product: TrueMoney Wallet Open API (incoming-payment webhook JWT in `message`,
 * HS256 secret from merchant app; inquiry/payment-link when entitled).
 * Docs appear in the TrueMoney app after eligibility (~>50 inbound transfers/month).
 *
 * Do NOT invent undocumented merchant HTTP charge endpoints.
 * Checkout.com TrueMoney is a different product — ignore.
 *
 * TODO: confirm create/lookup/refund endpoint details from in-app official manual when eligible.
 */
export const trueMoneyOpenApiAdapter: PaymentProviderAdapter = {
  key: "truemoney",
  mode: "open_api",
  capabilities: {
    createPayment: false,
    webhook: true,
    lookup: false,
    refund: false,
    manualConfirm: false,
  },
  createDisplayPayment() {
    // No live charge / payment-link HTTP until merchant is entitled and official docs are wired.
    throw new PaymentError(
      PaymentErrorCodes.CONFIG_DISABLED,
      "TrueMoney Open API ยังไม่พร้อมสร้างรายการชำระอัตโนมัติ — รอสิทธิ์และเอกสารในแอป หรือใช้โหมด Manual (Shop QR)",
    );
  },
};
