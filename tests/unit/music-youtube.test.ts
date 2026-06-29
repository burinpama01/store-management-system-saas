import { describe, it, expect } from "vitest";
import { parseIso8601Duration, mapPlayableYouTubeVideos } from "@/modules/music-requests/youtube";

describe("parseIso8601Duration", () => {
  it("parses minutes and seconds", () => {
    expect(parseIso8601Duration("PT3M20S")).toBe(200);
  });
  it("parses hours/minutes/seconds", () => {
    expect(parseIso8601Duration("PT1H2M3S")).toBe(3723);
  });
  it("parses seconds only", () => {
    expect(parseIso8601Duration("PT45S")).toBe(45);
  });
  it("returns null for empty/invalid", () => {
    expect(parseIso8601Duration("PT")).toBeNull();
    expect(parseIso8601Duration("garbage")).toBeNull();
  });
});

describe("mapPlayableYouTubeVideos", () => {
  const items = [
    {
      id: "ok11111111",
      snippet: { title: "เพลงสั้น", channelTitle: "ช่อง", thumbnails: { medium: { url: "thumb" } } },
      contentDetails: { duration: "PT3M" },
      status: { embeddable: true },
    },
    {
      id: "long222222",
      snippet: { title: "เพลงยาว" },
      contentDetails: { duration: "PT20M" },
      status: { embeddable: true },
    },
    {
      id: "noembed333",
      snippet: { title: "ฝังไม่ได้" },
      contentDetails: { duration: "PT2M" },
      status: { embeddable: false },
    },
  ];

  it("keeps embeddable videos within the duration cap", () => {
    const out = mapPlayableYouTubeVideos(items, 600);
    expect(out.map((v) => v.videoId)).toEqual(["ok11111111"]);
    expect(out[0]).toMatchObject({ title: "เพลงสั้น", durationSeconds: 180, thumbnailUrl: "thumb" });
  });

  it("falls back to id when title missing and handles empty input", () => {
    const out = mapPlayableYouTubeVideos([{ id: "x1234567890", status: { embeddable: true } }], 600);
    expect(out[0].title).toBe("x1234567890");
    expect(mapPlayableYouTubeVideos([], 600)).toEqual([]);
  });
});
