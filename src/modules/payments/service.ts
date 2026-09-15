import { randomUUID } from "node:crypto";
import { logSystemEvent } from "@/modules/system/event-log";
import { PaymentError, PaymentErrorCodes } from "./errors";
import { amountsEqualMajor, roundMajorThb } from "./money";
import { getPaymentProviderAdapter } from "./registry";
import {
  findGatewayPaymentByReference,
  getEnabledTrueMoneyManualConfig,
  getGatewayPayment,
  getTrueMoneyManualConfig,
  insertGatewayPayment,
  markGatewayPaymentPaidManual,
  softDisableTrueMoneyManualConfig,
  upsertTrueMoneyManualConfig,
} from "./repository";
import {
  buildTrueMoneyShopStaticPayload,
  crc16Ccitt,
  extractTrueMoneyEWalletId,
  looksLikeEmvPayload,
  maskTrueMoneyEWalletId,
  normalizeTrueMoneyEWalletId,
  summarizeTrueMoneyEmv,
} from "./emv-qr";
import { canTransitionGatewayStatus } from "./status";
import type {
  GatewayPayment,
  PaymentProviderConfigPublic,
  TrueMoneyManualTestResult,
} from "./types";

export type { TrueMoneyManualTestResult };

export async function saveTrueMoneyManualConfigForStore(input: {
  organizationId: string;
  storeId: string;
  staticEmvPayload: string;
  isEnabled: boolean;
  displayName?: string | null;
  actorUserId: string;
}): Promise<{ data: PaymentProviderConfigPublic | null; error: string | null }> {
  const payload = input.staticEmvPayload.trim();
  if (!looksLikeEmvPayload(payload)) {
    return { data: null, error: "รูปแบบ TrueMoney Shop QR (EMV) ไม่ถูกต้อง" };
  }
  // Ensure we can inject a sample amount (algorithm gate).
  const adapter = getPaymentProviderAdapter("truemoney", "manual");
  if (!adapter) return { data: null, error: "TrueMoney adapter ไม่พร้อม" };
  try {
    adapter.createDisplayPayment({ staticEmvPayload: payload, amountMajor: 1 });
  } catch (e) {
    return { data: null, error: e instanceof Error ? e.message : "QR ใช้ล็อกยอดไม่ได้" };
  }

  const result = await upsertTrueMoneyManualConfig({
    organizationId: input.organizationId,
    storeId: input.storeId,
    staticEmvPayload: payload,
    isEnabled: input.isEnabled,
    displayName: input.displayName,
    actorUserId: input.actorUserId,
  });
  if (result.error) return { data: null, error: result.error.userMessage };

  await logSystemEvent({
    level: "info",
    source: "payments.config",
    action: "PAYMENT_PROVIDER_UPSERT",
    message: input.isEnabled
      ? "บันทึกและเปิดใช้ TrueMoney Shop QR (manual)"
      : "บันทึก TrueMoney Shop QR (ปิดใช้งาน)",
    organizationId: input.organizationId,
    storeId: input.storeId,
    actorUserId: input.actorUserId,
    context: {
      providerKey: "truemoney",
      mode: "manual",
      isEnabled: input.isEnabled,
      configId: result.data?.id,
    },
  });

  return { data: result.data, error: null };
}

export async function disableTrueMoneyManualConfigForStore(input: {
  organizationId: string;
  storeId: string;
  actorUserId: string;
}) {
  const result = await softDisableTrueMoneyManualConfig(input.storeId, input.actorUserId);
  if (result.error) return { error: result.error.userMessage };
  await logSystemEvent({
    level: "info",
    source: "payments.config",
    action: "PAYMENT_PROVIDER_DISABLE",
    message: "ปิดใช้ TrueMoney Shop QR (manual)",
    organizationId: input.organizationId,
    storeId: input.storeId,
    actorUserId: input.actorUserId,
    context: { providerKey: "truemoney", mode: "manual" },
  });
  return { error: null };
}

/** Preview amount-locked QR for POS (does not create a gateway row). */
export async function prepareTrueMoneyManualQr(input: {
  storeId: string;
  amountMajor: number;
}): Promise<
  | { ok: true; configId: string; injectedPayload: string; amount: number }
  | { ok: false; error: string; code: string }
> {
  const amount = roundMajorThb(input.amountMajor);
  if (!(amount > 0)) {
    return { ok: false, error: "ยอดชำระไม่ถูกต้อง", code: PaymentErrorCodes.AMOUNT_MISMATCH };
  }
  const configRes = await getEnabledTrueMoneyManualConfig(input.storeId);
  if (configRes.error) {
    return { ok: false, error: configRes.error.userMessage, code: PaymentErrorCodes.CONFIG_MISSING };
  }
  const config = configRes.data;
  if (!config?.staticEmvPayload) {
    return {
      ok: false,
      error: "ยังไม่ได้ตั้งค่า TrueMoney Shop QR",
      code: PaymentErrorCodes.CONFIG_MISSING,
    };
  }
  if (!config.isEnabled || config.disabledAt) {
    return { ok: false, error: "TrueMoney ถูกปิดใช้งาน", code: PaymentErrorCodes.CONFIG_DISABLED };
  }
  const adapter = getPaymentProviderAdapter("truemoney", "manual");
  if (!adapter) {
    return { ok: false, error: "TrueMoney adapter ไม่พร้อม", code: PaymentErrorCodes.CONFIG_MISSING };
  }
  try {
    const created = adapter.createDisplayPayment({
      staticEmvPayload: config.staticEmvPayload,
      amountMajor: amount,
    });
    if (!created.display?.payload) {
      return { ok: false, error: "สร้าง QR ไม่สำเร็จ", code: PaymentErrorCodes.INJECT_FAILED };
    }
    return {
      ok: true,
      configId: config.id,
      injectedPayload: created.display.payload,
      amount,
    };
  } catch (e) {
    const msg = e instanceof PaymentError ? e.message : "สร้าง QR ไม่สำเร็จ";
    const code = e instanceof PaymentError ? e.code : PaymentErrorCodes.INJECT_FAILED;
    return { ok: false, error: msg, code };
  }
}

/**
 * Create (or reuse) a pending gateway payment for an order, amount-locked from orders.total.
 */
export async function createTrueMoneyManualPending(input: {
  organizationId: string;
  storeId: string;
  orderId: string;
  amountMajor: number;
  actorUserId: string;
  idempotencyKey?: string | null;
}): Promise<
  | { ok: true; payment: GatewayPayment; injectedPayload: string }
  | { ok: false; error: string; code: string }
> {
  const amount = roundMajorThb(input.amountMajor);
  const reference =
    input.idempotencyKey?.trim() ||
    `tm_manual:${input.storeId}:${input.orderId}:${amount.toFixed(2)}`;

  const existing = await findGatewayPaymentByReference(input.storeId, reference);
  if (existing.error) {
    return { ok: false, error: existing.error.userMessage, code: PaymentErrorCodes.CONFIG_MISSING };
  }
  if (existing.data) {
    if (existing.data.status === "PAID") {
      return {
        ok: false,
        error: "รายการนี้ยืนยันชำระแล้ว",
        code: PaymentErrorCodes.ALREADY_PAID,
      };
    }
    if (!amountsEqualMajor(existing.data.amount, amount)) {
      return {
        ok: false,
        error: "ยอดไม่ตรงกับรายการเดิม",
        code: PaymentErrorCodes.AMOUNT_MISMATCH,
      };
    }
    return {
      ok: true,
      payment: existing.data,
      injectedPayload: existing.data.injectedEmvPayload ?? "",
    };
  }

  const prepared = await prepareTrueMoneyManualQr({
    storeId: input.storeId,
    amountMajor: amount,
  });
  if (!prepared.ok) return prepared;

  const inserted = await insertGatewayPayment({
    organizationId: input.organizationId,
    storeId: input.storeId,
    orderId: input.orderId,
    providerConfigId: prepared.configId,
    providerKey: "truemoney",
    mode: "manual",
    amount,
    storeosReference: reference,
    injectedEmvPayload: prepared.injectedPayload,
    status: "PENDING",
    metadata: { verificationSource: "MANUAL_STAFF" },
  });
  if (inserted.error || !inserted.data) {
    // Race on unique reference — reuse
    const again = await findGatewayPaymentByReference(input.storeId, reference);
    if (again.data) {
      return {
        ok: true,
        payment: again.data,
        injectedPayload: again.data.injectedEmvPayload ?? prepared.injectedPayload,
      };
    }
    return {
      ok: false,
      error: inserted.error?.userMessage ?? "สร้างรายการชำระไม่สำเร็จ",
      code: PaymentErrorCodes.CONFIG_MISSING,
    };
  }

  await logSystemEvent({
    level: "info",
    source: "payments.create",
    action: "GATEWAY_PAYMENT_CREATE",
    message: "สร้าง TrueMoney manual pending",
    organizationId: input.organizationId,
    storeId: input.storeId,
    actorUserId: input.actorUserId,
    context: {
      gatewayPaymentId: inserted.data.id,
      orderId: input.orderId,
      amount,
      providerKey: "truemoney",
      mode: "manual",
    },
  });

  return { ok: true, payment: inserted.data, injectedPayload: prepared.injectedPayload };
}

/**
 * Mark gateway payment PAID via staff confirm. Idempotent if already PAID.
 * Caller is responsible for closing the POS order exactly once via existing RPC.
 */
export async function confirmTrueMoneyManualPayment(input: {
  gatewayPaymentId: string;
  storeId: string;
  orderId: string;
  expectedAmount: number;
  confirmedBy: string;
  confirmReason: string;
  posPaymentId: string | null;
}): Promise<
  | { ok: true; payment: GatewayPayment; alreadyPaid: boolean }
  | { ok: false; error: string; code: string }
> {
  const reason = input.confirmReason.trim();
  if (reason.length < 2) {
    return {
      ok: false,
      error: "กรุณาระบุเหตุผลที่ยืนยันรับเงิน",
      code: PaymentErrorCodes.REASON_REQUIRED,
    };
  }

  const loaded = await getGatewayPayment(input.gatewayPaymentId);
  if (loaded.error || !loaded.data) {
    return { ok: false, error: "ไม่พบรายการชำระ", code: PaymentErrorCodes.CONFIG_MISSING };
  }
  const payment = loaded.data;
  if (payment.storeId !== input.storeId) {
    return { ok: false, error: "ร้านค้าไม่ตรงกัน", code: PaymentErrorCodes.CONFIG_MISSING };
  }
  if (!amountsEqualMajor(payment.amount, input.expectedAmount)) {
    return {
      ok: false,
      error: "ยอด gateway ไม่ตรงกับออร์เดอร์",
      code: PaymentErrorCodes.AMOUNT_MISMATCH,
    };
  }
  if (payment.status === "PAID") {
    return { ok: true, payment, alreadyPaid: true };
  }
  if (!canTransitionGatewayStatus(payment.status, "PAID")) {
    return {
      ok: false,
      error: `สถานะ ${payment.status} ยืนยันชำระไม่ได้`,
      code: PaymentErrorCodes.INVALID_TRANSITION,
    };
  }

  const marked = await markGatewayPaymentPaidManual({
    id: payment.id,
    confirmedBy: input.confirmedBy,
    confirmReason: reason,
    posPaymentId: input.posPaymentId,
    orderId: input.orderId,
  });
  if (marked.error || !marked.data) {
    return {
      ok: false,
      error: marked.error?.userMessage ?? "ยืนยันชำระไม่สำเร็จ",
      code: PaymentErrorCodes.INVALID_TRANSITION,
    };
  }

  await logSystemEvent({
    level: "info",
    source: "payments.close",
    action: "GATEWAY_PAYMENT_MANUAL_CONFIRM",
    message: "พนักงานยืนยันรับเงิน TrueMoney (MANUAL_STAFF)",
    organizationId: payment.organizationId,
    storeId: payment.storeId,
    actorUserId: input.confirmedBy,
    context: {
      gatewayPaymentId: payment.id,
      orderId: input.orderId,
      verificationSource: "MANUAL_STAFF",
      amount: payment.amount,
      reason,
      posPaymentId: input.posPaymentId,
    },
  });

  return { ok: true, payment: marked.data, alreadyPaid: false };
}


/**
 * Validate TrueMoney Shop QR config without creating gateway_payments or calling external APIs.
 * Resolves payload from pasted EMV, e-wallet id, or saved store credentials.
 */
export async function testTrueMoneyManualConnection(input: {
  staticEmvPayload?: string | null;
  eWalletId?: string | null;
  storeId?: string | null;
}): Promise<TrueMoneyManualTestResult> {
  let payload = (input.staticEmvPayload ?? "").trim();

  if (!payload) {
    const id = normalizeTrueMoneyEWalletId(input.eWalletId ?? "");
    if (id) {
      const built = buildTrueMoneyShopStaticPayload(id);
      if (!built) {
        return { ok: false, error: "สร้าง TrueMoney Shop QR จาก E-Wallet ID ไม่สำเร็จ" };
      }
      payload = built;
    }
  }

  if (!payload && input.storeId) {
    const loaded = await getTrueMoneyManualConfig(input.storeId);
    if (loaded.error) {
      return { ok: false, error: loaded.error.userMessage };
    }
    payload = loaded.data?.staticEmvPayload?.trim() ?? "";
  }

  if (!payload) {
    return {
      ok: false,
      error: "กรุณาวาง EMV หรือระบุ E-Wallet ID (หรือบันทึกการตั้งค่าไว้ก่อน)",
    };
  }

  if (!looksLikeEmvPayload(payload)) {
    return { ok: false, error: "รูปแบบ TrueMoney Shop QR (EMV) ไม่ถูกต้อง" };
  }

  const adapter = getPaymentProviderAdapter("truemoney", "manual");
  if (!adapter) {
    return { ok: false, error: "TrueMoney adapter ไม่พร้อม" };
  }

  try {
    const created = adapter.createDisplayPayment({
      staticEmvPayload: payload,
      amountMajor: 1.0,
    });
    const injected = created.display?.payload;
    if (!injected) {
      return { ok: false, error: "สร้าง QR ทดสอบไม่สำเร็จ" };
    }
    const crcOk = injected.slice(-4) === crc16Ccitt(injected.slice(0, -4));
    if (!crcOk) {
      return { ok: false, error: "CRC ของ QR ทดสอบไม่ถูกต้อง" };
    }
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "ทดสอบเชื่อมต่อไม่สำเร็จ",
    };
  }

  const eWalletId =
    extractTrueMoneyEWalletId(payload) ??
    normalizeTrueMoneyEWalletId(input.eWalletId ?? "");
  const summary = summarizeTrueMoneyEmv(payload);

  return {
    ok: true,
    mode: "manual",
    providerKey: "truemoney",
    eWalletIdMasked: eWalletId ? maskTrueMoneyEWalletId(eWalletId) : summary?.eWalletIdMasked ?? null,
    sampleInjectedCrcOk: true,
    capabilities: {
      createPayment: true,
      webhook: false,
      lookup: false,
      refund: false,
      manualConfirm: true,
    },
    message: "เชื่อมต่อโหมด Manual ได้ — ล็อกยอด/CRC ผ่าน (ยังไม่มี webhook/API)",
    summary: summary
      ? { hasAid: summary.hasAid, country: summary.country, currency: summary.currency }
      : undefined,
  };
}

export function buildTrueMoneyReference(parts: {
  storeId: string;
  orderId: string;
  amount: number;
  nonce?: string;
}): string {
  const nonce = parts.nonce ?? randomUUID().slice(0, 8);
  return `tm_manual:${parts.storeId}:${parts.orderId}:${roundMajorThb(parts.amount).toFixed(2)}:${nonce}`;
}
