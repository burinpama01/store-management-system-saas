import type { GatewayPaymentStatus } from "./types";

const TERMINAL: ReadonlySet<GatewayPaymentStatus> = new Set([
  "PAID",
  "FAILED",
  "EXPIRED",
  "CANCELLED",
  "REFUND_SUCCEEDED",
]);

export function isTerminalGatewayStatus(status: GatewayPaymentStatus): boolean {
  return TERMINAL.has(status);
}

/** Allowed transitions for Phase A manual flow (+ safe no-ops). */
export function canTransitionGatewayStatus(
  from: GatewayPaymentStatus,
  to: GatewayPaymentStatus,
): boolean {
  if (from === to) return true;
  if (isTerminalGatewayStatus(from) && to !== "LATE_PAID" && to !== "REVIEW_REQUIRED") {
    return false;
  }
  const allowed: Record<GatewayPaymentStatus, GatewayPaymentStatus[]> = {
    CREATED: ["PENDING", "REQUIRES_ACTION", "FAILED", "CANCELLED", "EXPIRED"],
    PENDING: ["REQUIRES_ACTION", "PROCESSING", "PAID", "FAILED", "CANCELLED", "EXPIRED", "REVIEW_REQUIRED"],
    REQUIRES_ACTION: ["PENDING", "PROCESSING", "PAID", "FAILED", "CANCELLED", "EXPIRED"],
    PROCESSING: ["PAID", "FAILED", "CANCELLED", "EXPIRED", "REVIEW_REQUIRED"],
    PAID: ["REFUND_PENDING", "LATE_PAID"],
    FAILED: ["PENDING", "REVIEW_REQUIRED"],
    EXPIRED: ["LATE_PAID", "REVIEW_REQUIRED"],
    CANCELLED: ["LATE_PAID", "REVIEW_REQUIRED"],
    REFUND_PENDING: ["REFUND_SUCCEEDED", "REFUND_FAILED"],
    REFUND_SUCCEEDED: [],
    REFUND_FAILED: ["REFUND_PENDING"],
    LATE_PAID: ["REVIEW_REQUIRED"],
    REVIEW_REQUIRED: ["PAID", "FAILED", "CANCELLED"],
  };
  return (allowed[from] ?? []).includes(to);
}
