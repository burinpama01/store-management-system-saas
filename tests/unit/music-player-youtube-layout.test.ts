import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// หน้าเครื่องเล่นเพลงแบบ YouTube (2026-11-07): ช่องค้นหาด้านบน + รายการ "ถัดไป" มีรูปปก
describe("music player YouTube-style layout", () => {
  const app = readFileSync("src/app/player/[storeSlug]/PlayerApp.tsx", "utf8");
  const actions = readFileSync("src/app/player/[storeSlug]/actions.ts", "utf8");

  it("queue items carry the video id + duration for thumbnails", () => {
    expect(actions).toContain("videoId: q.youtubeVideoId,");
    expect(actions).toContain("durationSeconds: q.durationSeconds,");
  });

  it("builds thumbnails only from i.ytimg.com or a validated video id", () => {
    expect(app).toContain("ytimg");
    expect(app).toContain(".test(thumbnailUrl)");
    expect(app).toContain("VIDEO_ID_RE.test(videoId)");
    expect(app).toContain("https://i.ytimg.com/vi/${videoId}/mqdefault.jpg");
  });

  it("has the top search bar with the / shortcut and keeps auto-advance logic", () => {
    expect(app).toContain('aria-label="ค้นหาเพลง"');
    expect(app).toContain('e.key !== "/"');
    expect(app).toContain('id="yt-player"');
    expect(app).toContain("if (res.interrupt) void advanceRef.current({ interrupted: true });");
  });

  it("row action buttons don't also trigger the row's play", () => {
    expect(app).toContain("e.stopPropagation();");
  });

  it("play area and row actions are sibling buttons (no nested interactive roles)", () => {
    expect(app).not.toContain('role={onPlay ? "button"');
    expect(app).toContain("aria-label={`เล่น ${title}`}");
  });
});
