import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { expectedPosition } from "@/app/qr/[storeSlug]/[tableId]/CustomerScreen";
import { parsePlaybackBroadcast, toCustomerNowPlayingVideo } from "@/modules/music-requests/customer-screen";

// จอลูกค้า (คาราโอเกะ) 2026-11-07: วิดีโอเดียวกับจอร้าน เล่นตรงตำแหน่งเดียวกันบนมือถือลูกค้า
describe("expectedPosition", () => {
  it("adds time elapsed on this device since the server answered", () => {
    expect(expectedPosition({ elapsedSeconds: 30, durationSeconds: 200 }, 1000, 6000)).toBe(35);
  });

  it("never goes past the end of the song", () => {
    expect(expectedPosition({ elapsedSeconds: 198, durationSeconds: 200 }, 0, 10_000)).toBe(199);
  });

  it("doesn't advance while the store has paused", () => {
    expect(expectedPosition({ elapsedSeconds: 42, durationSeconds: 200, paused: true }, 0, 60_000)).toBe(42);
  });

  it("ignores a clock that went backwards and unknown duration", () => {
    expect(expectedPosition({ elapsedSeconds: 12, durationSeconds: null }, 5000, 1000)).toBe(12);
    expect(expectedPosition({ elapsedSeconds: 12, durationSeconds: null }, 0, 600_000)).toBe(612);
  });
});

describe("toCustomerNowPlayingVideo (ตามตอนร้านกดหยุด/เลื่อนเพลง)", () => {
  const base = { videoId: "dQw4w9WgXcQ", title: "t", durationSeconds: 200, startedAt: "2026-11-08T10:00:00.000Z" };
  const at = (s: string) => Date.parse(s);

  it("no report yet → counts from the song start", () => {
    const v = toCustomerNowPlayingVideo(base, at("2026-11-08T10:01:00.000Z"));
    expect(v).toMatchObject({ elapsedSeconds: 60, paused: false });
  });

  it("store seeked → reported position + time since report", () => {
    const v = toCustomerNowPlayingVideo(
      { ...base, state: "playing", positionSeconds: 150, positionAt: "2026-11-08T10:01:00.000Z" },
      at("2026-11-08T10:01:05.000Z"),
    );
    expect(v).toMatchObject({ elapsedSeconds: 155, paused: false });
  });

  it("store paused → frozen at reported position", () => {
    const v = toCustomerNowPlayingVideo(
      { ...base, state: "paused", positionSeconds: 33.3, positionAt: "2026-11-08T10:01:00.000Z" },
      at("2026-11-08T10:09:00.000Z"),
    );
    expect(v).toMatchObject({ elapsedSeconds: 33.3, paused: true });
  });

  it("rejects bad video ids / empty payloads", () => {
    expect(toCustomerNowPlayingVideo({ ...base, videoId: "javascript:1" }, 0)).toBeNull();
    expect(toCustomerNowPlayingVideo(null, 0)).toBeNull();
    expect(parsePlaybackBroadcast(null)).toBeNull();
    expect(parsePlaybackBroadcast({ videoId: 5, positionSeconds: "12.5" })).toMatchObject({ videoId: null, positionSeconds: 12.5 });
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
    expect(actions).toMatch(/nowPlayingVideo: customerScreenEnabled\s+\? toCustomerNowPlayingVideo\(/);
    expect(actions.indexOf("if (!eligibility.canViewQueue)")).toBeLessThan(actions.indexOf("nowPlayingVideo: customerScreenEnabled"));
    expect(actions).toContain("serverNowMs: customerScreenEnabled ? serverNow : undefined");
  });

  it("starts muted + inline and reloads the queue when the clip ends", () => {
    expect(screen).toContain("mute: 1");
    expect(screen).toContain("playsinline: 1");
    expect(tab).toContain("onEnded={() => void load()}");
    expect(tab).toContain("{screenEnabled && (");
  });

  it("store player reports pause/play/seek only for stores with the screen on", () => {
    const player = readFileSync("src/app/player/[storeSlug]/PlayerApp.tsx", "utf8");
    const playerActions = readFileSync("src/app/player/[storeSlug]/actions.ts", "utf8");
    expect(player).toContain("if (!customerScreenRef.current) return;");
    expect(player).toContain("window.YT.PlayerState.PAUSED");
    expect(playerActions).toContain("if (!settingsRes.data?.customerScreenEnabled) return { error: null };");
    expect(playerActions).toContain('await requirePermission("orders.manage_qr");');
  });

  it("phone listens to the private broadcast topic only while the screen is open", () => {
    expect(screen).toContain("`music-playback:${storeId}`, { config: { private: true } }");
    expect(screen).toContain("if (!open) return;");
    expect(screen).toContain("supabase.removeChannel(channel)");
    // ไม่เรียก playVideo ซ้ำตอนกำลังเล่นอยู่แล้ว (iOS กระตุก)
    expect(screen).toContain("state !== YTns.PlayerState.PLAYING && state !== YTns.PlayerState.BUFFERING");
  });

  it("migration: broadcast gated by store switches, anon may only receive", () => {
    const sync = readFileSync("supabase/migrations/20261108120000_music_playback_sync.sql", "utf8");
    expect(sync).toContain("coalesce(sps.customer_screen_enabled, false)");
    expect(sync).toContain("s.music_request_enabled");
    expect(sync).toContain("on realtime.messages for select");
    expect(sync).not.toMatch(/on realtime\.messages for (insert|all)/);
    expect(sync).toContain("exception when others then");
  });

  it("recovers when the YouTube script can't load (no endless black box)", () => {
    expect(screen).toContain("tag.onerror");
    expect(screen).toContain("ytApiPromise = null;");
    expect(screen).toContain("if (!cancelled) setApiError(true);");
  });
});

describe("customer screen: no replay loop after the clip ends (browser hang 2026-11-08)", () => {
  it("holds on the same clip once it ended, resumes on a new clip", async () => {
    const { shouldHoldAfterEnd, ENDED_RELOAD_MIN_INTERVAL_MS } = await import("@/app/qr/[storeSlug]/[tableId]/CustomerScreen");
    expect(shouldHoldAfterEnd("dQw4w9WgXcQ", "dQw4w9WgXcQ")).toBe(true);
    expect(shouldHoldAfterEnd("dQw4w9WgXcQ", "kJQP7kiw5Fk")).toBe(false);
    expect(shouldHoldAfterEnd(null, "dQw4w9WgXcQ")).toBe(false);
    expect(ENDED_RELOAD_MIN_INTERVAL_MS).toBeGreaterThanOrEqual(10_000);
  });

  it("sync effect checks the hold before seeking/playing; ENDED reload is throttled", () => {
    const src = readFileSync("src/app/qr/[storeSlug]/[tableId]/CustomerScreen.tsx", "utf8");
    expect(src.indexOf("if (shouldHoldAfterEnd(endedIdRef.current, video.videoId)) return;")).toBeLessThan(
      src.indexOf("p.seekTo(target, true);\n    }\n    // เล่นต่อเฉพาะ"),
    );
    expect(src).toContain("if (now - lastEndedReloadRef.current < ENDED_RELOAD_MIN_INTERVAL_MS) return;");
    expect(src).toContain("endedIdRef.current = null;\n      setFailed(false);");
  });
});
