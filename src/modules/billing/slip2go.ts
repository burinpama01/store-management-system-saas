/**
 * slip2go slip-verification adapter.
 *
 * Endpoints (per slip2go API Connect):
 *   POST {BASE}/api/verify-slip/qr-code/info   — verify by QR payload string
 *   POST {BASE}/api/verify-slip/qr-image/info  — verify by base64 image
 *
 * Auth: Authorization: Bearer SLIP2GO_API_KEY.
 * Fails closed when the key is absent. The response shape is parsed
 * defensively because slip2go's exact field names may vary; adjust
 * `parseSlip2goResponse` once a live response is observed.
 */

export interface Slip2goVerification {
  ok: boolean;
  amount: number | null;
  receiverName: string | null;
  receiverAccount: string | null;
  transRef: string | null;
  /** Transaction timestamp from the slip (ISO), when slip2go provides it. */
  transDate?: string | null;
  raw: unknown;
  error: string | null;
}

function pickNumber(...vals: unknown[]): number | null {
  for (const v of vals) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) {
      return Number(v);
    }
  }
  return null;
}

function pickString(...vals: unknown[]): string | null {
  for (const v of vals) {
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return null;
}

/**
 * Defensive parser tolerant of slip2go response variations. Looks under a
 * `data` envelope and a flat object, across common field aliases.
 */
export function parseSlip2goResponse(json: unknown): Slip2goVerification {
  const root = (json ?? {}) as Record<string, unknown>;
  const data = (root.data ?? root) as Record<string, unknown>;

  const amountObj = (data.amount ?? {}) as Record<string, unknown>;
  const amount = pickNumber(
    data.amount,
    amountObj.amount,
    amountObj.value,
    data.amountValue,
    data.transAmount,
  );

  const receiver = (data.receiver ?? {}) as Record<string, unknown>;
  const receiverAccount = (receiver.account ?? {}) as Record<string, unknown>;
  const receiverName = pickString(
    receiver.displayName,
    receiver.name,
    (receiver.account as Record<string, unknown> | undefined)?.name,
    data.receiverName,
  );
  const receiverAcct = pickString(
    receiverAccount.value,
    receiverAccount.account,
    receiver.account as unknown,
    data.receiverAccount,
  );

  const transRef = pickString(
    data.transRef,
    data.transRefId,
    data.ref,
    data.referenceNo,
    data.transactionId,
    root.transRef,
  );

  const transDateRaw = pickString(
    data.transDate,
    data.dateTime,
    data.transTimestamp,
    data.transDateTime,
    data.date,
    data.paidAt,
    data.timestamp,
  );
  const transDate = transDateRaw
    ? (() => {
        const t = Date.parse(transDateRaw);
        return Number.isNaN(t) ? null : new Date(t).toISOString();
      })()
    : null;

  // slip2go envelope: { code, message, data }. "200000" = verified;
  // "200500" = fraud/unreadable. Fall back to a usable transRef + amount.
  const code = pickString(root.code, data.code);
  const message = pickString(root.message, data.message) ?? "";
  const isFraud = code === "200500" || /fraud/i.test(message);
  const explicitOk =
    root.success === true ||
    data.success === true ||
    code === "200000" ||
    code === "200" ||
    pickString(root.status, data.status)?.toLowerCase() === "success";
  const ok = !isFraud && Boolean(explicitOk || (transRef && amount !== null));

  return {
    ok,
    amount,
    receiverName,
    receiverAccount: receiverAcct,
    transRef,
    transDate,
    raw: json,
    error: ok ? null : (message || "ตรวจสลิปไม่สำเร็จ"),
  };
}

function getConfig(): { baseUrl: string; apiKey: string } | null {
  const apiKey = process.env.SLIP2GO_API_KEY;
  if (!apiKey) return null;
  const baseUrl = (process.env.SLIP2GO_BASE_URL ?? "https://connect.slip2go.com").replace(/\/$/, "");
  return { baseUrl, apiKey };
}

async function callSlip2go(path: string, body: Record<string, unknown>): Promise<Slip2goVerification> {
  const cfg = getConfig();
  if (!cfg) {
    return {
      ok: false,
      amount: null,
      receiverName: null,
      receiverAccount: null,
      transRef: null,
      transDate: null,
      raw: null,
      error: "ยังไม่ได้ตั้งค่า SLIP2GO_API_KEY",
    };
  }
  try {
    const res = await fetch(`${cfg.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        ok: false,
        amount: null,
        receiverName: null,
        receiverAccount: null,
        transRef: null,
        transDate: null,
        raw: json,
        error: `slip2go HTTP ${res.status}`,
      };
    }
    return parseSlip2goResponse(json);
  } catch (e) {
    return {
      ok: false,
      amount: null,
      receiverName: null,
      receiverAccount: null,
      transRef: null,
      transDate: null,
      raw: null,
      error: e instanceof Error ? e.message : "slip2go request failed",
    };
  }
}

/** Slip image verification expects multipart/form-data with a `file` field. */
async function callSlip2goImage(
  path: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<Slip2goVerification> {
  const cfg = getConfig();
  if (!cfg) {
    return {
      ok: false,
      amount: null,
      receiverName: null,
      receiverAccount: null,
      transRef: null,
      transDate: null,
      raw: null,
      error: "ยังไม่ได้ตั้งค่า SLIP2GO_API_KEY",
    };
  }
  try {
    const form = new FormData();
    const ext = contentType.includes("png") ? "png" : "jpg";
    form.set("file", new Blob([bytes as BlobPart], { type: contentType || "image/jpeg" }), `slip.${ext}`);
    const res = await fetch(`${cfg.baseUrl}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      body: form,
    });
    const json = await res.json().catch(() => ({}));
    // slip2go returns 2xx with a structured body even for fraud; only treat
    // transport/validation failures (4xx/5xx) as hard errors.
    if (!res.ok) {
      const msg =
        (json as { message?: string }).message ?? `slip2go HTTP ${res.status}`;
      return {
        ok: false,
        amount: null,
        receiverName: null,
        receiverAccount: null,
        transRef: null,
        transDate: null,
        raw: json,
        error: msg,
      };
    }
    return parseSlip2goResponse(json);
  } catch (e) {
    return {
      ok: false,
      amount: null,
      receiverName: null,
      receiverAccount: null,
      transRef: null,
      transDate: null,
      raw: null,
      error: e instanceof Error ? e.message : "slip2go request failed",
    };
  }
}

export function isSlip2goConfigured(): boolean {
  return Boolean(process.env.SLIP2GO_API_KEY);
}

export function verifySlipByPayload(payload: string): Promise<Slip2goVerification> {
  return callSlip2go("/api/verify-slip/qr-code/info", { payload });
}

export function verifySlipByImageBase64(
  imageBase64: string,
  contentType = "image/jpeg",
): Promise<Slip2goVerification> {
  const bytes = Uint8Array.from(Buffer.from(imageBase64, "base64"));
  return callSlip2goImage("/api/verify-slip/qr-image/info", bytes, contentType);
}
