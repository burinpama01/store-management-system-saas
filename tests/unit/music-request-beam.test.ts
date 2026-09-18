import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

describe("music request donation via Beam", () => {
  const actions = read("src/app/qr/[storeSlug]/[tableId]/music-actions.ts");

  it("uses Beam only when the plan allows BYO gateways and the store has Beam ready", () => {
    expect(actions).toContain("beamAllowed: features.byoPaymentGateway");
    expect(actions).toContain("!isFree && beamAllowed && (await isBeamReadyForStore(storeId, service))");
    // ร้าน Beam ไม่ต้องมีเลข PromptPay
    expect(actions).toContain("if (!isFree && !useBeam)");
  });

  it("ties one Beam charge to one request and never trusts the client for confirmation", () => {
    expect(actions).toContain("clientRequestId: `music-${res.data}`");
    expect(actions).toContain("musicRequestId: res.data");
    const check = actions.slice(actions.indexOf("export async function checkMusicDonationPaymentAction"));
    expect(check).toContain("refreshBeamPayment(");
    expect(check).toContain('request?.donation_status === "verified"');
  });

  it("the DB promotes the request when Beam confirms PAID with the exact amount", () => {
    const migration = read("supabase/migrations/20260918050000_music_request_beam.sql");
    expect(migration).toContain("round(v_req.donation_amount, 2) is distinct from round(new.amount, 2)");
    expect(migration).toContain("donation_ref = 'BEAM:' || new.id::text");
    expect(migration).toContain("create unique index if not exists gateway_payments_music_request_unique");
  });

  it("the customer screen shows the Beam QR without a slip upload and polls for confirmation", () => {
    const tab = read("src/app/qr/[storeSlug]/[tableId]/MusicTab.tsx");
    expect(tab).toContain("checkMusicDonationPaymentAction(storeId, requestId)");
    expect(tab).toContain("ไม่ต้องแนบสลิป");
  });

  it("Beam history does not flag music payments as unattached", () => {
    const service = read("src/modules/payments/beam-service.ts");
    expect(service).toContain("attached: Boolean(r.pos_payment_id || r.music_request_id)");
  });
});
