import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ackPrintJob,
  claimPendingPrintJobs,
  getHubStatus,
  reconcileStalePrintJobs,
  resolveUnknownPrintJob,
} from "@/modules/printing/print-hub-repository";
import { getLocalSupabase, type LocalSupabase } from "./helpers/local-supabase";

// v3 Task 1/2 — DB contract ของการกู้คืนคิวงานพิมพ์ (ปิด Critical X1)
// ต้องตั้ง env ก่อนรัน (ขาด = skip ทั้ง describe):
//   LOCAL_SUPABASE_URL / LOCAL_SUPABASE_PUBLISHABLE_KEY / LOCAL_SUPABASE_SERVICE_KEY
// และต้องมี migration 20260904000004 ใน local DB แล้ว (supabase migration up --local)
//
// สิ่งที่ต้องพิสูจน์:
//   1. claim เป็น atomic — งานหนึ่งใบไปได้ที่ agent เดียวแม้เคลมพร้อมกัน
//   2. งานที่ lease หมดโดยไม่มี ack กลายเป็น unknown ไม่ใช่ pending (ห้าม replay เอง)
//   3. ack ที่ claim token ไม่ตรง (agent เก่าฟื้นมาทีหลัง) ต้องไม่ทับผลปัจจุบัน
//   4. คนตัดสิน unknown ได้สองทางเท่านั้น: ยืนยันว่ากระดาษออกแล้ว หรือส่งกลับเข้าคิว

const envReady =
  !!process.env.LOCAL_SUPABASE_URL &&
  !!process.env.LOCAL_SUPABASE_PUBLISHABLE_KEY &&
  !!process.env.LOCAL_SUPABASE_SERVICE_KEY;

const ORG_A = "aaaaaaaa-0000-0000-0000-000000000001";
const STORE_A = "cccccccc-0000-0000-0000-000000000001";
const PAYLOAD = Buffer.from("ESC/POS").toString("base64");

describe.skipIf(!envReady)("print hub queue recovery (v3 Task 1, local supabase)", () => {
  let local: LocalSupabase;
  let service: SupabaseClient;
  const createdJobIds: string[] = [];
  let originalEnv: { NEXT_PUBLIC_SUPABASE_URL?: string; SUPABASE_SERVICE_ROLE_KEY?: string } = {};

  async function insertJob(overrides: Record<string, unknown> = {}): Promise<string> {
    const { data, error } = await service
      .from("print_jobs")
      .insert({
        organization_id: ORG_A,
        store_id: STORE_A,
        target_kind: "usb",
        target_host: null,
        target_device: null,
        payload_b64: PAYLOAD,
        status: "pending",
        ...overrides,
      })
      .select("id")
      .single();
    if (error) throw error;
    createdJobIds.push(data.id as string);
    return data.id as string;
  }

  async function readJob(id: string) {
    const { data, error } = await service
      .from("print_jobs")
      .select("status, attempts, claim_token, lease_expires_at, agent_version, resolution, error")
      .eq("id", id)
      .single();
    if (error) throw error;
    return data;
  }

  beforeAll(() => {
    local = getLocalSupabase();
    service = local.client;
    // repository ใช้ service client ของแอป — ชี้ไป local stack เฉพาะช่วงเทสนี้
    originalEnv = {
      NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    };
    process.env.NEXT_PUBLIC_SUPABASE_URL = local.url;
    process.env.SUPABASE_SERVICE_ROLE_KEY = local.serviceKey;
  });

  afterAll(async () => {
    if (createdJobIds.length > 0) {
      await service.from("print_jobs").delete().in("id", createdJobIds);
    }
    process.env.NEXT_PUBLIC_SUPABASE_URL = originalEnv.NEXT_PUBLIC_SUPABASE_URL;
    process.env.SUPABASE_SERVICE_ROLE_KEY = originalEnv.SUPABASE_SERVICE_ROLE_KEY;
  });

  it("เคลมงานแล้วเพิ่ม attempts, ออก claim token และตั้ง lease", async () => {
    const jobId = await insertJob();
    const claimed = await claimPendingPrintJobs(STORE_A, 5, { agentVersion: "1.1.0" });
    expect(claimed.error).toBeNull();

    const mine = (claimed.data ?? []).find((job) => job.id === jobId);
    expect(mine?.claimToken).toBeTruthy();
    expect(mine?.attempts).toBe(1);

    const row = await readJob(jobId);
    expect(row.status).toBe("claimed");
    expect(row.agent_version).toBe("1.1.0");
    expect(row.lease_expires_at).toBeTruthy();
  });

  it("เคลมพร้อมกันสองรอบ งานหนึ่งใบไปได้ที่รอบเดียว", async () => {
    const jobId = await insertJob();
    const [first, second] = await Promise.all([
      claimPendingPrintJobs(STORE_A, 5),
      claimPendingPrintJobs(STORE_A, 5),
    ]);
    const claimedBy = [first, second].filter((res) => (res.data ?? []).some((job) => job.id === jobId));
    expect(claimedBy).toHaveLength(1);
  });

  it("lease หมดโดยไม่มี ack → unknown (ไม่ย้อนเป็น pending และไม่พิมพ์ซ้ำเอง)", async () => {
    const jobId = await insertJob({
      status: "claimed",
      claimed_at: new Date(Date.now() - 10 * 60_000).toISOString(),
      lease_expires_at: new Date(Date.now() - 5 * 60_000).toISOString(),
      claim_token: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
    });

    const result = await reconcileStalePrintJobs(STORE_A);
    expect(result.error).toBeNull();
    expect(result.data!.reconciled).toBeGreaterThanOrEqual(1);

    const row = await readJob(jobId);
    expect(row.status).toBe("unknown");
    expect(row.error).toContain("ตรวจว่ากระดาษออกแล้ว");

    // งาน unknown ต้องไม่ถูกแจกให้ agent รอบถัดไป
    const claimed = await claimPendingPrintJobs(STORE_A, 20);
    expect((claimed.data ?? []).some((job) => job.id === jobId)).toBe(false);
  });

  it("ack ที่ claim token ไม่ตรง ไม่ทับผลปัจจุบัน", async () => {
    const jobId = await insertJob();
    const claimed = await claimPendingPrintJobs(STORE_A, 20);
    const mine = (claimed.data ?? []).find((job) => job.id === jobId);
    expect(mine?.claimToken).toBeTruthy();

    const stale = await ackPrintJob({
      jobId,
      storeId: STORE_A,
      outcome: "printed",
      claimToken: "00000000-0000-0000-0000-000000000000",
    });
    expect(stale.data?.applied).toBe(false);
    expect((await readJob(jobId)).status).toBe("claimed");

    const fresh = await ackPrintJob({
      jobId,
      storeId: STORE_A,
      outcome: "printed",
      claimToken: mine!.claimToken,
    });
    expect(fresh.data?.applied).toBe(true);
    expect((await readJob(jobId)).status).toBe("printed");
  });

  it("ack ซ้ำหลังงานปิดไปแล้วไม่เปลี่ยนสถานะ", async () => {
    const jobId = await insertJob({ status: "printed", printed_at: new Date().toISOString() });
    const result = await ackPrintJob({ jobId, storeId: STORE_A, outcome: "failed" });
    expect(result.data?.applied).toBe(false);
    expect((await readJob(jobId)).status).toBe("printed");
  });

  it("คนยืนยันว่ากระดาษออกแล้ว → ปิดงาน; สั่งพิมพ์ใหม่ → กลับเข้าคิวเป็น attempt ใหม่", async () => {
    const confirmedId = await insertJob({ status: "unknown", attempts: 1 });
    const confirmed = await resolveUnknownPrintJob({
      jobId: confirmedId,
      storeId: STORE_A,
      resolution: "printed_confirmed",
      userId: null,
    });
    expect(confirmed.error).toBeNull();
    const confirmedRow = await readJob(confirmedId);
    expect(confirmedRow.status).toBe("printed");
    expect(confirmedRow.resolution).toBe("printed_confirmed");

    const retryId = await insertJob({ status: "unknown", attempts: 1 });
    const retried = await resolveUnknownPrintJob({
      jobId: retryId,
      storeId: STORE_A,
      resolution: "retried",
      userId: null,
    });
    expect(retried.error).toBeNull();
    const retryRow = await readJob(retryId);
    expect(retryRow.status).toBe("pending");
    expect(retryRow.claim_token).toBeNull();

    const claimed = await claimPendingPrintJobs(STORE_A, 20);
    const again = (claimed.data ?? []).find((job) => job.id === retryId);
    expect(again?.attempts).toBe(2);
  });

  it("resolve งานที่ไม่ได้อยู่สถานะ unknown ต้องไม่ผ่าน", async () => {
    const jobId = await insertJob();
    const result = await resolveUnknownPrintJob({
      jobId,
      storeId: STORE_A,
      resolution: "printed_confirmed",
      userId: null,
    });
    expect(result.error).not.toBeNull();
    expect((await readJob(jobId)).status).toBe("pending");
  });

  it("สถานะ Hub รายงานจำนวนงานแยกตามสถานะและ reconcile ให้ก่อนนับ", async () => {
    const staleId = await insertJob({
      status: "claimed",
      claimed_at: new Date(Date.now() - 10 * 60_000).toISOString(),
      lease_expires_at: new Date(Date.now() - 5 * 60_000).toISOString(),
    });

    const status = await getHubStatus(STORE_A);
    expect(status.error).toBeNull();
    expect(status.data!.unknownJobs).toBeGreaterThanOrEqual(1);
    expect(status.data!.unknownJobList.some((job) => job.id === staleId)).toBe(true);
  });
});
