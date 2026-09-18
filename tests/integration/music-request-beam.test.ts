import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { getLocalSupabase } from "./helpers/local-supabase";

// ขอเพลงจ่ายด้วย Beam (migration 20260918050000) — trigger ยืนยันคำขอเมื่อ gateway PAID
// ต้องตั้ง env ก่อนรัน (ขาด = skip): LOCAL_SUPABASE_URL / LOCAL_SUPABASE_PUBLISHABLE_KEY / LOCAL_SUPABASE_SERVICE_KEY

const envReady =
  !!process.env.LOCAL_SUPABASE_URL &&
  !!process.env.LOCAL_SUPABASE_PUBLISHABLE_KEY &&
  !!process.env.LOCAL_SUPABASE_SERVICE_KEY;

const ORG_A = "aaaaaaaa-0000-0000-0000-000000000001";
const STORE_A = "cccccccc-0000-0000-0000-000000000001";

describe.skipIf(!envReady)("music request paid via Beam (local supabase)", () => {
  let service: SupabaseClient;
  let configId: string | null = null;
  let createdConfig = false;
  const requestIds: string[] = [];
  const paymentIds: string[] = [];

  beforeAll(async () => {
    service = getLocalSupabase().client;
    const { data: existing } = await service
      .from("payment_provider_configs")
      .select("id")
      .eq("store_id", STORE_A)
      .eq("provider_key", "beam")
      .eq("mode", "open_api")
      .maybeSingle();
    if (existing) {
      configId = existing.id;
    } else {
      const { data, error } = await service
        .from("payment_provider_configs")
        .insert({ organization_id: ORG_A, store_id: STORE_A, provider_key: "beam", mode: "open_api", environment: "test" })
        .select("id")
        .single();
      expect(error, error?.message).toBeNull();
      configId = data!.id;
      createdConfig = true;
    }
  });

  afterAll(async () => {
    if (!service) return;
    if (paymentIds.length) await service.from("gateway_payments").delete().in("id", paymentIds);
    if (requestIds.length) await service.from("music_requests").delete().in("id", requestIds);
    if (createdConfig && configId) await service.from("payment_provider_configs").delete().eq("id", configId);
  });

  async function pendingDonation(amount: number) {
    const { data, error } = await service
      .from("music_requests")
      .insert({
        organization_id: ORG_A,
        store_id: STORE_A,
        song_title: `Beam song ${Date.now()}`,
        donation_amount: amount,
        donation_status: "pending",
      })
      .select("id")
      .single();
    expect(error, error?.message).toBeNull();
    requestIds.push(data!.id);
    return data!.id as string;
  }

  async function beamPayment(requestId: string, amount: number) {
    const { data, error } = await service
      .from("gateway_payments")
      .insert({
        organization_id: ORG_A,
        store_id: STORE_A,
        provider_config_id: configId,
        provider_key: "beam",
        mode: "open_api",
        amount,
        status: "PENDING",
        storeos_reference: `beam:music-${randomUUID()}`,
        music_request_id: requestId,
      })
      .select("id")
      .single();
    expect(error, error?.message).toBeNull();
    paymentIds.push(data!.id);
    return data!.id as string;
  }

  async function request(id: string) {
    const { data } = await service
      .from("music_requests")
      .select("donation_status, status, donation_ref")
      .eq("id", id)
      .single();
    return data as { donation_status: string; status: string; donation_ref: string | null };
  }

  it("a PAID Beam payment verifies and approves the song request", async () => {
    const id = await pendingDonation(100);
    const pay = await beamPayment(id, 100);
    expect(await request(id)).toMatchObject({ donation_status: "pending" });

    const { error } = await service.from("gateway_payments").update({ status: "PAID" }).eq("id", pay);
    expect(error, error?.message).toBeNull();
    expect(await request(id)).toEqual({ donation_status: "verified", status: "approved", donation_ref: `BEAM:${pay}` });
  });

  async function paymentStatus(id: string) {
    const { data } = await service.from("gateway_payments").select("status").eq("id", id).single();
    return (data as { status: string }).status;
  }

  it("an amount mismatch is not auto-verified and the payment goes to review", async () => {
    const id = await pendingDonation(100);
    const pay = await beamPayment(id, 50);
    await service.from("gateway_payments").update({ status: "PAID" }).eq("id", pay);
    expect(await request(id)).toMatchObject({ donation_status: "pending", status: "pending" });
    expect(await paymentStatus(pay)).toBe("REVIEW_REQUIRED");
  });

  it("money arriving after staff rejected the song never revives it (LATE_PAID)", async () => {
    const id = await pendingDonation(100);
    const pay = await beamPayment(id, 100);
    await service.from("music_requests").update({ status: "rejected" }).eq("id", id);
    await service.from("gateway_payments").update({ status: "PAID" }).eq("id", pay);
    expect(await request(id)).toMatchObject({ donation_status: "pending", status: "rejected" });
    expect(await paymentStatus(pay)).toBe("LATE_PAID");
  });

  it("money arriving after the customer cancelled / the QR expired is LATE_PAID too", async () => {
    const id = await pendingDonation(100);
    const pay = await beamPayment(id, 100);
    await service.from("music_requests").update({ donation_status: "rejected", status: "expired" }).eq("id", id);
    await service.from("gateway_payments").update({ status: "CANCELLED" }).eq("id", pay);
    await service.from("gateway_payments").update({ status: "PAID" }).eq("id", pay);
    expect(await request(id)).toMatchObject({ donation_status: "rejected", status: "expired" });
    expect(await paymentStatus(pay)).toBe("LATE_PAID");
  });

  it("one payment per request", async () => {
    const id = await pendingDonation(20);
    await beamPayment(id, 20);
    const { error } = await service.from("gateway_payments").insert({
      organization_id: ORG_A,
      store_id: STORE_A,
      provider_config_id: configId,
      provider_key: "beam",
      mode: "open_api",
      amount: 20,
      status: "PENDING",
      storeos_reference: `beam:music-${randomUUID()}`,
      music_request_id: id,
    });
    expect(error?.message).toContain("gateway_payments_music_request_unique");
  });
});
