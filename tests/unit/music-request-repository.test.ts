import { describe, it, expect } from "vitest";
import { validateMusicRequestInput } from "@/modules/music-requests/types";
import { toPublicMusicRequest } from "@/modules/music-requests/repository";
import type { Database } from "@/server/integrations/supabase/database.types";

type MusicRequestRow = Database["public"]["Tables"]["music_requests"]["Row"];

function row(overrides: Partial<MusicRequestRow> = {}): MusicRequestRow {
  return {
    id: "req-1",
    store_id: "store-1",
    organization_id: "org-1",
    table_id: "table-1",
    table_number: "5",
    session_id: "session-1",
    requester_label: "โต๊ะ 5",
    song_title: "เพลงรัก",
    artist_name: "ศิลปิน",
    note: "ขอด่วนนนน",
    status: "pending",
    requested_at: "2026-06-29T10:00:00Z",
    decided_at: null,
    decided_by: "staff-1",
    played_at: null,
    youtube_video_id: null,
    youtube_title: null,
    thumbnail_url: null,
    duration_seconds: null,
    donation_amount: 0,
    donation_status: "none",
    donation_slip_url: null,
    donation_ref: null,
    donation_play_now: false,
    created_at: "2026-06-29T10:00:00Z",
    updated_at: "2026-06-29T10:00:00Z",
    ...overrides,
  };
}

describe("validateMusicRequestInput", () => {
  it("rejects an empty song title", () => {
    const r = validateMusicRequestInput({ songTitle: "   " });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("song_required");
  });

  it("rejects an over-long song title", () => {
    const r = validateMusicRequestInput({ songTitle: "x".repeat(121) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("song_too_long");
  });

  it("rejects over-long artist / requester / note", () => {
    expect(validateMusicRequestInput({ songTitle: "ok", artistName: "a".repeat(121) })).toMatchObject({
      ok: false,
      error: "artist_too_long",
    });
    expect(validateMusicRequestInput({ songTitle: "ok", requesterLabel: "r".repeat(61) })).toMatchObject({
      ok: false,
      error: "requester_too_long",
    });
    expect(validateMusicRequestInput({ songTitle: "ok", note: "n".repeat(241) })).toMatchObject({
      ok: false,
      error: "note_too_long",
    });
  });

  it("trims and drops empty optional fields", () => {
    const r = validateMusicRequestInput({
      songTitle: "  เพลงรัก  ",
      artistName: "  ",
      requesterLabel: "  โต๊ะ 5 ",
      note: "",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.songTitle).toBe("เพลงรัก");
      expect(r.value.artistName).toBeUndefined();
      expect(r.value.requesterLabel).toBe("โต๊ะ 5");
      expect(r.value.note).toBeUndefined();
    }
  });
});

describe("toPublicMusicRequest — no internal leakage", () => {
  it("exposes only public-safe fields", () => {
    const pub = toPublicMusicRequest(row());
    expect(pub).toEqual({
      id: "req-1",
      songTitle: "เพลงรัก",
      artistName: "ศิลปิน",
      requesterLabel: "โต๊ะ 5",
      status: "pending",
      requestedAt: "2026-06-29T10:00:00Z",
    });
    // Internal fields must never appear in the public view.
    expect(pub).not.toHaveProperty("note");
    expect(pub).not.toHaveProperty("decidedBy");
    expect(pub).not.toHaveProperty("sessionId");
    expect(pub).not.toHaveProperty("storeId");
    expect(pub).not.toHaveProperty("tableId");
  });
});
