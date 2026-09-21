import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  allowMusicPaymentPoll,
  createMusicPaymentToken,
  MUSIC_PAYMENT_TOKEN_TTL_MS,
  resolveMusicPaymentTokenSecret,
  verifyMusicPaymentToken,
} from "@/modules/music-requests/payment-token";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const SECRET = "test-secret-at-least-16-chars";
const CLAIMS = { storeId: "s1", requestId: "r1", gatewayPaymentId: "g1" };

describe("music payment capability token", () => {
  it("round-trips claims with purpose and expiry", () => {
    const token = createMusicPaymentToken(CLAIMS, SECRET, 1_000);
    expect(verifyMusicPaymentToken(token, SECRET, 2_000)).toMatchObject({
      ...CLAIMS,
      purpose: "music_payment_check",
      exp: 1_000 + MUSIC_PAYMENT_TOKEN_TTL_MS,
    });
  });

  it("rejects tampered, expired, foreign-secret and malformed tokens", () => {
    const token = createMusicPaymentToken(CLAIMS, SECRET, 1_000);
    const [payload, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ ...CLAIMS, requestId: "other", purpose: "music_payment_check", exp: 9e15 })).toString("base64url");
    expect(verifyMusicPaymentToken(`${forged}.${sig}`, SECRET, 2_000)).toBeNull();
    expect(verifyMusicPaymentToken(token, SECRET, 1_000 + MUSIC_PAYMENT_TOKEN_TTL_MS + 1)).toBeNull();
    expect(verifyMusicPaymentToken(token, "another-secret-value-xx", 2_000)).toBeNull();
    expect(verifyMusicPaymentToken(`${payload}`, SECRET, 2_000)).toBeNull();
    expect(verifyMusicPaymentToken("", SECRET, 2_000)).toBeNull();
    // UUID ของคำขอเปล่า ๆ ไม่ใช่สิทธิ์
    expect(verifyMusicPaymentToken("r1", SECRET, 2_000)).toBeNull();
  });

  it("fails closed without a secret and never uses the service key verbatim", () => {
    expect(resolveMusicPaymentTokenSecret({})).toBeNull();
    const derived = resolveMusicPaymentTokenSecret({ SUPABASE_SERVICE_ROLE_KEY: "service-role-key-1234567890" });
    expect(derived).toBeTruthy();
    expect(derived).not.toContain("service-role-key");
    expect(resolveMusicPaymentTokenSecret({ MUSIC_PAYMENT_TOKEN_SECRET: "explicit-secret-123456" })).toBe("explicit-secret-123456");
  });

  it("throttles polls per request", () => {
    expect(allowMusicPaymentPoll("req-x", 10_000)).toBe(true);
    expect(allowMusicPaymentPoll("req-x", 10_500)).toBe(false);
    expect(allowMusicPaymentPoll("req-x", 12_100)).toBe(true);
  });
});

describe("music request donation via Beam wiring", () => {
  const actions = read("src/app/qr/[storeSlug]/[tableId]/music-actions.ts");

  it("uses Beam only when allowed, ready, and a token secret exists", () => {
    expect(actions).toContain("beamAllowed: features.byoPaymentGateway");
    expect(actions).toContain("Boolean(tokenSecret) && (await isBeamReadyForStore(storeId, service))");
    expect(actions).toContain("if (!isFree && !useBeam)");
    expect(actions).toContain("clientRequestId: `music-${res.data}`");
  });

  it("payment check and cancel require the signed token, and provider lookups are throttled", () => {
    const check = actions.slice(actions.indexOf("export async function checkMusicDonationPaymentAction"));
    expect(check).toContain("checkMusicDonationPaymentAction(\n  paymentToken: string,");
    expect(check).toContain("verifyPaymentCapability(paymentToken)");
    expect(check).toContain("minLookupIntervalMs: 10_000");
    expect(check.indexOf("verifyPaymentCapability(paymentToken)")).toBeLessThan(check.indexOf("createSupabaseServiceClient()"));
    const cancel = actions.slice(actions.indexOf("export async function cancelMusicDonationPaymentAction"));
    expect(cancel).toContain("cancelBeamQrPayment(");
    expect(cancel).toContain('status: "rejected"');
  });

  it("the DB only approves requests still waiting for payment; late or wrong money goes to review", () => {
    const migration = read("supabase/migrations/20260918050000_music_request_beam.sql");
    expect(migration).toContain("before update of status on public.gateway_payments");
    expect(migration).toContain("v_req.donation_status is distinct from 'pending' or v_req.status is distinct from 'pending'");
    expect(migration).toContain("new.status := 'LATE_PAID'");
    expect(migration).toContain("new.status := 'REVIEW_REQUIRED'");
  });

  it("the customer screen polls with the token and cancels on the server", () => {
    const tab = read("src/app/qr/[storeSlug]/[tableId]/MusicTab.tsx");
    expect(tab).toContain("checkMusicDonationPaymentAction(token)");
    expect(tab).toContain("cancelMusicDonationPaymentAction(token)");
    expect(tab).toContain("ไม่ต้องแนบสลิป");
  });

  it("Beam: terminal QR is not handed back as usable; lookup throttle exists; music payments count as attached", () => {
    const service = read("src/modules/payments/beam-service.ts");
    expect(service).toContain('if (row.status === "PAID") return { ok: true, qr: toPosView(row, null) };');
    expect(service).toContain("input.minLookupIntervalMs");
    expect(service).toContain("attached: Boolean(r.pos_payment_id || r.music_request_id)");
  });
});
