import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isUnpaidBump, toPublicMusicRequest } from "@/modules/music-requests/repository";
import type { Database } from "@/server/integrations/supabase/database.types";

// ลูกค้ากด "⏫ ขอเล่นก่อน" ที่เพลงในคิว (2026-11-08)
type Row = Database["public"]["Tables"]["music_requests"]["Row"];
const row = (o: Partial<Row> = {}): Row => ({
  id: "r1", store_id: "s1", organization_id: "o1", table_id: null, table_number: null, session_id: null,
  requester_label: null, song_title: "เพลง", bump_of_request_id: null, artist_name: null, note: null, status: "pending",
  requested_at: "2026-11-08T10:00:00Z", decided_at: null, decided_by: null, played_at: null,
  youtube_video_id: "dQw4w9WgXcQ", youtube_title: "เพลง", thumbnail_url: null, duration_seconds: 200,
  donation_amount: 0, donation_status: "none", donation_slip_url: null, donation_ref: null,
  donation_play_now: false, created_at: "2026-11-08T10:00:00Z", updated_at: "2026-11-08T10:00:00Z", ...o,
});

describe("queue bump", () => {
  it("unpaid bumps don't count as queue entries; paid ones do", () => {
    expect(isUnpaidBump(row({ bump_of_request_id: "r0", donation_status: "pending" }))).toBe(true);
    expect(isUnpaidBump(row({ bump_of_request_id: "r0", donation_status: "verified" }))).toBe(false);
    expect(isUnpaidBump(row())).toBe(false);
  });

  it("only waiting songs can be bumped (not played, not already play-now)", () => {
    expect(toPublicMusicRequest(row()).canBump).toBe(true);
    expect(toPublicMusicRequest(row({ status: "approved" })).canBump).toBe(true);
    expect(toPublicMusicRequest(row({ status: "played" })).canBump).toBe(false);
    expect(toPublicMusicRequest(row({ youtube_video_id: null })).canBump).toBe(false);
    expect(toPublicMusicRequest(row({ donation_status: "verified", donation_play_now: true })).canBump).toBe(false);
  });

  it("migration skips the original once the bump is paid, via any verify path", () => {
    const sql = readFileSync("supabase/migrations/20261108180000_music_queue_bump.sql", "utf8");
    expect(sql).toContain("after insert or update of donation_status on music_requests");
    expect(sql).toContain("when (new.bump_of_request_id is not null and new.donation_status = 'verified')");
    expect(sql).toContain("and status in ('pending', 'approved')");
    expect(sql).toContain("and store_id = new.store_id");
    // จ่ายซ้อนพร้อมกันไม่ได้: รอจ่ายได้ทีละรายการต่อเพลงเดิม
    expect(sql).toContain("create unique index if not exists music_requests_one_pending_bump_idx");
  });

  it("orphan request is closed if attaching the bump fails; stale pending bumps expire", () => {
    const repo = readFileSync("src/modules/music-requests/repository.ts", "utf8");
    expect(repo).toContain('.update({ status: "rejected", donation_status: "rejected", updated_at: new Date().toISOString() })');
    expect(repo).toContain('.update({ status: "expired", donation_status: "rejected", updated_at: new Date().toISOString() })');
    expect(repo).toContain(".filter((r) => !isUnpaidBump(r)).map(mapMusicRequest)");
  });

  it("server re-checks the original and uses its track, not the client's", () => {
    const actions = readFileSync("src/app/qr/[storeSlug]/[tableId]/music-actions.ts", "utf8");
    expect(actions).toContain("const original = await getBumpableRequest(storeId, bumpOfRequestId);");
    expect(actions).toContain("videoId: original.data.youtube_video_id as string,");
    expect(actions).toContain("if (original.busy)");
    const repo = readFileSync("src/modules/music-requests/repository.ts", "utf8");
    expect(repo).toContain(".filter((r) => r.youtube_video_id && !isUnpaidBump(r))");
  });

  it("customer UI: bump button only when donations are on; no free option in bump mode", () => {
    const tab = readFileSync("src/app/qr/[storeSlug]/[tableId]/MusicTab.tsx", "utf8");
    expect(tab).toContain("q.canBump && donationEnabled && eligibility.canSubmitRequest");
    expect(tab).toContain("{!bumpTarget && (");
    expect(tab).toContain("bumpTarget?.id ?? null,");
  });
});
