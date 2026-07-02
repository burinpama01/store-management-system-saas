import { describe, it, expect } from "vitest";
import { parseYouTubeVideoId, parseBasePlaylist } from "@/modules/music-requests/youtube";
import { mapMusicPlayerSettings } from "@/modules/music-requests/repository";
import type { Database } from "@/server/integrations/supabase/database.types";

type SettingsRow = Database["public"]["Tables"]["store_music_player_settings"]["Row"];

describe("parseYouTubeVideoId", () => {
  it("extracts the id from a watch URL", () => {
    expect(parseYouTubeVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });
  it("extracts the id from a youtu.be short URL with params", () => {
    expect(parseYouTubeVideoId("https://youtu.be/dQw4w9WgXcQ?t=42")).toBe("dQw4w9WgXcQ");
  });
  it("extracts the id from a watch URL with extra params", () => {
    expect(parseYouTubeVideoId("https://youtube.com/watch?v=dQw4w9WgXcQ&list=abc")).toBe("dQw4w9WgXcQ");
  });
  it("accepts a bare 11-char id", () => {
    expect(parseYouTubeVideoId("dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });
  it("returns null for non-YouTube / malformed input", () => {
    expect(parseYouTubeVideoId("https://example.com/x")).toBeNull();
    expect(parseYouTubeVideoId("not an id")).toBeNull();
    expect(parseYouTubeVideoId("")).toBeNull();
  });
});

describe("parseBasePlaylist", () => {
  it("parses, dedupes, and skips invalid lines", () => {
    const out = parseBasePlaylist(
      [
        "https://youtu.be/dQw4w9WgXcQ",
        "  ",
        "not a url",
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ", // duplicate id
        "abcdefghijk",
      ].join("\n"),
    );
    expect(out.map((t) => t.videoId)).toEqual(["dQw4w9WgXcQ", "abcdefghijk"]);
  });

  it("caps at 100 entries", () => {
    const lines = Array.from({ length: 130 }, (_, i) =>
      `https://youtu.be/${String(i).padStart(11, "0")}`,
    );
    expect(parseBasePlaylist(lines.join("\n"))).toHaveLength(100);
  });
});

function row(overrides: Partial<SettingsRow> = {}): SettingsRow {
  return {
    store_id: "s1",
    organization_id: "o1",
    player_enabled: false,
    auto_approve: true,
    donation_enabled: false,
    min_donation: 10,
    play_now_price: 100,
    max_duration_seconds: 600,
    base_playlist: [],
    licensing_acknowledged_at: null,
    updated_at: "2026-06-29T00:00:00Z",
    ...overrides,
  };
}

describe("mapMusicPlayerSettings", () => {
  it("maps defaults", () => {
    const s = mapMusicPlayerSettings(row());
    expect(s.playerEnabled).toBe(false);
    expect(s.autoApprove).toBe(true);
    expect(s.minDonation).toBe(10);
    expect(s.playNowPrice).toBe(100);
    expect(s.basePlaylist).toEqual([]);
    expect(s.licensingAcknowledgedAt).toBeUndefined();
  });

  it("maps a populated base playlist", () => {
    const s = mapMusicPlayerSettings(
      row({
        player_enabled: true,
        donation_enabled: true,
        base_playlist: [
          { videoId: "dQw4w9WgXcQ", title: "เพลง 1", thumbnailUrl: "t1", durationSeconds: 200 },
        ],
        licensing_acknowledged_at: "2026-06-29T01:00:00Z",
      }),
    );
    expect(s.playerEnabled).toBe(true);
    expect(s.donationEnabled).toBe(true);
    expect(s.basePlaylist).toHaveLength(1);
    expect(s.basePlaylist[0].videoId).toBe("dQw4w9WgXcQ");
    expect(s.licensingAcknowledgedAt).toBe("2026-06-29T01:00:00Z");
  });
});
