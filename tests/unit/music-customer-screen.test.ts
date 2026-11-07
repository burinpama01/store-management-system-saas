import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { expectedPosition } from "@/app/qr/[storeSlug]/[tableId]/CustomerScreen";

// จอลูกค้า (คาราโอเกะ) 2026-11-07: วิดีโอเดียวกับจอร้าน เล่นตรงตำแหน่งเดียวกันบนมือถือลูกค้า
describe("expectedPosition", () => {
  it("adds time elapsed on this device since the server answered", () => {
    expect(expectedPosition({ elapsedSeconds: 30, durationSeconds: 200 }, 1000, 6000)).toBe(35);
  });

  it("never goes past the end of the song", () => {
    expect(expectedPosition({ elapsedSeconds: 198, durationSeconds: 200 }, 0, 10_000)).toBe(199);
  });

  it("ignores a clock that went backwards and unknown duration", () => {
    expect(expectedPosition({ elapsedSeconds: 12, durationSeconds: null }, 5000, 1000)).toBe(12);
    expect(expectedPosition({ elapsedSeconds: 12, durationSeconds: null }, 0, 600_000)).toBe(612);
  });
});

describe("customer screen wiring", () => {
  const actions = readFileSync("src/app/qr/[storeSlug]/[tableId]/music-actions.ts", "utf8");
  const tab = readFileSync("src/app/qr/[storeSlug]/[tableId]/MusicTab.tsx", "utf8");
  const screen = readFileSync("src/app/qr/[storeSlug]/[tableId]/CustomerScreen.tsx", "utf8");
  const migration = readFileSync("supabase/migrations/20261108000000_music_customer_screen.sql", "utf8");
  const form = readFileSync("src/app/(dashboard)/settings/music-player/MusicPlayerSettingsForm.tsx", "utf8");
  const settingsAction = readFileSync("src/app/(dashboard)/settings/music-player/actions.ts", "utf8");

  it("store switch defaults off", () => {
    expect(migration).toContain("customer_screen_enabled boolean not null default false");
    expect(form).toContain('name="customerScreenEnabled"');
    expect(settingsAction).toContain('formData.get("customerScreenEnabled") === "1"');
    expect(settingsAction).toContain('source: "music.player"');
  });

  it("video is sent only when the store enabled it, after the existing music gate", () => {
    expect(actions).toContain("nowPlayingVideo: customerScreenEnabled ? toCustomerNowPlayingVideo(np.data, nowMs()) : null");
    expect(actions.indexOf("if (!eligibility.canViewQueue)")).toBeLessThan(actions.indexOf("nowPlayingVideo: customerScreenEnabled"));
    expect(actions).toContain("!YT_ID_RE.test(np.youtubeVideoId)");
  });

  it("starts muted + inline and reloads the queue when the clip ends", () => {
    expect(screen).toContain("mute: 1");
    expect(screen).toContain("playsinline: 1");
    expect(tab).toContain("onEnded={() => void load()}");
    expect(tab).toContain("{screenEnabled && (");
  });

  it("recovers when the YouTube script can't load (no endless black box)", () => {
    expect(screen).toContain("tag.onerror");
    expect(screen).toContain("ytApiPromise = null;");
    expect(screen).toContain("if (!cancelled) setApiError(true);");
  });
});
