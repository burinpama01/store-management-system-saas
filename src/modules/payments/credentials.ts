import type { TrueMoneyManualCredentials } from "./types";

/**
 * Phase A credential codec.
 * encryption_key_version = 0 → JSON plaintext prefix `v0:` (static EMV is store-scoped receive identity).
 * Phase B will add AES-GCM with PAYMENTS_CREDENTIALS_KEK_* when Open API secrets land.
 */

const V0_PREFIX = "v0:";

export function encodeTrueMoneyManualCredentials(creds: TrueMoneyManualCredentials): string {
  return V0_PREFIX + JSON.stringify({ staticEmvPayload: creds.staticEmvPayload.trim() });
}

export function decodeTrueMoneyManualCredentials(
  encrypted: string | null | undefined,
): TrueMoneyManualCredentials | null {
  if (!encrypted) return null;
  if (!encrypted.startsWith(V0_PREFIX)) return null;
  try {
    const parsed = JSON.parse(encrypted.slice(V0_PREFIX.length)) as { staticEmvPayload?: unknown };
    if (typeof parsed.staticEmvPayload !== "string" || !parsed.staticEmvPayload.trim()) return null;
    return { staticEmvPayload: parsed.staticEmvPayload.trim() };
  } catch {
    return null;
  }
}
