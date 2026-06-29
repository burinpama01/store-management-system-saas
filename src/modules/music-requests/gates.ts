import type { MusicLicenseStatus, QrOrderingMode } from "@/modules/stores/types";

export interface QrMusicEligibilityInput {
  qrMode: QrOrderingMode;
  /** Session id from the QR URL (`?s=`), if any. */
  querySessionId: string | null;
  /** The table's current active session id, if any. */
  currentSessionId: string | null;
  /** Whether the table currently has an active (non-expired) session. */
  sessionActive: boolean;
  /** Store is on a plan that includes the music request feature (Enterprise). */
  isEnterprise: boolean;
  musicLicenseStatus: MusicLicenseStatus;
  musicRequestEnabled: boolean;
}

export interface QrMusicEligibility {
  canViewQueue: boolean;
  canSubmitRequest: boolean;
  /** True when a session_printed QR is no longer valid — the whole page (food + music) is expired. */
  expiredWholeQr: boolean;
  reason: string | null;
}

const EXPIRED_REASON = "QR หมดอายุแล้ว กรุณาขอ QR ใหม่จากพนักงาน";

/**
 * Whether a `session_printed` QR is still valid: it must carry a session query
 * that matches the table's active session. table_bound QRs are always valid.
 */
export function isPrintedQrSessionValid(input: {
  qrMode: QrOrderingMode;
  querySessionId: string | null;
  currentSessionId: string | null;
  sessionActive: boolean;
}): boolean {
  if (input.qrMode !== "session_printed") return true;
  return (
    input.sessionActive &&
    input.currentSessionId !== null &&
    input.querySessionId === input.currentSessionId
  );
}

/**
 * Music eligibility is independent of the food session for table_bound stores:
 * customers can request songs / view the queue even with no active bill, and
 * after checkout. For session_printed stores the printed QR must still be valid,
 * otherwise the whole QR is expired.
 */
export function resolveQrMusicEligibility(
  input: QrMusicEligibilityInput,
): QrMusicEligibility {
  const printedExpired =
    input.qrMode === "session_printed" &&
    !isPrintedQrSessionValid({
      qrMode: input.qrMode,
      querySessionId: input.querySessionId,
      currentSessionId: input.currentSessionId,
      sessionActive: input.sessionActive,
    });

  if (printedExpired) {
    return {
      canViewQueue: false,
      canSubmitRequest: false,
      expiredWholeQr: true,
      reason: EXPIRED_REASON,
    };
  }

  if (!input.isEnterprise) {
    return {
      canViewQueue: false,
      canSubmitRequest: false,
      expiredWholeQr: false,
      reason: "ฟีเจอร์ขอเพลงสำหรับแพ็กเกจ Enterprise เท่านั้น",
    };
  }

  if (input.musicLicenseStatus !== "approved") {
    return {
      canViewQueue: false,
      canSubmitRequest: false,
      expiredWholeQr: false,
      reason: "ร้านนี้ยังไม่เปิดให้ขอเพลง",
    };
  }

  if (!input.musicRequestEnabled) {
    return {
      canViewQueue: false,
      canSubmitRequest: false,
      expiredWholeQr: false,
      reason: "ร้านนี้ปิดการขอเพลงชั่วคราว",
    };
  }

  return {
    canViewQueue: true,
    canSubmitRequest: true,
    expiredWholeQr: false,
    reason: null,
  };
}
