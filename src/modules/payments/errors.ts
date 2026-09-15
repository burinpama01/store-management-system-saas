export class PaymentError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "PaymentError";
    this.code = code;
  }
}

export const PaymentErrorCodes = {
  FEATURE_DISABLED: "FEATURE_DISABLED",
  CONFIG_MISSING: "CONFIG_MISSING",
  CONFIG_DISABLED: "CONFIG_DISABLED",
  INVALID_PAYLOAD: "INVALID_PAYLOAD",
  INJECT_FAILED: "INJECT_FAILED",
  AMOUNT_MISMATCH: "AMOUNT_MISMATCH",
  ALREADY_PAID: "ALREADY_PAID",
  INVALID_TRANSITION: "INVALID_TRANSITION",
  REASON_REQUIRED: "REASON_REQUIRED",
  ORDER_REQUIRED: "ORDER_REQUIRED",
} as const;
